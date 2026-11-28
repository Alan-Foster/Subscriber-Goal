// Grid and summary rendering for the silent-error audit (pure functions).
import { cellFor } from "./lib.mjs";

const fills = {
  unreviewed: "#ffffff",
  not_relevant: "#c8ccd0",
  no_test: "#f2c94c",
  partial: "#4a90d9",
  covered: "#3fa45b",
};
const layerNames = {
  combined: "Combined",
  tests: "Test coverage",
  problems: "Problems",
  logging: "Error output",
};
const cellSize = 14;
const rowLabelWidth = 250;
const headerHeight = 150;

const escapeXml = (value) =>
  String(value).replace(
    /[<>&"']/gu,
    (char) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[char],
  );

function orderedPaths(audit) {
  return [...audit.paths].sort(
    (a, b) => a.category - b.category || a.id.localeCompare(b.id),
  );
}

function cellMarks(cell, layer, x, y) {
  const parts = [];
  const showFill = layer === "combined" || layer === "tests";
  const fill = showFill
    ? (fills[cell.tests] ?? "#ffffff")
    : cell.tests === "not_relevant"
      ? fills.not_relevant
      : "#ffffff";
  parts.push(
    `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="${fill}" stroke="#8a8f94" stroke-width="0.5"/>`,
  );
  if (cell.tests === "unreviewed" || cell.tests === "not_relevant")
    return parts;
  if (
    (layer === "combined" || layer === "problems") &&
    cell.problem !== "none"
  ) {
    const color = cell.problem === "confirmed" ? "#d0312d" : "#f08c00";
    parts.push(
      `<polygon points="${x + cellSize - 7},${y} ${x + cellSize},${y} ${x + cellSize},${y + 7}" fill="${color}"/>`,
    );
  }
  if (layer === "combined" || layer === "logging") {
    const cx = x + cellSize / 2;
    const cy = y + cellSize / 2;
    if (cell.output === "logged") {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="3" fill="#1b1f23"/>`);
    } else if (cell.output === "partial") {
      parts.push(
        `<circle cx="${cx}" cy="${cy}" r="3" fill="none" stroke="#1b1f23"/>`,
        `<path d="M ${cx} ${cy - 3} A 3 3 0 0 1 ${cx} ${cy + 3} Z" fill="#1b1f23"/>`,
      );
    } else if (cell.output === "silent") {
      parts.push(
        `<circle cx="${cx}" cy="${cy}" r="3" fill="none" stroke="#1b1f23"/>`,
      );
    }
  }
  return parts;
}

function legend(y) {
  const items = [
    ["#ffffff", "unreviewed"],
    [fills.not_relevant, "not relevant"],
    [fills.no_test, "no test"],
    [fills.partial, "partial (some tests)"],
    [fills.covered, "covered (all tests)"],
  ];
  const parts = items.map(
    ([fill, label], i) =>
      `<rect x="${10 + i * 150}" y="${y}" width="12" height="12" fill="${fill}" stroke="#8a8f94"/>` +
      `<text x="${28 + i * 150}" y="${y + 10}" font-size="11">${escapeXml(label)}</text>`,
  );
  parts.push(
    `<text x="10" y="${y + 30}" font-size="11">Corner: orange = suspected problem, red = confirmed problem. Dot: ● logged, ◐ partial, ○ silent.</text>`,
  );
  return parts.join("");
}

/** Renders one SVG grid. `layer` is combined | tests | problems | logging. */
export function renderGridSvg(audit, layer = "combined") {
  const paths = orderedPaths(audit);
  const areas = audit.checklist.areas;
  const sectionTitles = new Map(
    audit.checklist.sections.map((s) => [s.id, s.title]),
  );
  const width = rowLabelWidth + Math.max(paths.length, 1) * cellSize + 20;
  let rowsHeight = 0;
  let previousSection;
  for (const area of areas) {
    if (area.section !== previousSection) rowsHeight += cellSize;
    rowsHeight += cellSize;
    previousSection = area.section;
  }
  const height = headerHeight + rowsHeight + 60;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="sans-serif">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="10" y="20" font-size="14" font-weight="bold">Silent-error audit: ${escapeXml(layerNames[layer])} (${areas.length} areas × ${paths.length} paths)</text>`,
  ];
  if (paths.length === 0) {
    parts.push(
      `<text x="10" y="40" font-size="12">No workflow paths yet: issue #236 adds them to audit/paths.json.</text>`,
    );
  }
  paths.forEach((path, i) => {
    const x = rowLabelWidth + i * cellSize + cellSize / 2;
    parts.push(
      `<text transform="translate(${x},${headerHeight - 4}) rotate(-60)" font-size="9">C${path.category} ${escapeXml(path.id)}</text>`,
    );
  });
  let y = headerHeight;
  previousSection = undefined;
  for (const area of areas) {
    if (area.section !== previousSection) {
      parts.push(
        `<text x="10" y="${y + 11}" font-size="11" font-weight="bold">${area.section}. ${escapeXml(sectionTitles.get(area.section))}</text>`,
      );
      y += cellSize;
      previousSection = area.section;
    }
    parts.push(
      `<text x="18" y="${y + 11}" font-size="10">${area.id} ${escapeXml(area.title)}</text>`,
    );
    paths.forEach((path, i) => {
      parts.push(
        ...cellMarks(
          cellFor(audit, path.id, area.id),
          layer,
          rowLabelWidth + i * cellSize,
          y,
        ),
      );
    });
    y += cellSize;
  }
  parts.push(legend(y + 15), "</svg>");
  return `${parts.join("\n")}\n`;
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** Markdown summary of cell and record counts. */
export function renderSummary(audit) {
  const cells = [];
  for (const path of audit.paths) {
    for (const area of audit.checklist.areas) {
      cells.push({ path, area, cell: cellFor(audit, path.id, area.id) });
    }
  }
  const reviewed = cells.filter(
    ({ cell }) => cell.tests !== "unreviewed" && cell.tests !== "not_relevant",
  );
  const tests = countBy(cells.map(({ cell }) => cell.tests));
  const problems = countBy(reviewed.map(({ cell }) => cell.problem ?? "none"));
  const outputs = countBy(reviewed.map(({ cell }) => cell.output ?? "silent"));
  const lines = [
    "# Silent-error audit summary",
    "",
    "Generated by `npm run audit:grid`. Do not edit by hand.",
    "",
    `- Areas: ${audit.checklist.areas.length}`,
    `- Workflow paths: ${audit.paths.length}`,
    `- Cells: ${cells.length}`,
    `- Records: ${audit.records.length}`,
    "",
    "## Test coverage",
    "",
    "| Status | Cells |",
    "|---|---:|",
    ...["unreviewed", "not_relevant", "no_test", "partial", "covered"].map(
      (s) => `| ${s} | ${tests[s] ?? 0} |`,
    ),
    "",
    "## Problems (reviewed, relevant cells)",
    "",
    "| Badge | Cells |",
    "|---|---:|",
    ...["none", "suspected", "confirmed"].map(
      (s) => `| ${s} | ${problems[s] ?? 0} |`,
    ),
    "",
    "## Error output (reviewed, relevant cells)",
    "",
    "| Dot | Cells |",
    "|---|---:|",
    ...["logged", "partial", "silent"].map(
      (s) => `| ${s} | ${outputs[s] ?? 0} |`,
    ),
    "",
    "## Records by type and criticality",
    "",
    "| Type | Count | Criticality 7–10 |",
    "|---|---:|---:|",
    ...["problem", "test_gap", "log_gap"].map((type) => {
      const ofType = audit.records.filter((r) => r.type === type);
      return `| ${type} | ${ofType.length} | ${ofType.filter((r) => r.criticality?.score >= 7).length} |`;
    }),
    "",
    "## By section",
    "",
    "| Section | Unreviewed | Relevant reviewed | Silent | Problems |",
    "|---|---:|---:|---:|---:|",
    ...audit.checklist.sections.map((section) => {
      const inSection = cells.filter(({ area }) => area.section === section.id);
      const rev = inSection.filter(
        ({ cell }) =>
          cell.tests !== "unreviewed" && cell.tests !== "not_relevant",
      );
      return `| ${section.id}. ${section.title} | ${inSection.filter(({ cell }) => cell.tests === "unreviewed").length} | ${rev.length} | ${rev.filter(({ cell }) => cell.output === "silent").length} | ${rev.filter(({ cell }) => cell.problem && cell.problem !== "none").length} |`;
    }),
    "",
    "## By category",
    "",
    "| Category | Paths | Unreviewed | Silent |",
    "|---|---:|---:|---:|",
    ...audit.scope.categories.map((category) => {
      const inCat = cells.filter(({ path }) => path.category === category.id);
      return `| ${category.id}. ${category.title} | ${audit.paths.filter((p) => p.category === category.id).length} | ${inCat.filter(({ cell }) => cell.tests === "unreviewed").length} | ${inCat.filter(({ cell }) => cell.output === "silent").length} |`;
    }),
    "",
  ];
  return lines.join("\n");
}
