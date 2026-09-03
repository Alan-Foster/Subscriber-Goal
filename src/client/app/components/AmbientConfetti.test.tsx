// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AmbientConfetti, ambientConfettiPieceCount } from "./AmbientConfetti";

describe("AmbientConfetti", () => {
  it("distributes 30 continuously falling pieces across the animation cycle", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<AmbientConfetti />);

    const effect = container.querySelector(
      '[data-celebration-effect="ambient-confetti"]',
    );
    const pieces = Array.from(
      container.querySelectorAll<HTMLElement>(".ambient-confetti-piece"),
    );
    const phases = pieces.map((piece) => {
      const duration = Number.parseFloat(piece.style.animationDuration);
      const delay = Number.parseFloat(piece.style.animationDelay);
      expect(duration).toBeGreaterThanOrEqual(6);
      expect(duration).toBeLessThanOrEqual(9);
      expect(delay).toBeLessThan(0);
      return Math.abs(delay) / duration;
    });

    expect(effect?.getAttribute("data-confetti-piece-count")).toBe("30");
    expect(pieces).toHaveLength(ambientConfettiPieceCount);
    expect(Math.min(...phases)).toBeLessThan(0.02);
    expect(Math.max(...phases)).toBeGreaterThan(0.98);
  });

  it("renders nothing for reduced-motion viewers", () => {
    expect(renderToStaticMarkup(<AmbientConfetti reducedMotion />)).toBe("");
  });
});
