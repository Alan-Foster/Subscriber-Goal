// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResponsiveHeaderText } from "./ResponsiveHeaderText";

type ResizeObserverCallbackForTest = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver,
) => void;

describe("ResponsiveHeaderText", () => {
  let container: HTMLDivElement;
  let root: Root;
  let availableWidth: number;
  let fontWidthMultiplier: number;
  let resizeCallback: ResizeObserverCallbackForTest | null;
  let fontLoadingListener: (() => void) | null;
  let frameCallbacks: Map<number, FrameRequestCallback>;
  let nextFrameId: number;

  const naturalWidthAt20 = (text: string): number => {
    const knownWidths: Record<string, number> = {
      "Welcome to r/ExampleSub": 230,
      "Willkommen bei r/EinAussergewoehnlichLangerSubredditName": 500,
      "Üdvözlünk az r/NagyonHosszuSubredditNev közösségben": 480,
      "A custom header with considerably more text than usual": 600,
      "Exact twelve pixel header": 500,
      "An exceptionally long header that still remains complete in the DOM": 760,
      Short: 80,
    };
    return knownWidths[text] ?? Math.max(1, Array.from(text).length * 10);
  };

  const renderHeader = async (text: string) => {
    await act(async () => {
      root.render(<ResponsiveHeaderText text={text} />);
    });
  };

  const getHeader = (): HTMLElement =>
    container.querySelector<HTMLElement>("[data-subgoal-header-label='true']")!;

  const flushAnimationFrames = async () => {
    await act(async () => {
      const callbacks = [...frameCallbacks.values()];
      frameCallbacks.clear();
      for (const callback of callbacks) callback(performance.now());
    });
  };

  const triggerResize = async () => {
    await act(async () => {
      resizeCallback?.([], {} as ResizeObserver);
    });
    await flushAnimationFrames();
  };

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    availableWidth = 400;
    fontWidthMultiplier = 1;
    resizeCallback = null;
    fontLoadingListener = null;
    frameCallbacks = new Map();
    nextFrameId = 1;

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.subgoalHeaderLabel === "true" ? availableWidth : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.subgoalHeaderLabel !== "true") return 0;
        const fontSize = Number.parseFloat(this.style.fontSize) || 20;
        return Math.ceil(
          naturalWidthAt20(this.textContent ?? "") *
            (fontSize / 20) *
            fontWidthMultiplier,
        );
      },
    );

    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallbackForTest) {
        resizeCallback = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);

    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        ready: new Promise<FontFaceSet>((resolve) => {
          void resolve;
        }),
        addEventListener: vi.fn((type: string, listener: () => void) => {
          if (type === "loadingdone") fontLoadingListener = listener;
        }),
        removeEventListener: vi.fn(),
      } as unknown as FontFaceSet,
    });

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frameCallbacks.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frameCallbacks.delete(id);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, "fonts");
  });

  it("keeps an ordinary English header at 20px", async () => {
    await renderHeader("Welcome to r/ExampleSub");

    expect(getHeader().style.fontSize).toBe("20px");
    expect(getHeader().style.whiteSpace).toBe("");
  });

  it.each([
    "Willkommen bei r/EinAussergewoehnlichLangerSubredditName",
    "Üdvözlünk az r/NagyonHosszuSubredditNev közösségben",
    "A custom header with considerably more text than usual",
  ])("shrinks a long header without going below 12px", async (text) => {
    availableWidth = 350;
    await renderHeader(text);

    const fittedSize = Number.parseFloat(getHeader().style.fontSize);
    expect(fittedSize).toBeGreaterThanOrEqual(12);
    expect(fittedSize).toBeLessThan(20);
    expect(getHeader().textContent).toBe(text);
  });

  it("keeps the complete header at the exact 12px boundary", async () => {
    availableWidth = 300;
    await renderHeader("Exact twelve pixel header");

    expect(getHeader().style.fontSize).toBe("12px");
    expect(getHeader().className).toContain("whitespace-nowrap");
    expect(getHeader().textContent).toBe("Exact twelve pixel header");
  });

  it("uses the existing ellipsis presentation when 12px cannot fit", async () => {
    availableWidth = 300;
    const text =
      "An exceptionally long header that still remains complete in the DOM";
    await renderHeader(text);

    expect(getHeader().style.fontSize).toBe("12px");
    expect(getHeader().className).toContain("truncate");
    expect(getHeader().className).toContain("whitespace-nowrap");
    expect(getHeader().textContent).toBe(text);
  });

  it("shrinks and grows back as the available width changes", async () => {
    availableWidth = 200;
    await renderHeader("Welcome to r/ExampleSub");
    expect(Number.parseFloat(getHeader().style.fontSize)).toBeLessThan(20);

    availableWidth = 500;
    await triggerResize();
    expect(getHeader().style.fontSize).toBe("20px");
  });

  it("recalculates after header replacement and font loading", async () => {
    await renderHeader("Short");
    expect(getHeader().style.fontSize).toBe("20px");

    await renderHeader(
      "A custom header with considerably more text than usual",
    );
    expect(Number.parseFloat(getHeader().style.fontSize)).toBeLessThan(20);

    fontWidthMultiplier = 1.25;
    await act(async () => fontLoadingListener?.());
    await flushAnimationFrames();
    expect(Number.parseFloat(getHeader().style.fontSize)).toBeLessThan(14);
  });

  it("does not schedule a fit when the observed width is unchanged", async () => {
    await renderHeader("Welcome to r/ExampleSub");
    expect(frameCallbacks.size).toBe(0);

    await act(async () => {
      resizeCallback?.([], {} as ResizeObserver);
    });
    expect(frameCallbacks.size).toBe(0);
  });
});
