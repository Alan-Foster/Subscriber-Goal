// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriptionButton } from "./SubscriptionButton";

describe("SubscriptionButton", () => {
  it.each(["subscribe", "link"] as const)(
    "animates an actionable %s button with the shared styling",
    (mode) => {
      const html = renderToStaticMarkup(
        <SubscriptionButton
          label={mode === "subscribe" ? "Join r/ExampleSub" : "Visit Website"}
          mode={mode}
          onClick={vi.fn()}
        />,
      );

      expect(html).toContain("sg-attention-host");
      expect(html).toContain('class="sg-subscribe-attention-shell absolute"');
      expect(html).toContain('class="sg-subscribe-attention absolute"');
      expect(html).toContain(`data-subscription-button-mode="${mode}"`);
      expect(html).toContain("rounded-full");
      expect(html).toContain("px-6 py-2");
      expect(html).toContain("min-h-[52px]");
      expect(html).toContain("min-w-[220px]");
      expect(html).toContain("gap-2");
      expect(html).toContain("text-lg");
      expect(html).toContain("sg-hover-grow");
      expect(html).toContain("max-w-full");
      expect(html).toContain("text-center");
      expect(html).toContain("whitespace-nowrap");
      expect(html).toContain("[overflow-wrap:normal]");
      expect(html).toContain('data-subscription-button-label="true"');
      expect(html).not.toContain('disabled=""');
      if (mode === "subscribe") {
        expect(html).toContain('data-subgoal-primary-cta="true"');
        expect(html).toContain('<span class="hidden shrink-0 sm:inline-flex">');
        expect(html).toContain('viewBox="0 0 20 20"');
        expect(html).toContain('d="M2.5 10h15m-6-6 6 6-6 6"');
        expect(html).toContain('stroke-width="2.5"');
        expect(html).toContain('aria-hidden="true"');
      } else {
        expect(html).not.toContain("data-subgoal-primary-cta");
        expect(html).not.toContain("hidden shrink-0 sm:inline-flex");
        expect(html).not.toContain('viewBox="0 0 20 20"');
      }
    },
  );

  it.each(["submitting", "subscribed"] as const)(
    "disables %s mode without attention animation",
    (mode) => {
      const html = renderToStaticMarkup(
        <SubscriptionButton label="Subscribed" mode={mode} />,
      );

      expect(html).not.toContain("sg-subscribe-attention");
      expect(html).not.toContain("sg-subscribe-attention-shell");
      expect(html).toContain('disabled=""');
    },
  );

  it("uses the selected theme for a link and its attention wrapper", () => {
    const html = renderToStaticMarkup(
      <SubscriptionButton
        colorTheme="pink"
        label="Visit Website"
        mode="link"
        onClick={vi.fn()}
      />,
    );

    expect(html).toContain('data-sg-theme="pink"');
    expect(html).toContain('class="sg-subscribe-attention-shell absolute"');
    expect(html).toContain('class="sg-subscribe-attention absolute"');
    expect(html).not.toContain('disabled=""');
  });

  it("renders responsive labels inside one button when a mobile label is provided", () => {
    const html = renderToStaticMarkup(
      <SubscriptionButton
        label="Install Subscriber Goal Now"
        mobileLabel="Install SubGoal Now"
        mode="link"
        onClick={vi.fn()}
      />,
    );

    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain(
      '<span class="sm:hidden">Install SubGoal Now</span>',
    );
    expect(html).toContain(
      '<span class="hidden sm:inline">Install Subscriber Goal Now</span>',
    );
  });

  it("renders an unchanged plain label when no mobile label is provided", () => {
    const html = renderToStaticMarkup(
      <SubscriptionButton label="Visit Website" mode="link" />,
    );

    expect(html).toContain(">Visit Website</span></button>");
    expect(html).not.toContain("sm:hidden");
    expect(html).not.toContain("hidden sm:inline");
  });
});

type ResizeObserverCallbackForTest = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver,
) => void;

