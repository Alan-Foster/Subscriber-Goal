// npm run audit:records: exports each record to AI-ready Markdown plus an index.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAudit } from "./lib.mjs";
import { renderRecord, renderRecordIndex } from "./records.mjs";

const rootDir = process.cwd();
const { records } = loadAudit(rootDir);
const dir = join(rootDir, "audit", "records");
for (const record of records) {
  writeFileSync(join(dir, `${record.id}.md`), renderRecord(record));
}
writeFileSync(join(dir, "index.md"), renderRecordIndex(records));
console.log(`audit:records exported ${records.length} record(s).`);
