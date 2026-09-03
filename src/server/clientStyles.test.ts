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
    expect(css).toContain("animation: sg-tiny-view-fade-in 250ms");
    expect(css).toContain("animation: sg-tiny-view-fade-out 250ms");
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.sg-tiny-view-enter,[\s\S]*\.sg-tiny-view-exit\s*\{[\s\S]*animation:\s*none;/,
    );
    expect(css).toMatch(/:root\s*\{[^}]*--sg-goal-frame-radius:\s*15px;/s);
    expect(css).toMatch(
      /\.sg-goal-frame::after\s*\{[^}]*border-radius:\s*var\(--sg-goal-frame-radius\);[^}]*box-shadow:\s*inset 0 0 0 2px var\(--sg-accent\);[^}]*pointer-events:\s*none;/s,
    );
  });
});
