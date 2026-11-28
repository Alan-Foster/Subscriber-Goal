// npm run audit:grid: writes the coverage grids and the summary.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAudit } from "./lib.mjs";
import { renderGridSvg, renderSummary } from "./grid.mjs";

const rootDir = process.cwd();
const audit = loadAudit(rootDir);
const outputs = {
  "grid.svg": "combined",
  "grid-tests.svg": "tests",
  "grid-problems.svg": "problems",
  "grid-logging.svg": "logging",
};
for (const [file, layer] of Object.entries(outputs)) {
  writeFileSync(join(rootDir, "audit", file), renderGridSvg(audit, layer));
}
writeFileSync(join(rootDir, "audit", "summary.md"), renderSummary(audit));
console.log(
  `audit:grid wrote ${Object.keys(outputs).length} grids and summary.md (${audit.paths.length} paths).`,
);
