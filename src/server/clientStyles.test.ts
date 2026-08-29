import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("client subscribe attention styles", () => {
  it("uses a stacking-safe glow and preserves reduced-motion behavior", () => {
    const css = readFileSync(
      join(process.cwd(), "src/client/index.css"),
      "utf8",
    );

    expect(css).not.toContain(".sg-subscribe-attention::after");
    expect(css).toMatch(/\.sg-subscribe-attention\s*\{[^}]*z-index:\s*0;/s);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.sg-subscribe-attention\s*\{[\s\S]*animation:\s*none;/,
    );
  });
});
