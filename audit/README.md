# Silent-error audit

Working files for the silent-error audit (tracking issue #234). The audit checks
every inspection area of the Silent Error Assessment Framework against every
workflow path, and makes every failure point print an error to `devvit logs`.

## Files

| File                                  | What it holds                                                                                         | Written by                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------- |
| `checklist.json`                      | The 114 inspection areas, their sections, and who owns them (`sweep` or `workflow`)                   | #235                      |
| `scope.json`                          | The 8 code categories and their file patterns. Every source file maps to exactly one category         | #235                      |
| `paths.json`                          | Workflow paths, the grid's columns, each step tagged with its handoff type                            | #236                      |
| `ledger/<pathId>.json`                | One file per path: `{ "path": "<id>", "cells": { "<area id>": cell } }`. A missing cell is unreviewed | sweep and workflow issues |
| `records/<id>.json`                   | Problems, test gaps and log gaps (`records/schema.json`)                                              | all audit issues          |
| `records/<id>.md`, `records/index.md` | AI-ready exports that follow `issue-template.md`                                                      | `npm run audit:records`   |
| `grid*.svg`, `summary.md`             | The coverage grids and counts                                                                         | `npm run audit:grid`      |
| `issue-template.md`                   | The maintainer's template for turning a record into an issue                                          | #235                      |

## Cell format

```json
{
  "tests": "no_test",
  "problem": "none",
  "output": "silent",
  "records": ["R-S9-04"],
  "by": "S9",
  "test": "optional: names of tests that fail when the fault is injected",
  "note": "required when tests is not_relevant",
  "evidence": "required when output is logged: file:line of the logDiagnostic call"
}
```

- `tests`: `unreviewed` (white), `not_relevant` (gray), `no_test` (yellow),
  `partial` (blue: at least one relevant test, not every case), `covered`
  (green: all relevant tests exist and fail when the fault is injected).
- `problem`: `none`, `suspected` (orange corner), `confirmed` (red corner).
- `output`: `logged` (●), `partial` (◐), `silent` (○). Gray cells have none.
- `by`: the owning issue key. Pattern-based sections (3, 5, 7, 8, 9, 12)
  belong to `S<section>`; flow-based sections belong to `W<category>`. #236 may
  pre-fill gray cells with `by: "F2"`.

## Commands

- `npm run audit:validate`: checks everything above (also part of `npm run verify`).
- `npm run audit:grid`: regenerates the grids and `summary.md`.
- `npm run audit:records`: regenerates the record exports.

Work one path or sub-task per session, commit the ledger and records, and never
mark a cell you didn't check.
