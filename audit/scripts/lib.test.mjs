import { describe, expect, it } from "vitest";
import {
  expandBraces,
  globToRegExp,
  mapFilesToCategories,
  validateAudit,
} from "./lib.mjs";
import { renderGridSvg, renderSummary } from "./grid.mjs";
import { renderRecord, renderRecordIndex } from "./records.mjs";

const checklist = {
  sections: [
    { id: 7, title: "Async", owner: "sweep" },
    { id: 13, title: "Observability", owner: "workflow" },
  ],
  areas: [
    {
      id: "7.08",
      section: 7,
      title: "Retry mechanisms",
      definition: "d",
      owner: "sweep",
    },
    {
      id: "13.06",
      section: 13,
      title: "Success-only logging",
      definition: "d",
      owner: "workflow",
    },
  ],
  characteristics: [],
};
const scope = {
  root: "src",
  excluded: ["**/*.test.ts"],
  categories: [
    { id: 1, title: "Loading", yieldsTo: [2], selectors: ["client/**"] },
    {
      id: 2,
      title: "Actions",
      yieldsTo: [],
      selectors: ["client/app/{Join,Leave}.tsx"],
    },
    {
      id: 8,
      title: "Infra",
      yieldsTo: [],
      selectors: ["server/{index,types}.ts"],
    },
  ],
};
const path = {
  id: "C2-join",
  category: 2,
  title: "Join",
  entry: "click",
  outcome: "Redis write",
  steps: [{ at: "src/client/app/Join.tsx:10", handoff: "client_request" }],
};
const problem = {
  id: "R-W2-01",
  type: "problem",
  confidence: "suspected",
  title: "t",
  current: "c",
  location: "src/client/app/Join.tsx:10",
  areas: ["13.06"],
  paths: ["C2-join"],
  evidence: "e",
  investigate: ["i"],
  criticality: { score: 6, why: "w" },
};
const logGap = {
  ...problem,
  id: "R-W2-02",
  type: "log_gap",
  confidence: undefined,
};
delete logGap.confidence;

function fixture(overrides = {}) {
  return {
    checklist,
    scope,
    paths: [path],
    ledgers: [
      {
        file: "audit/ledger/C2-join.json",
        path: "C2-join",
        cells: {
          13.06: {
            tests: "no_test",
            problem: "suspected",
            output: "silent",
            records: ["R-W2-01", "R-W2-02"],
            by: "W2",
          },
        },
      },
    ],
    records: [problem, logGap],
    ...overrides,
  };
}
const files = ["client/app/Join.tsx", "client/app/Main.tsx", "server/index.ts"];
const existing = new Set(["src/client/app/Join.tsx", "src/server/index.ts"]);
const run = (audit, fileList = files) =>
  validateAudit(audit, { files: fileList, fileExists: (f) => existing.has(f) })
    .errors;
const withCell = (cell) =>
  fixture({
    ledgers: [
      {
        file: "audit/ledger/C2-join.json",
        path: "C2-join",
        cells: { 13.06: cell },
      },
    ],
  });

describe("globs", () => {
  it("expands nested braces", () => {
    expect(expandBraces("a/{b,c{d,e}}.ts")).toEqual([
      "a/b.ts",
      "a/cd.ts",
      "a/ce.ts",
    ]);
  });
  it("matches * within a segment and ** across segments", () => {
    expect(
      globToRegExp("server/core/onboarding*.ts").test(
        "server/core/onboardingState.ts",
      ),
    ).toBe(true);
    expect(
      globToRegExp("server/core/onboarding*.ts").test(
        "server/core/x/onboarding.ts",
      ),
    ).toBe(false);
    expect(globToRegExp("client/**").test("client/a/b/c.tsx")).toBe(true);
    expect(globToRegExp("**/*.test.ts").test("a.test.ts")).toBe(true);
    expect(globToRegExp("**/*.test.ts").test("x/y/a.test.ts")).toBe(true);
  });
});

describe("scope mapping", () => {
  it("resolves overlaps with yieldsTo and skips excluded files", () => {
    const result = mapFilesToCategories(scope, [
      ...files,
      "client/app/Join.test.ts",
    ]);
    expect(result.assigned.get("client/app/Join.tsx")).toBe(2);
    expect(result.assigned.get("client/app/Main.tsx")).toBe(1);
    expect(result.assigned.has("client/app/Join.test.ts")).toBe(false);
    expect(result.conflicts).toEqual([]);
  });
  it("reports unmapped and double-mapped files", () => {
    const broken = {
      ...scope,
      categories: [
        ...scope.categories,
        { id: 9, title: "Dup", yieldsTo: [], selectors: ["server/index.ts"] },
      ],
    };
    const errors = run(fixture({ scope: broken }), [...files, "shared/new.ts"]);
    expect(errors).toContain(
      "scope.json: src/shared/new.ts is not mapped to a category",
    );
    expect(errors).toContain(
      "scope.json: src/server/index.ts is mapped to categories 8, 9",
    );
  });
});

