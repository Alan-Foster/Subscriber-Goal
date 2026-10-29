import { readFile, readdir, writeFile } from "node:fs/promises";
import { IntlMessageFormat } from "intl-messageformat";
import ts from "typescript";

const catalogUrl = new URL("../src/shared/i18n/messages.json", import.meta.url);
const catalog = JSON.parse(await readFile(catalogUrl, "utf8"));
const placeholderPattern = /\{([A-Za-z][A-Za-z0-9_]*)(?:\s*,|\})/gu;
const placeholders = (message) =>
  [
    ...new Set(
      [...message.matchAll(placeholderPattern)].map((match) => match[1]),
    ),
  ].sort();
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const errors = [];
const warnings = [];

if (catalog.schemaVersion !== 1) errors.push("schemaVersion must be 1");
if (!catalog.locales[catalog.defaultLanguage]) {
  errors.push("defaultLanguage must reference a locale");
}
if (
  !Array.isArray(catalog.languageOrder) ||
  !same([...catalog.languageOrder].sort(), Object.keys(catalog.locales).sort())
) {
  errors.push("languageOrder must contain every locale exactly once");
}
const keys = Object.keys(catalog.definitions);
const english = catalog.locales[catalog.defaultLanguage]?.messages ?? {};
const devvit = JSON.parse(
  await readFile(new URL("../devvit.json", import.meta.url), "utf8"),
);
const appHtml = await readFile(
  new URL("../src/client/app.html", import.meta.url),
  "utf8",
);
const joinHtml = await readFile(
  new URL("../src/client/subscribe-only.html", import.meta.url),
  "utf8",
);

for (const key of keys) {
  const definition = catalog.definitions[key];
  if (!definition.description?.trim())
    errors.push(`${key}: description is required`);
  if (!["required", "fallback"].includes(definition.policy)) {
    errors.push(`${key}: invalid translation policy`);
  }
  if (!english[key]?.trim())
    errors.push(`${key}: English translation is required`);
  if (
    !definition.placeholders ||
    typeof definition.placeholders !== "object" ||
    Array.isArray(definition.placeholders)
  ) {
    errors.push(`${key}: placeholders contract is required`);
  } else {
    for (const [name, description] of Object.entries(definition.placeholders)) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(name) || !description?.trim()) {
        errors.push(`${key}: placeholder ${name} requires a description`);
      }
    }
    if (
      !same(
        Object.keys(definition.placeholders).sort(),
        placeholders(english[key] ?? ""),
      )
    ) {
      errors.push(`${key}: English placeholders differ from its contract`);
    }
  }
  if (
    !Array.isArray(definition.protectedTokens) ||
    definition.protectedTokens.some(
      (token) => typeof token !== "string" || token.length === 0,
    )
  ) {
    errors.push(`${key}: protectedTokens must be an array of strings`);
  }
}

for (const [language, locale] of Object.entries(catalog.locales)) {
  if (!locale.label?.trim() || !locale.locale?.trim()) {
    errors.push(`${language}: label and BCP 47 locale are required`);
  }
  try {
    new Intl.NumberFormat(locale.locale).format(1);
  } catch {
    errors.push(`${language}: invalid BCP 47 locale ${locale.locale}`);
  }
  for (const key of keys) {
    const message = locale.messages[key];
    if (!message) {
      if (catalog.definitions[key].policy === "required") {
        errors.push(`${language}.${key}: required translation is missing`);
      } else if (language !== catalog.defaultLanguage) {
        warnings.push(`${language}.${key}`);
      }
      continue;
    }
    try {
      new IntlMessageFormat(message, locale.locale);
    } catch (error) {
      errors.push(`${language}.${key}: invalid ICU message (${String(error)})`);
    }
    if (
      !same(
        placeholders(message),
        Object.keys(catalog.definitions[key].placeholders).sort(),
      )
    ) {
      errors.push(`${language}.${key}: placeholders differ from contract`);
    }
    for (const token of catalog.definitions[key].protectedTokens) {
      if (!message.includes(token)) {
        errors.push(`${language}.${key}: protected token ${token} is missing`);
      }
    }
  }
  for (const key of Object.keys(locale.messages)) {
    if (!catalog.definitions[key])
      errors.push(`${language}.${key}: unknown key`);
  }
}

const menuKeys = [
  ["menu.createGoal.label", "menu.createGoal.description"],
  ["menu.createCta.label", "menu.createCta.description"],
  ["menu.deleteGoal.label", "menu.deleteGoal.description"],
  ["menu.eraseData.label", "menu.eraseData.description"],
  ["menu.eraseOwnData.label", "menu.eraseOwnData.description"],
];
for (const [index, [labelKey, descriptionKey]] of menuKeys.entries()) {
  const item = devvit.menu?.items?.[index];
  if (item?.label !== english[labelKey]) {
    errors.push(
      `devvit.json menu item ${index} label differs from ${labelKey}`,
    );
  }
  if (item?.description !== english[descriptionKey]) {
    errors.push(
      `devvit.json menu item ${index} description differs from ${descriptionKey}`,
    );
  }
}

