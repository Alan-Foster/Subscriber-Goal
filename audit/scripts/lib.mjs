// Shared logic for the silent-error audit kit (issue #235).
// Pure functions where possible so they can be unit tested without the repo.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const testStatuses = [
  "unreviewed",
  "not_relevant",
  "no_test",
  "partial",
  "covered",
];
export const problemStatuses = ["none", "suspected", "confirmed"];
export const outputStatuses = ["logged", "partial", "silent"];
export const recordTypes = ["problem", "test_gap", "log_gap"];
export const problemConfidences = ["suspected", "confirmed", "question"];
export const handoffTypes = [
  "client_request",
  "client_response",
  "reddit_api",
  "redis_read",
  "redis_write",
  "redis_txn",
  "trigger_entry",
  "scheduler_entry",
  "scheduled_action",
  "job_queue",
  "realtime",
  "parse_validate",
  "internal",
];
const requiredRecordFields = [
  "id",
  "type",
  "title",
  "current",
  "location",
  "areas",
  "evidence",
  "criticality",
];
const recordIdPattern = /^R-(?:F[1-3]|S(?:3|5|7|8|9|12)|W[1-8]|G1)-\d{2,}$/u;
const fileLinePattern = /^[\w./-]+:\d+$/u;
const locationFilePattern =
  /(?:^|[\s(;,`])((?:src|audit|docs|scripts)\/[\w./-]+\.\w+|devvit\.json|package\.json|AGENTS\.md)/gu;

// ───────────── Globs ─────────────

/** Expands `{a,b}` alternatives (nested braces supported). */
export function expandBraces(pattern) {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  const commas = [];
  for (let i = open; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (char === "," && depth === 1) commas.push(i);
  }
  if (close === -1) throw new Error(`Unclosed brace in pattern: ${pattern}`);
  const before = pattern.slice(0, open);
  const after = pattern.slice(close + 1);
  const bounds = [open, ...commas, close];
  const options = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    options.push(pattern.slice(bounds[i] + 1, bounds[i + 1]));
  }
  return options.flatMap((option) =>
    expandBraces(`${before}${option}${after}`),
  );
}

/** Converts one brace-free glob (`*`, `**`) into an anchored RegExp. */
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      const slashAfter = glob[i + 2] === "/";
      source += slashAfter ? "(?:.*/)?" : ".*";
      i += slashAfter ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "u");
}

export function compileSelectors(selectors) {
  return selectors.flatMap(expandBraces).map(globToRegExp);
}

export function matchesAny(regexes, file) {
  return regexes.some((regex) => regex.test(file));
}

/**
 * Maps every file (relative to the scope root) to one category id.
 * Returns { assigned: Map<file, id>, unmapped: string[], conflicts: [{file, ids}] }.
 */
export function mapFilesToCategories(scope, files) {
  const excluded = compileSelectors(scope.excluded ?? []);
  const categories = scope.categories.map((category) => ({
    ...category,
    regexes: compileSelectors(category.selectors),
  }));
  const assigned = new Map();
  const unmapped = [];
  const conflicts = [];
  for (const file of files) {
    if (matchesAny(excluded, file)) continue;
    let ids = categories
      .filter((category) => matchesAny(category.regexes, file))
      .map((category) => category.id);
    if (ids.length > 1) {
      ids = ids.filter((id) => {
        const category = categories.find((c) => c.id === id);
        return !(category.yieldsTo ?? []).some((other) => ids.includes(other));
      });
    }
    if (ids.length === 0) unmapped.push(file);
    else if (ids.length > 1) conflicts.push({ file, ids });
    else assigned.set(file, ids[0]);
  }
  return { assigned, unmapped, conflicts };
}

// ───────────── Loading ─────────────

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

export function loadAudit(rootDir) {
  const auditDir = join(rootDir, "audit");
  const recordsDir = join(auditDir, "records");
  const ledgerDir = join(auditDir, "ledger");
  const listJson = (dir) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith(".json") && name !== "schema.json")
          .sort()
      : [];
  return {
    checklist: readJson(join(auditDir, "checklist.json")),
    scope: readJson(join(auditDir, "scope.json")),
    paths: readJson(join(auditDir, "paths.json")),
    ledgers: listJson(ledgerDir).map((name) => ({
      file: `audit/ledger/${name}`,
      ...readJson(join(ledgerDir, name)),
    })),
    records: listJson(recordsDir).map((name) => ({
      file: `audit/records/${name}`,
      ...readJson(join(recordsDir, name)),
    })),
  };
}

export function listSourceFiles(rootDir, scopeRoot) {
  return execFileSync("git", ["ls-files", "-z", "--", scopeRoot], {
    cwd: rootDir,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/").slice(scopeRoot.length + 1));
}

// ───────────── Ownership ─────────────

/** The issue key that owns a cell: sweep sections by S<n>, flow sections by W<category>. */
export function expectedOwner(area, path) {
  return area.owner === "sweep" ? `S${area.section}` : `W${path.category}`;
}

// ───────────── Validation ─────────────

function locationFiles(location) {
  return [...String(location).matchAll(locationFilePattern)].map(
    (match) => match[1],
  );
}

function validateRecord(record, ctx, errors) {
  const where = record.file ?? record.id;
  for (const field of requiredRecordFields) {
    const value = record[field];
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      errors.push(`${where}: missing required field "${field}"`);
    }
  }
  if (record.id && !recordIdPattern.test(record.id)) {
    errors.push(
      `${where}: id "${record.id}" must look like R-<issue key>-<nn>`,
    );
  }
  if (record.file && record.id && !record.file.endsWith(`/${record.id}.json`)) {
    errors.push(`${where}: file name must match id "${record.id}"`);
  }
  if (!recordTypes.includes(record.type)) {
    errors.push(`${where}: type must be one of ${recordTypes.join(", ")}`);
  }
  if (record.type === "problem") {
    if (!problemConfidences.includes(record.confidence)) {
      errors.push(
        `${where}: problem confidence must be one of ${problemConfidences.join(", ")}`,
      );
    }
  } else if (record.confidence !== undefined) {
    errors.push(`${where}: only problem records have a confidence`);
  }
  const score = record.criticality?.score;
  if (!Number.isInteger(score) || score < 1 || score > 10) {
    errors.push(`${where}: criticality.score must be an integer from 1 to 10`);
  }
  if (!record.criticality?.why) {
    errors.push(`${where}: criticality.why must give a one-sentence reason`);
  }
  if (record.type === "problem" && !record.investigate) {
    errors.push(`${where}: problem records need "investigate"`);
  }
  for (const area of record.areas ?? []) {
    if (!ctx.areaById.has(area))
      errors.push(`${where}: unknown area "${area}"`);
  }
  for (const pathId of record.paths ?? []) {
    if (!ctx.pathById.has(pathId))
      errors.push(`${where}: unknown path "${pathId}"`);
  }
  const files = locationFiles(record.location ?? "");
  if (record.location && files.length === 0) {
    errors.push(`${where}: location must name at least one repository file`);
  }
  for (const file of files) {
    if (!ctx.fileExists(file)) {
      errors.push(`${where}: location file "${file}" does not exist`);
    }
  }
  if (record.estimatedLoc !== undefined) {
    const { code, tests } = record.estimatedLoc;
    if (!Number.isInteger(code) || !Number.isInteger(tests)) {
      errors.push(`${where}: estimatedLoc must be { code, tests } integers`);
    }
  }
}

function validateCell(cell, area, path, ctx, errors) {
  const where = `ledger ${path.id} ${area.id}`;
  if (!testStatuses.includes(cell.tests)) {
    errors.push(`${where}: tests must be one of ${testStatuses.join(", ")}`);
    return;
  }
  if (cell.tests === "unreviewed") return;
  const owner = expectedOwner(area, path);
  const allowed = cell.tests === "not_relevant" ? [owner, "F2"] : [owner];
  if (!allowed.includes(cell.by)) {
    errors.push(`${where}: cell is owned by ${owner} but "by" is "${cell.by}"`);
  }
  if (cell.tests === "not_relevant") {
    if (!cell.note) errors.push(`${where}: not_relevant needs a "note"`);
    if (cell.output !== null && cell.output !== undefined) {
      errors.push(`${where}: not_relevant cells have no output dot`);
    }
    if (cell.problem && cell.problem !== "none") {
      errors.push(`${where}: not_relevant cells have no problem badge`);
    }
    return;
  }
  if (cell.tests === "covered" && !cell.test) {
    errors.push(`${where}: covered needs the failing "test" name(s)`);
  }
  if (!problemStatuses.includes(cell.problem)) {
    errors.push(
      `${where}: problem must be one of ${problemStatuses.join(", ")}`,
    );
  }
  if (!outputStatuses.includes(cell.output)) {
    errors.push(`${where}: output must be one of ${outputStatuses.join(", ")}`);
  }
  const records = (cell.records ?? []).map((id) => ctx.recordById.get(id));
  (cell.records ?? []).forEach((id, index) => {
    if (!records[index]) errors.push(`${where}: unknown record "${id}"`);
  });
  const hasType = (predicate) => records.some((r) => r && predicate(r));
  if (
    (cell.problem === "suspected" || cell.problem === "confirmed") &&
    !hasType((r) => r.type === "problem")
  ) {
    errors.push(`${where}: a ${cell.problem} badge needs a problem record`);
  }
  if (
    cell.problem === "confirmed" &&
    !hasType((r) => r.confidence === "confirmed")
  ) {
    errors.push(`${where}: a confirmed badge needs a confirmed problem record`);
  }
  if (
    (cell.output === "partial" || cell.output === "silent") &&
    !hasType((r) => r.type === "log_gap")
  ) {
    errors.push(`${where}: a ${cell.output} dot needs a log_gap record`);
  }
  if (cell.output === "logged") {
    if (!fileLinePattern.test(cell.evidence ?? "")) {
      errors.push(`${where}: logged needs "evidence" as file:line`);
    } else if (!ctx.fileExists(cell.evidence.replace(/:\d+$/u, ""))) {
      errors.push(`${where}: evidence file "${cell.evidence}" does not exist`);
    }
  }
}

function validatePaths(audit, ctx, errors) {
  const seen = new Set();
  for (const path of audit.paths) {
    const where = `paths.json ${path.id ?? "(no id)"}`;
    if (!path.id) errors.push(`${where}: missing id`);
    if (seen.has(path.id)) errors.push(`${where}: duplicate id`);
    seen.add(path.id);
    if (!audit.scope.categories.some((c) => c.id === path.category)) {
      errors.push(`${where}: unknown category "${path.category}"`);
    }
    for (const field of ["title", "entry", "outcome"]) {
      if (!path[field]) errors.push(`${where}: missing "${field}"`);
    }
    if (!Array.isArray(path.steps) || path.steps.length === 0) {
      errors.push(`${where}: needs at least one step`);
    }
    for (const step of path.steps ?? []) {
      if (!handoffTypes.includes(step.handoff)) {
        errors.push(
          `${where}: step "${step.at}" has unknown handoff "${step.handoff}"`,
        );
      }
      const file = String(step.at ?? "").split(":")[0];
      if (!ctx.fileExists(file)) {
        errors.push(`${where}: step file "${file}" does not exist`);
      }
    }
    if (!ctx.ledgerByPath.has(path.id)) {
      errors.push(`${where}: no ledger file audit/ledger/${path.id}.json`);
    }
  }
}

/**
 * Validates the whole audit. `files` are tracked files under the scope root;
 * `fileExists(repoRelativePath)` checks the working tree.
 */
export function validateAudit(audit, { files, fileExists }) {
  const errors = [];
  const areaById = new Map(
    audit.checklist.areas.map((area) => [area.id, area]),
  );
  const pathById = new Map(audit.paths.map((path) => [path.id, path]));
  const recordById = new Map(
    audit.records.map((record) => [record.id, record]),
  );
  const ledgerByPath = new Map(
    audit.ledgers.map((ledger) => [ledger.path, ledger]),
  );
  const ctx = { areaById, pathById, recordById, ledgerByPath, fileExists };

  if (audit.checklist.areas.length !== new Set(areaById.keys()).size) {
    errors.push("checklist.json: duplicate area ids");
  }
  for (const area of audit.checklist.areas) {
    if (area.owner !== "sweep" && area.owner !== "workflow") {
      errors.push(`checklist.json ${area.id}: owner must be sweep or workflow`);
    }
  }

  const mapping = mapFilesToCategories(audit.scope, files);
  for (const file of mapping.unmapped) {
    errors.push(
      `scope.json: ${audit.scope.root}/${file} is not mapped to a category`,
    );
  }
  for (const { file, ids } of mapping.conflicts) {
    errors.push(
      `scope.json: ${audit.scope.root}/${file} is mapped to categories ${ids.join(", ")}`,
    );
  }

  validatePaths(audit, ctx, errors);

  const seenRecords = new Set();
  for (const record of audit.records) {
    if (seenRecords.has(record.id))
      errors.push(`records: duplicate id ${record.id}`);
    seenRecords.add(record.id);
    validateRecord(record, ctx, errors);
  }

  for (const ledger of audit.ledgers) {
    const path = pathById.get(ledger.path);
    if (!path) {
      errors.push(`${ledger.file}: unknown path "${ledger.path}"`);
      continue;
    }
    for (const [areaId, cell] of Object.entries(ledger.cells ?? {})) {
      const area = areaById.get(areaId);
      if (!area) {
        errors.push(`${ledger.file}: unknown area "${areaId}"`);
        continue;
      }
      validateCell(cell, area, path, ctx, errors);
    }
  }

  // A record mapped to paths must be referenced by each of its cells.
  for (const record of audit.records) {
    for (const pathId of record.paths ?? []) {
      const ledger = ledgerByPath.get(pathId);
      for (const areaId of record.areas ?? []) {
        const cell = ledger?.cells?.[areaId];
        if (
          cell &&
          cell.tests !== "unreviewed" &&
          !(cell.records ?? []).includes(record.id)
        ) {
          errors.push(
            `${record.file ?? record.id}: cell ${pathId} ${areaId} does not reference this record`,
          );
        }
      }
    }
  }

  return { errors, mapping };
}

// ───────────── Cell helpers ─────────────

export function cellFor(audit, pathId, areaId) {
  const ledger = audit.ledgers.find((l) => l.path === pathId);
  return ledger?.cells?.[areaId] ?? { tests: "unreviewed" };
}