describe("SubscriptionButton responsive label fitting", () => {
  let container: HTMLDivElement;
  let root: Root;
  let availableWidth: number;
  let configuredFontSize: number;
  let wideViewport: boolean;
  let fontWidthMultiplier: number;
  let resizeCallback: ResizeObserverCallbackForTest | null;
  let mediaChangeListener: ((event: MediaQueryListEvent) => void) | null;
  let fontLoadingListener: (() => void) | null;
  let frameCallbacks: Map<number, FrameRequestCallback>;
  let nextFrameId: number;

  const getVisibleLabel = (element: HTMLElement): string => {
    const responsiveLabels = element.children;
    if (responsiveLabels.length === 2) {
      return responsiveLabels.item(wideViewport ? 1 : 0)?.textContent ?? "";
    }
    return element.textContent ?? "";
  };

  const naturalWidthAt18 = (label: string): number => {
    const knownWidths: Record<string, number> = {
      "Join r/ExampleSub": 150,
      "Der Community jetzt beitreten": 315,
      コミュニティに参加する: 225,
      "Join r/ThisIsAnExtremelyLongSubredditNameForTesting": 450,
      "View the complete extraordinarily long call to action": 540,
      Short: 70,
      "A much longer translated label": 360,
      Mobile: 90,
      "A considerably longer desktop label": 390,
    };
    return knownWidths[label] ?? Math.max(1, Array.from(label).length * 10);
  };

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

  const renderButton = async (
    label: string,
    mobileLabel?: string,
    mode: "subscribe" | "link" = "link",
  ) => {
    await act(async () => {
      root.render(
        <SubscriptionButton
          label={label}
          mobileLabel={mobileLabel}
          mode={mode}
          onClick={vi.fn()}
        />,
      );
    });
  };

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    availableWidth = 320;
    configuredFontSize = 18;
    wideViewport = false;
    fontWidthMultiplier = 1;
    resizeCallback = null;
    mediaChangeListener = null;
    fontLoadingListener = null;
    frameCallbacks = new Map();
    nextFrameId = 1;

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () => ({ fontSize: `${configuredFontSize}px` }) as CSSStyleDeclaration,
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.subscriptionButtonLabel === "true"
          ? availableWidth
          : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.subscriptionButtonLabel !== "true") return 0;
        const fontSize = Number.parseFloat(this.style.fontSize) || 18;
        return Math.ceil(
          naturalWidthAt18(getVisibleLabel(this)) *
            (fontSize / 18) *
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

    window.matchMedia = vi.fn().mockImplementation(() => ({
      get matches() {
        return wideViewport;
      },
      media: "(min-width: 640px)",
      onchange: null,
      addEventListener: vi.fn(
        (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          mediaChangeListener = listener;
        },
      ),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

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
    Reflect.deleteProperty(window, "matchMedia");
  });

  it.each([
    ["English", "Join r/ExampleSub"],
    ["German", "Der Community jetzt beitreten"],
    ["Japanese", "コミュニティに参加する"],
  ])("keeps a fitting %s label on one line at 18px", async (_name, label) => {
    availableWidth = 400;
    await renderButton(label);

    const labelElement = container.querySelector<HTMLElement>(
      "[data-subscription-button-label='true']",
    );
    expect(labelElement?.style.fontSize).toBe("18px");
    expect(labelElement?.style.whiteSpace).toBe("nowrap");
    expect(labelElement?.style.overflowWrap).toBe("normal");
    expect(labelElement?.textContent).toBe(label);
  });

  it("shrinks a long subreddit label without going below 12px", async () => {
    availableWidth = 325;
    const label = "Join r/ThisIsAnExtremelyLongSubredditNameForTesting";
    await renderButton(label, undefined, "subscribe");

    const labelElement = container.querySelector<HTMLElement>(
      "[data-subscription-button-label='true']",
    );
    const fittedSize = Number.parseFloat(labelElement?.style.fontSize ?? "0");
    expect(fittedSize).toBeGreaterThanOrEqual(12);
    expect(fittedSize).toBeLessThan(18);
    expect(labelElement?.style.whiteSpace).toBe("nowrap");
    expect(labelElement?.textContent).toBe(label);
  });

  it("stays on one line when the complete label fits at exactly 12px", async () => {
    availableWidth = 300;
    const label = "Join r/ThisIsAnExtremelyLongSubredditNameForTesting";
    await renderButton(label, undefined, "subscribe");

    const labelElement = container.querySelector<HTMLElement>(
      "[data-subscription-button-label='true']",
    );
    expect(labelElement?.style.fontSize).toBe("12px");
    expect(labelElement?.style.whiteSpace).toBe("nowrap");
    expect(labelElement?.style.overflowWrap).toBe("normal");
  });

  it("wraps the complete label only when it cannot fit at 12px", async () => {
    availableWidth = 300;
    const label = "View the complete extraordinarily long call to action";
    await renderButton(label);

    const labelElement = container.querySelector<HTMLElement>(
      "[data-subscription-button-label='true']",
    );
    expect(labelElement?.style.fontSize).toBe("12px");
    expect(labelElement?.style.whiteSpace).toBe("normal");
    expect(labelElement?.style.overflowWrap).toBe("anywhere");
    expect(labelElement?.textContent).toBe(label);
    expect(labelElement?.className).not.toContain("truncate");
  });

  it("shrinks, wraps, and grows back as the available width changes", async () => {
    availableWidth = 280;
    await renderButton("A much longer translated label");
    const labelElement = container.querySelector<HTMLElement>(
      "[data-subscription-button-label='true']",
    );
    expect(Number.parseFloat(labelElement?.style.fontSize ?? "0")).toBeLessThan(
      18,
    );
    expect(labelElement?.style.whiteSpace).toBe("nowrap");

    availableWidth = 180;
    await triggerResize();
    expect(labelElement?.style.fontSize).toBe("12px");
    expect(labelElement?.style.whiteSpace).toBe("normal");

    availableWidth = 400;
    await triggerResize();
    expect(labelElement?.style.fontSize).toBe("18px");
    expect(labelElement?.style.whiteSpace).toBe("nowrap");
  });

  it("recalculates for replacement and responsive labels", async () => {
    availableWidth = 220;
    await renderButton("A considerably longer desktop label", "Mobile");
    const labelElement = container.querySelector<HTMLElement>(
      "[data-subscription-button-label='true']",
    );
    expect(labelElement?.style.fontSize).toBe("18px");
    expect(mediaChangeListener).not.toBeNull();

    wideViewport = true;
    await act(async () => {
      mediaChangeListener?.({ matches: true } as MediaQueryListEvent);
    });
    expect(getVisibleLabel(labelElement!)).toBe(
      "A considerably longer desktop label",
    );
    expect(frameCallbacks.size).toBe(1);
    await flushAnimationFrames();
    expect(Number.parseFloat(labelElement?.style.fontSize ?? "0")).toBeLessThan(
      18,
    );

    await renderButton("A much longer translated label");
    expect(Number.parseFloat(labelElement?.style.fontSize ?? "0")).toBeLessThan(
      18,
    );
    expect(labelElement?.textContent).toBe("A much longer translated label");
  });

  it("recalculates after fonts load", async () => {
    availableWidth = 180;
    await renderButton("Join r/ExampleSub");
    const labelElement = container.querySelector<HTMLElement>(
      "[data-subscription-button-label='true']",
    );
    expect(labelElement?.style.fontSize).toBe("18px");

    fontWidthMultiplier = 1.5;
    await act(async () => fontLoadingListener?.());
    await flushAnimationFrames();
    expect(Number.parseFloat(labelElement?.style.fontSize ?? "0")).toBeLessThan(
      18,
    );
  });

  it("uses an explicitly smaller computed font size as its maximum", async () => {
    configuredFontSize = 16;
    availableWidth = 300;
    await renderButton("Join r/ExampleSub");

    const labelElement = container.querySelector<HTMLElement>(
      "[data-subscription-button-label='true']",
    );
    expect(labelElement?.style.fontSize).toBe("16px");
  });

  it("does not schedule another fit when observed width is unchanged", async () => {
    availableWidth = 300;
    await renderButton("Join r/ExampleSub");
    expect(frameCallbacks.size).toBe(0);

    await act(async () => {
      resizeCallback?.([], {} as ResizeObserver);
    });
    expect(frameCallbacks.size).toBe(0);
  });
});