if (
  !appHtml.includes(
    `<title>${english["accessibility.document.appTitle"]}</title>`,
  )
) {
  errors.push(
    "src/client/app.html title differs from accessibility.document.appTitle",
  );
}
if (
  !joinHtml.includes(
    `<title>${english["accessibility.document.joinTitle"]}</title>`,
  )
) {
  errors.push(
    "src/client/subscribe-only.html title differs from accessibility.document.joinTitle",
  );
}

const sourceRoot = new URL("../src/", import.meta.url);
const sourceFiles = [];
async function collectSourceFiles(directoryUrl, prefix = "src") {
  for (const entry of await readdir(directoryUrl, { withFileTypes: true })) {
    const relativePath = `${prefix}/${entry.name}`;
    const child = new URL(
      `${entry.name}${entry.isDirectory() ? "/" : ""}`,
      directoryUrl,
    );
    if (entry.isDirectory()) {
      await collectSourceFiles(child, relativePath);
    } else if (
      /\.tsx?$/u.test(entry.name) &&
      !/\.(?:test|spec)\.tsx?$/u.test(entry.name) &&
      !relativePath.endsWith("/i18n/catalog.ts")
    ) {
      sourceFiles.push([relativePath, child]);
    }
  }
}
await collectSourceFiles(sourceRoot);

const directVisibleProperties = new Set([
  "showToast",
  "helpText",
  "acceptLabel",
  "cancelLabel",
  "bodyMarkdown",
  "ariaLabel",
]);
const contextualVisibleProperties = new Set([
  "title",
  "description",
  "label",
  "subject",
  "message",
  "text",
  "body",
  "placeholder",
]);
const visibleContextFiles =
  /(?:routes\/internalUi|routes\/publicApi|requestErrorBoundary|onboardingReminder|appAccountHealth|highlightFailureNotifications|milestoneNotifications|inviteNewSubs|components\/|pages\/|App\.tsx|SubscribeOnlyApp\.tsx)$/u;

function literalText(node) {
  if (ts.isJsxText(node)) {
    return node.getText().trim();
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.trim();
  }
  return "";
}

function hasLiteralAllowance(source, node) {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const lines = source.getFullText().split(/\r?\n/u);
  return [lines[start.line], lines[start.line - 1]]
    .filter(Boolean)
    .some((line) => line.includes("i18n-allow-literal"));
}

function auditVisibleSource(relativePath, sourceText) {
  const findings = [];
  const source = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const report = (node) => {
    const text = literalText(node);
    if (
      !text ||
      !/[\p{L}\p{N}]/u.test(text) ||
      hasLiteralAllowance(source, node)
    ) {
      return;
    }
    const { line } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    findings.push(
      `${relativePath}:${line + 1}: raw visible text must use translate()`,
    );
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const hasDynamicSibling = node.parent.children?.some(
        (child) => ts.isJsxExpression(child) && child.expression,
      );
      if (!hasDynamicSibling) report(node);
    } else if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (ts.isStringLiteral(node.expression) ||
        ts.isNoSubstitutionTemplateLiteral(node.expression))
    ) {
      report(node.expression);
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(source);
      if (["aria-label", "title", "placeholder"].includes(name)) {
        if (ts.isStringLiteral(node.initializer)) report(node.initializer);
        if (
          ts.isJsxExpression(node.initializer) &&
          node.initializer.expression &&
          (ts.isStringLiteral(node.initializer.expression) ||
            ts.isNoSubstitutionTemplateLiteral(node.initializer.expression))
        ) {
          report(node.initializer.expression);
        }
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(source).replaceAll(/["']/gu, "");
      if (
        directVisibleProperties.has(name) ||
        (contextualVisibleProperties.has(name) &&
          visibleContextFiles.test(relativePath.replace(/\.tsx?$/u, "")))
      ) {
        report(node.initializer);
      }
    } else if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source);
      if (
        /(?:showToast|setError|showNotice)$/u.test(name) &&
        node.arguments[0]
      ) {
        report(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

for (const [relativePath, fileUrl] of sourceFiles) {
  errors.push(
    ...auditVisibleSource(relativePath, await readFile(fileUrl, "utf8")),
  );
}
if (
  auditVisibleSource("fixture.tsx", "const x = <div>Untranslated text</div>;")
    .length !== 1
) {
  errors.push("TypeScript source audit self-test failed");
}

if (process.argv.includes("--export")) {
  const languages = Object.keys(catalog.locales);
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = [
    ["key", "description", "policy", ...languages].map(quote).join(","),
    ...keys.map((key) =>
      [
        key,
        catalog.definitions[key].description,
        catalog.definitions[key].policy,
        ...languages.map(
          (language) => catalog.locales[language].messages[key] ?? "",
        ),
      ]
        .map(quote)
        .join(","),
    ),
  ];
  const output = new URL("../i18n-translations.csv", import.meta.url);
  await writeFile(output, `${rows.join("\n")}\n`);
  console.log(`Wrote ${output.pathname}`);
}

if (warnings.length > 0) {
  console.log(
    `i18n fallback coverage: ${warnings.length} missing translations`,
  );
  const grouped = Object.groupBy(warnings, (value) => value.split(".")[0]);
  for (const [language, entries] of Object.entries(grouped)) {
    console.log(`  ${language}: ${entries.length}`);
  }
}
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `i18n catalog valid: ${keys.length} keys, ${Object.keys(catalog.locales).length} languages`,
  );
}
