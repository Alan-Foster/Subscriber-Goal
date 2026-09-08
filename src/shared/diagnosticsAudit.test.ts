import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const productionRoots = ["src/client", "src/server", "src/shared"];
const diagnosticLoggerPattern = /\blogDiagnostic\s*\(/;
const crosspostLoggerPattern = /\blogCrosspostEvent\s*\(/;
const expectedControlFlowAnnotation = "diagnostic-allow-silent:";

const getProductionFiles = (): string[] =>
  productionRoots
    .flatMap((root) =>
      ts.sys.readDirectory(join(globalThis.process.cwd(), root), [".ts", ".tsx"]),
    )
    .filter((file) => !file.includes(".test.") && !file.endsWith(".d.ts"));

const caughtName = (clause: ts.CatchClause): string | null =>
  clause.variableDeclaration && ts.isIdentifier(clause.variableDeclaration.name)
    ? clause.variableDeclaration.name.text
    : null;

const hasCatchLocalAnnotation = (
  source: ts.SourceFile,
  clause: ts.CatchClause,
): boolean => {
  const firstStatement = clause.block.statements[0];
  const prefixEnd = firstStatement?.getStart(source) ?? clause.block.end;
  return source.text
    .slice(clause.block.getStart(source), prefixEnd)
    .includes(expectedControlFlowAnnotation);
};

const expressionCall = (expression: ts.Expression): ts.CallExpression | null => {
  const candidate = ts.isAwaitExpression(expression)
    ? expression.expression
    : expression;
  return ts.isCallExpression(candidate) ? candidate : null;
};

const callReportsError = (
  call: ts.CallExpression,
  source: ts.SourceFile,
  errorName: string | null,
): boolean => {
  const text = call.getText(source);
  return (
    crosspostLoggerPattern.test(text) ||
    (diagnosticLoggerPattern.test(text) &&
      (errorName === null || new RegExp(`\\b${errorName}\\b`).test(text)))
  );
};

const blockReportsError = (
  block: ts.Block,
  source: ts.SourceFile,
  errorName: string | null,
): boolean => {
  let reports = false;
  const visit = (node: ts.Node): void => {
    if (reports || (node !== block && ts.isFunctionLike(node))) return;
    if (
      errorName !== null &&
      ts.isThrowStatement(node) &&
      node.expression &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === errorName
    ) {
      reports = true;
      return;
    }
    if (ts.isCallExpression(node) && callReportsError(node, source, errorName)) {
      reports = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(block);
  return reports;
};

const auditSource = (file: string, sourceText: string): string[] => {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const offenders: string[] = [];
  const report = (node: ts.Node, suffix = "") => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    offenders.push(`${file}:${line}${suffix}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) {
      const name = caughtName(node);
      if (
        !hasCatchLocalAnnotation(source, node) &&
        !blockReportsError(node.block, source, name)
      ) {
        report(node);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch" &&
      node.arguments.length > 0
    ) {
      const handler = node.arguments[0]!;
      const parameter =
        (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
        handler.parameters[0] &&
        ts.isIdentifier(handler.parameters[0].name)
          ? handler.parameters[0].name.text
          : null;
      const annotation = handler.getFullText(source).includes(expectedControlFlowAnnotation);
      const reports =
        (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
        (ts.isBlock(handler.body)
          ? blockReportsError(handler.body, source, parameter)
          : (() => {
              const call = expressionCall(handler.body);
              return call !== null && callReportsError(call, source, parameter);
            })());
      if (!annotation && !reports) {
        report(node, " (.catch)");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offenders;
};

describe("production error diagnostics", () => {
  it("does not contain unreported catch handlers", () => {
    const offenders = getProductionFiles().flatMap((file) =>
      auditSource(
        relative(globalThis.process.cwd(), file),
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders, "Unreported catch handlers").toEqual([]);
  });

  it("rejects misleading catch-handler patterns", () => {
    expect(auditSource("fixture.ts", "try { run() } catch (error) { console.error(error) }")).not.toEqual([]);
    expect(auditSource("fixture.ts", "try { run() } catch (error) { emit(error) }")).not.toEqual([]);
    expect(auditSource("fixture.ts", "try { run() } catch (error) { (() => { throw error })() }")).not.toEqual([]);
    expect(auditSource("fixture.ts", "// diagnostic-allow-silent: elsewhere\ntry { run() } catch { return }")).not.toEqual([]);
    expect(auditSource("fixture.ts", "try { run() } catch (error) { logDiagnostic('error', 'failed', {}, error) }")).toEqual([]);
    expect(auditSource("fixture.ts", "try { run() } catch {\n// diagnostic-allow-silent: expected parser probe.\nreturn\n}")).toEqual([]);
  });

  it("does not discard promise rejections", () => {
    const offenders: string[] = [];
    for (const file of getProductionFiles()) {
      const sourceText = readFileSync(file, "utf8");
      if (/\.catch\s*\(\s*\(?.*?\)?\s*=>\s*(?:undefined|\{\s*\})\s*\)/s.test(sourceText)) {
        offenders.push(relative(globalThis.process.cwd(), file));
      }
    }
    expect(offenders, "Discarded promise rejections").toEqual([]);
  });

  it("routes operational warning and error logs through approved loggers", () => {
    const compatibilityLoggers = new Set([
      "src/shared/diagnostics.ts",
      "src/server/utils/crosspostLogs.ts",
    ]);
    const offenders = getProductionFiles()
      .map((file) => ({
        file,
        relativeFile: relative(globalThis.process.cwd(), file).replaceAll("\\", "/"),
      }))
      .filter(({ relativeFile }) => !compatibilityLoggers.has(relativeFile))
      .filter(({ file }) => /console\.(?:error|warn)\s*\(/.test(readFileSync(file, "utf8")))
      .map(({ relativeFile }) => relativeFile);
    expect(offenders, "Direct operational console calls").toEqual([]);
  });
});
