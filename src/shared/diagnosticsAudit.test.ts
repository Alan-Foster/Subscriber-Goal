import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const productionRoots = ["src/client", "src/server", "src/shared"];
const diagnosticPattern =
  /console\.(?:error|warn|info|log)|logDiagnostic\s*\(|logCrosspostEvent\s*\(|emit\s*\(|process\.(?:stdout|stderr)\.write|\bthrow\b|diagnostic-allow-silent/;

const getProductionFiles = (): string[] => {
  const sysFiles = productionRoots.flatMap((root) =>
    ts.sys.readDirectory(join(globalThis.process.cwd(), root), [".ts", ".tsx"]),
  );
  return sysFiles.filter(
    (file) => !file.includes(".test.") && !file.endsWith(".d.ts"),
  );
};

describe("production error diagnostics", () => {
  it("does not contain unreported catch handlers", () => {
    const silentHandlers: string[] = [];
    for (const file of getProductionFiles()) {
      const sourceText = readFileSync(file, "utf8");
      const source = ts.createSourceFile(
        file,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isCatchClause(node)) {
          const text = node.block.getFullText(source);
          if (!diagnosticPattern.test(text)) {
            const line =
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1;
            silentHandlers.push(
              `${relative(globalThis.process.cwd(), file)}:${line}`,
            );
          }
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "catch" &&
          node.arguments.length > 0
        ) {
          const handlerText = node.arguments[0]!.getFullText(source);
          if (!diagnosticPattern.test(handlerText)) {
            const line =
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1;
            silentHandlers.push(
              `${relative(globalThis.process.cwd(), file)}:${line} (.catch)`,
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(silentHandlers, "Silent catch handlers").toEqual([]);
  });

  it("does not discard promise rejections with an undefined callback", () => {
    const offenders: string[] = [];
    for (const file of getProductionFiles()) {
      const sourceText = readFileSync(file, "utf8");
      if (/\.catch\s*\(\s*\(?.*?\)?\s*=>\s*undefined\s*\)/s.test(sourceText)) {
        offenders.push(relative(globalThis.process.cwd(), file));
      }
    }
    expect(offenders, "Discarded promise rejections").toEqual([]);
  });
});
