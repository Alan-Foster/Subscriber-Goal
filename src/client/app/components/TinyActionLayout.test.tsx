// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CtaOnlyState,
  SubscribeOnlyState,
} from "../../../shared/types/api";

const hoisted = vi.hoisted(() => ({ isWide: true }));

vi.mock("../../hooks/useWideViewport", () => ({
  useWideViewport: () => hoisted.isWide,
}));

import { SubscriptionButton } from "./SubscriptionButton";
import { TinyActionLayout } from "./TinyActionLayout";

type ResizeObserverCallbackForTest = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver,
) => void;

type ResizeObserverInstance = {
  callback: ResizeObserverCallbackForTest;
  targets: Set<Element>;
};

const subscribeOnlyState: SubscribeOnlyState = {
  colorTheme: "blue",
  postHeight: "tiny",
  promoSubreddit: "SubGoal",
  language: "en",
  afterSubscribeAction: { type: "disabled" },
  subscribed: false,
  authenticated: true,
  subreddit: {
    name: "ExampleSub",
    subscribers: 15_100,
    growth: { count: 3, period: "today" },
  },
};

const ctaOnlyState: CtaOnlyState = {
  colorTheme: "green",
  postHeight: "cta",
  promoSubreddit: "SubGoal",
  language: "en",
  afterSubscribeAction: {
    type: "link",
    buttonText: "Visit Website",
    url: "https://example.com/",
    colorTheme: "green",
  },
  subreddit: {
    name: "ExampleSub",
    subscribers: 15_100,
    growth: { count: 3, period: "today" },
  },
};

