// npm run audit:validate: checks the audit ledger, records, paths and scope map.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listSourceFiles, loadAudit, validateAudit } from "./lib.mjs";

const rootDir = process.cwd();
const audit = loadAudit(rootDir);
const files = listSourceFiles(rootDir, audit.scope.root);
const { errors, mapping } = validateAudit(audit, {
  files,
  fileExists: (file) => existsSync(join(rootDir, file)),
});

if (errors.length > 0) {
  console.error(`audit:validate found ${errors.length} problem(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(
  `audit:validate ok: ${mapping.assigned.size} source files in ${audit.scope.categories.length} categories, ` +
    `${audit.checklist.areas.length} areas, ${audit.paths.length} paths, ${audit.records.length} records.`,
);
