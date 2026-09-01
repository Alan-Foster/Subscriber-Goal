// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ prefersReducedMotion: false }));

vi.mock("../../hooks/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => hoisted.prefersReducedMotion,
}));

import {
  TinyViewTransition,
  tinyViewTransitionDurationMs,
} from "./TinyViewTransition";

describe("TinyViewTransition", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    hoisted.prefersReducedMotion = false;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const renderPhase = async (phase: string) => {
    await act(async () => {
      root.render(
        <TinyViewTransition transitionKey={phase}>
          <button>{phase}</button>
        </TinyViewTransition>,
      );
    });
  };

  it("crossfades phases for 250ms and makes the outgoing view inert", async () => {
    await renderPhase("subscribe");
    await renderPhase("confirmation");

    const outgoing = container.querySelector(
      '[data-tiny-transition-outgoing="true"]',
    );
    const active = container.querySelector(
      '[data-tiny-transition-active="true"]',
    );
    expect(outgoing?.textContent).toBe("subscribe");
    expect(outgoing?.getAttribute("aria-hidden")).toBe("true");
    expect(outgoing?.hasAttribute("inert")).toBe(true);
    expect(outgoing?.className).toContain("sg-tiny-view-exit");
    expect(active?.textContent).toBe("confirmation");
    expect(active?.className).toContain("sg-tiny-view-enter");

    await act(async () => {
      vi.advanceTimersByTime(tinyViewTransitionDurationMs - 1);
    });
    expect(
      container.querySelector('[data-tiny-transition-outgoing="true"]'),
    ).not.toBeNull();

    await act(async () => vi.advanceTimersByTime(1));
    expect(
      container.querySelector('[data-tiny-transition-outgoing="true"]'),
    ).toBeNull();
    expect(active?.className).not.toContain("sg-tiny-view-enter");
  });

  it("switches immediately when reduced motion is preferred", async () => {
    await renderPhase("subscribe");
    hoisted.prefersReducedMotion = true;
    await renderPhase("confirmation");

    expect(
      container.querySelector('[data-tiny-transition-outgoing="true"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-tiny-transition-active="true"]')
        ?.className,
    ).not.toContain("sg-tiny-view-enter");
    expect(container.textContent).toBe("confirmation");
  });

  it("clears transition timers when unmounted", async () => {
    await renderPhase("subscribe");
    await renderPhase("confirmation");
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});