describe("TinyActionLayout coordinated text fitting", () => {
  let container: HTMLDivElement;
  let root: Root;
  let containerWidth: number;
  let leftNaturalWidth: number;
  let rightNaturalWidth: number;
  let ctaNaturalWidths: Record<string, number>;
  let fontWidthMultiplier: number;
  let resizeObservers: ResizeObserverInstance[];
  let fontLoadingListener: (() => void) | null;
  let frameCallbacks: Map<number, FrameRequestCallback>;
  let nextFrameId: number;

  const getFontSize = (element: HTMLElement): number =>
    Number.parseFloat(element.style.fontSize) || 18;

  const flushAnimationFrames = async () => {
    await act(async () => {
      const callbacks = [...frameCallbacks.values()];
      frameCallbacks.clear();
      for (const callback of callbacks) callback(performance.now());
    });
  };

  const renderLayout = async (
    label = "Compact CTA",
    state: SubscribeOnlyState | CtaOnlyState = subscribeOnlyState,
  ) => {
    await act(async () => {
      root.render(
        <TinyActionLayout state={state} showCtaActivity>
          <SubscriptionButton label={label} mode="link" onClick={vi.fn()} />
        </TinyActionLayout>,
      );
    });
  };

  const getLayout = (): HTMLElement =>
    container.querySelector<HTMLElement>("[data-tiny-wide-layout='true']")!;

  const getCtaLabel = (): HTMLElement =>
    container.querySelector<HTMLElement>(
      "[data-subscription-button-label='true']",
    )!;

  const triggerLayoutResize = async () => {
    const layout = getLayout();
    const observer = resizeObservers.find((candidate) =>
      candidate.targets.has(layout),
    );
    await act(async () => {
      observer?.callback(
        [
          {
            target: layout,
            contentRect: { width: containerWidth },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    });
    await flushAnimationFrames();
  };

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    hoisted.isWide = true;
    containerWidth = 800;
    leftNaturalWidth = 100;
    rightNaturalWidth = 100;
    ctaNaturalWidths = {
      "Compact CTA": 150,
      "Long translated CTA": 300,
      "Extremely long compact call to action requiring wrapping": 700,
    };
    fontWidthMultiplier = 1;
    resizeObservers = [];
    fontLoadingListener = null;
    frameCallbacks = new Map();
    nextFrameId = 1;

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element) =>
        ({
          columnGap: element instanceof HTMLButtonElement ? "8px" : "0px",
          display: "inline",
          fontSize: "18px",
          minWidth: element instanceof HTMLButtonElement ? "220px" : "0px",
          paddingLeft: element instanceof HTMLButtonElement ? "24px" : "0px",
          paddingRight: element instanceof HTMLButtonElement ? "24px" : "0px",
        }) as CSSStyleDeclaration,
    );

    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.tinyWideLayout === "true") return containerWidth;
        if (this.dataset.subscriptionButtonLabel === "true") {
          return Math.max(1, containerWidth - 192);
        }
        return 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        const scale = getFontSize(this) / 18;
        if (this.dataset.subscriberCount === "true") {
          return Math.ceil(leftNaturalWidth * scale * fontWidthMultiplier);
        }
        if (this.dataset.compactActivity === "true") {
          return Math.ceil(rightNaturalWidth * scale * fontWidthMultiplier);
        }
        if (this.dataset.subscriptionButtonLabel === "true") {
          return Math.ceil(
            (ctaNaturalWidths[this.textContent ?? ""] ?? 150) *
              scale *
              fontWidthMultiplier,
          );
        }
        return 0;
      },
    );

    class ResizeObserverMock {
      readonly instance: ResizeObserverInstance;
      constructor(callback: ResizeObserverCallbackForTest) {
        this.instance = { callback, targets: new Set() };
        resizeObservers.push(this.instance);
      }
      observe = (target: Element) => this.instance.targets.add(target);
      disconnect = () => this.instance.targets.clear();
      unobserve = (target: Element) => this.instance.targets.delete(target);
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

  it("uses a shared 18px size when all three labels fit", async () => {
    await renderLayout();

    const layout = getLayout();
    expect(layout.dataset.compactFontSize).toBe("18");
    expect(layout.style.fontSize).toBe("18px");
    expect(getCtaLabel().style.fontSize).toBe("18px");
    expect(getCtaLabel().style.whiteSpace).toBe("nowrap");
  });

  it("shrinks long translated labels to the same largest fitting size", async () => {
    containerWidth = 600;
    leftNaturalWidth = 140;
    rightNaturalWidth = 130;
    await renderLayout("Long translated CTA", {
      ...subscribeOnlyState,
      language: "de",
    });

    const layout = getLayout();
    const fittedSize = Number.parseFloat(layout.dataset.compactFontSize ?? "0");
    expect(fittedSize).toBeGreaterThan(12);
    expect(fittedSize).toBeLessThan(18);
    expect(layout.style.fontSize).toBe(`${fittedSize}px`);
    expect(getCtaLabel().style.fontSize).toBe(`${fittedSize}px`);
    expect(layout.dataset.compactCtaWrap).toBe("false");
    expect(
      container.querySelector("[data-subscriber-count='true']")?.textContent,
    ).toContain("Abonnenten");
  });

  it("keeps the CTA on one line at the exact 12px fit boundary", async () => {
    containerWidth = 592;
    leftNaturalWidth = 180;
    rightNaturalWidth = 175;
    ctaNaturalWidths["Long translated CTA"] = 360;
    await renderLayout("Long translated CTA");

    const fittedSize = Number.parseFloat(
      getLayout().dataset.compactFontSize ?? "0",
    );
    expect(fittedSize).toBeGreaterThanOrEqual(12);
    expect(fittedSize).toBeLessThan(12.1);
    expect(getLayout().dataset.compactCtaWrap).toBe("false");
    expect(getCtaLabel().style.whiteSpace).toBe("nowrap");
  });

  it("reserves 96px statistics and wraps a CTA that cannot fit at 12px", async () => {
    containerWidth = 600;
    leftNaturalWidth = 300;
    rightNaturalWidth = 280;
    const label = "Extremely long compact call to action requiring wrapping";
    await renderLayout(label, ctaOnlyState);

    const layout = getLayout();
    const ctaLabel = getCtaLabel();
    expect(layout.dataset.compactFontSize).toBe("12");
    expect(layout.dataset.compactCtaWrap).toBe("true");
    expect(layout.style.gridTemplateColumns).toContain("minmax(96px, 1fr)");
    expect(layout.style.gridTemplateColumns).toContain("408px");
    expect(ctaLabel.style.fontSize).toBe("12px");
    expect(ctaLabel.style.whiteSpace).toBe("normal");
    expect(ctaLabel.style.overflowWrap).toBe("anywhere");
    expect(ctaLabel.style.lineHeight).toBe("1.25");
    expect(ctaLabel.textContent).toBe(label);
  });

  it("truncates oversized statistics without wrapping a fitting CTA", async () => {
    containerWidth = 600;
    leftNaturalWidth = 400;
    rightNaturalWidth = 380;
    await renderLayout();

    const layout = getLayout();
    expect(layout.dataset.compactFontSize).toBe("12");
    expect(layout.dataset.compactCtaWrap).toBe("false");
    expect(getCtaLabel().style.whiteSpace).toBe("nowrap");
    expect(
      container.querySelector("[data-subscriber-count='true']")?.className,
    ).toContain("truncate");
    expect(
      container.querySelector("[data-compact-activity='true']")?.className,
    ).toContain("truncate");
  });

  it("grows back to 18px when a narrow desktop embed widens", async () => {
    containerWidth = 600;
    leftNaturalWidth = 140;
    rightNaturalWidth = 130;
    await renderLayout("Long translated CTA");
    expect(Number(getLayout().dataset.compactFontSize)).toBeLessThan(18);

    containerWidth = 900;
    await triggerLayoutResize();
    expect(getLayout().dataset.compactFontSize).toBe("18");
    expect(getCtaLabel().style.fontSize).toBe("18px");
  });

  it("recalculates after a CTA label or loaded font changes", async () => {
    containerWidth = 580;
    await renderLayout();
    expect(getLayout().dataset.compactFontSize).toBe("18");

    await renderLayout("Long translated CTA");
    expect(Number(getLayout().dataset.compactFontSize)).toBeLessThan(18);

    fontWidthMultiplier = 1.25;
    await act(async () => fontLoadingListener?.());
    await flushAnimationFrames();
    expect(Number(getLayout().dataset.compactFontSize)).toBeLessThan(15);
  });

  it("does not schedule measurement when the observed width is unchanged", async () => {
    await renderLayout();
    frameCallbacks.clear();

    await triggerLayoutResize();
    expect(frameCallbacks.size).toBe(0);
  });

  it("leaves narrow mobile and non-SubscriptionButton actions unchanged", async () => {
    hoisted.isWide = false;
    await renderLayout();
    expect(container.querySelector("[data-tiny-wide-layout]")).toBeNull();
    expect(getCtaLabel().style.fontSize).toBe("18px");

    hoisted.isWide = true;
    await act(async () => {
      root.render(
        <TinyActionLayout state={subscribeOnlyState}>
          <button type="button">Sign Up</button>
        </TinyActionLayout>,
      );
    });
    expect(getLayout().dataset.compactFontSize).toBeUndefined();
    expect(getLayout().querySelector("button")?.textContent).toBe("Sign Up");
  });
});
