import { describe, expect, it } from "vitest";
import { confettiPresets } from "./confettiPresets";

describe("confettiPresets", () => {
  it("doubles the already-subscribed logo-click celebration", () => {
    expect(confettiPresets.logoCelebrate).toEqual({
      pieceCount: 48,
      durationMs: 3600,
      allowRestart: false,
    });
  });

  it("keeps subscribe and completed celebrations unchanged", () => {
    expect(confettiPresets.default).toEqual({
      pieceCount: 70,
      durationMs: 2600,
    });
    expect(confettiPresets.click).toEqual({
      pieceCount: 28,
      durationMs: 1600,
    });
    expect(confettiPresets.subscribe).toEqual({
      durationMs: 2800,
    });
    expect(confettiPresets.completed).toEqual({
      durationMs: 2800,
      allowRestart: true,
    });
  });
});