describe("validateAudit", () => {
  it("accepts a consistent audit", () => {
    expect(run(fixture())).toEqual([]);
  });
  it("requires a test name for covered cells", () => {
    expect(
      run(
        withCell({
          tests: "covered",
          problem: "none",
          output: "logged",
          evidence: "src/server/index.ts:1",
          by: "W2",
        }),
      ),
    ).toContain(
      'ledger C2-join 13.06: covered needs the failing "test" name(s)',
    );
  });
  it("requires a note and no dot for not_relevant cells, and allows F2 to pre-fill them", () => {
    const errors = run(
      withCell({ tests: "not_relevant", output: "silent", by: "F2" }),
    );
    expect(errors).toContain(
      'ledger C2-join 13.06: not_relevant needs a "note"',
    );
    expect(errors).toContain(
      "ledger C2-join 13.06: not_relevant cells have no output dot",
    );
    expect(errors.some((e) => e.includes("is owned by"))).toBe(false);
  });
  it("requires a problem record behind a badge and a log_gap behind a hollow dot", () => {
    const errors = run(
      withCell({
        tests: "no_test",
        problem: "confirmed",
        output: "partial",
        records: [],
        by: "W2",
      }),
    );
    expect(errors).toContain(
      "ledger C2-join 13.06: a confirmed badge needs a problem record",
    );
    expect(errors).toContain(
      "ledger C2-join 13.06: a partial dot needs a log_gap record",
    );
  });
  it("requires file:line evidence for logged cells", () => {
    expect(
      run(
        withCell({
          tests: "no_test",
          problem: "none",
          output: "logged",
          evidence: "src/missing.ts:3",
          by: "W2",
        }),
      ),
    ).toContain(
      'ledger C2-join 13.06: evidence file "src/missing.ts:3" does not exist',
    );
  });
  it("enforces cell ownership", () => {
    expect(
      run(
        withCell({
          tests: "no_test",
          problem: "none",
          output: "logged",
          evidence: "src/server/index.ts:1",
          by: "S7",
        }),
      ),
    ).toContain('ledger C2-join 13.06: cell is owned by W2 but "by" is "S7"');
  });
  it("validates record fields, criticality and location files", () => {
    const bad = {
      ...problem,
      id: "R-W2-03",
      criticality: { score: 11 },
      location: "nowhere",
      confidence: "maybe",
    };
    const errors = run(fixture({ records: [problem, logGap, bad] }));
    expect(errors).toContain(
      "R-W2-03: criticality.score must be an integer from 1 to 10",
    );
    expect(errors).toContain(
      "R-W2-03: criticality.why must give a one-sentence reason",
    );
    expect(errors).toContain(
      "R-W2-03: location must name at least one repository file",
    );
    expect(errors).toContain(
      "R-W2-03: problem confidence must be one of suspected, confirmed, question",
    );
  });
  it("requires each mapped record to be referenced by its reviewed cells", () => {
    const errors = run(
      withCell({
        tests: "no_test",
        problem: "suspected",
        output: "silent",
        records: ["R-W2-02"],
        by: "W2",
      }),
    );
    expect(errors).toContain(
      "R-W2-01: cell C2-join 13.06 does not reference this record",
    );
  });
  it("requires a ledger file and known handoff types for every path", () => {
    const badPath = {
      ...path,
      steps: [{ at: "src/client/app/Join.tsx:1", handoff: "magic" }],
    };
    const errors = run(fixture({ paths: [badPath], ledgers: [] }));
    expect(errors).toContain(
      'paths.json C2-join: step "src/client/app/Join.tsx:1" has unknown handoff "magic"',
    );
    expect(errors).toContain(
      "paths.json C2-join: no ledger file audit/ledger/C2-join.json",
    );
  });
});

describe("rendering", () => {
  it("draws the grid layers and summary", () => {
    const audit = fixture();
    const svg = renderGridSvg(audit, "combined");
    expect(svg).toContain("<svg");
    expect(svg).toContain("C2 C2-join");
    expect(svg).toContain('fill="#f08c00"');
    expect(renderGridSvg(audit, "tests")).not.toContain('fill="#f08c00"');
    const summary = renderSummary(audit);
    expect(summary).toContain("| no_test | 1 |");
    expect(summary).toContain("| silent | 1 |");
  });
  it("exports records with the template headings and flags empty sections", () => {
    const markdown = renderRecord(problem);
    expect(markdown).toContain("## 1. Current Implementation");
    expect(markdown).toContain("## 9. Criticality and Implementation Cost");
    expect(markdown).toContain("_Not yet investigated._");
    expect(renderRecordIndex([logGap, problem])).toContain(
      "| [R-W2-01](R-W2-01.md) | problem (suspected) | 6 | t |",
    );
  });
});
