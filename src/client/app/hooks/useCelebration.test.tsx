// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confettiPresets } from "../confettiPresets";
import { useCelebration } from "./useCelebration";

const Harness = () => {
  const { celebrationBursts, triggerCelebration } = useCelebration();
  return (
    <div>
      <button
        data-trigger="normal"
        onClick={() => triggerCelebration(confettiPresets.click)}
      />
      <button
        data-trigger="locked"
        onClick={() => triggerCelebration(confettiPresets.logoCelebrate)}
      />
      {celebrationBursts.map((burst) => (
        <span
          key={burst.id}
          data-burst={burst.id}
          data-pieces={burst.pieceCount}
        />
      ))}
    </div>
  );
};

describe("useCelebration", () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves allowRestart false while another burst is active", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));

    await act(async () => {
      container.querySelector<HTMLElement>('[data-trigger="normal"]')?.click();
      container.querySelector<HTMLElement>('[data-trigger="locked"]')?.click();
    });
    expect(container.querySelectorAll("[data-burst]")).toHaveLength(1);
    expect(
      container.querySelector("[data-burst]")?.getAttribute("data-pieces"),
    ).toBe("28");

    await act(async () =>
      vi.advanceTimersByTime(confettiPresets.click.durationMs),
    );
    await act(async () => {
      container.querySelector<HTMLElement>('[data-trigger="locked"]')?.click();
    });
    expect(
      container.querySelector("[data-burst]")?.getAttribute("data-pieces"),
    ).toBe("48");

    await act(async () => root.unmount());
  });

  it("clears every outstanding burst timer on unmount", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));

    await act(async () => {
      const trigger = container.querySelector<HTMLElement>(
        '[data-trigger="normal"]',
      );
      trigger?.click();
      trigger?.click();
    });
    expect(vi.getTimerCount()).toBe(2);

    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
