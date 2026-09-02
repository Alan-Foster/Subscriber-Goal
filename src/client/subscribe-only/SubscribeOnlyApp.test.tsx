// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubscribeOnlyState } from "../../shared/types/api";

const hoisted = vi.hoisted(() => ({
  state: null as SubscribeOnlyState | null,
  subscribe: vi.fn(),
  setError: vi.fn(),
  navigateTo: vi.fn(),
  showToast: vi.fn(),
  prohibited: false,
}));

vi.mock("@devvit/web/client", () => ({
  navigateTo: hoisted.navigateTo,
  showToast: hoisted.showToast,
}));
vi.mock("../hooks/useSubGoal", () => ({
  useSubGoal: () => ({
    state: hoisted.state,
    loading: false,
    submitting: false,
    setError: hoisted.setError,
    subscribe: hoisted.subscribe,
    prohibited: hoisted.prohibited,
  }),
}));

import { tinySubscriptionConfirmationDurationMs } from "../app/components/TinySubscriptionConfirmation";
import { tinySubscriptionConfirmationPhaseDurationMs } from "../app/components/TinySubscriptionConfirmation";
import { tinyViewTransitionDurationMs } from "../app/components/TinyViewTransition";
import { confettiPresets } from "../app/confettiPresets";
import { SubscribeOnlyApp } from "./SubscribeOnlyApp";

const createTinyState = (
  overrides: Partial<SubscribeOnlyState> = {},
): SubscribeOnlyState => ({
  postHeight: "tiny",
  promoSubreddit: "SubGoal",
  colorTheme: "purple",
  language: "en",
  afterSubscribeAction: { type: "disabled" },
  subscribed: true,
  authenticated: true,
  subreddit: {
    name: "ExampleSub",
    subscribers: 123,
    growth: { count: 4, period: "today" },
  },
  ...overrides,
});

describe("SubscribeOnlyApp", () => {
  const mountedRoots: Array<{ container: HTMLDivElement; root: Root }> = [];

  const renderApp = async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ container, root });
    await act(async () => {
      root.render(
        <StrictMode>
          <SubscribeOnlyApp />
        </StrictMode>,
      );
    });
    return container;
  };

  const useWideViewportWithoutReducedMotion = () => {
    window.matchMedia = vi.fn(
      (query: string) =>
        ({
          matches: query === "(min-width: 640px)",
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
  };

  const getActionButton = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(
      "[data-subscription-button-mode] button",
    );

  const getPromoButton = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>(
      'button[aria-label*="r/SubGoal"]',
    );

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    hoisted.state = createTinyState();
    hoisted.prohibited = false;
    hoisted.subscribe.mockResolvedValue({
      state: createTinyState(),
      error: null,
    });
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("renders the prohibited message instead of a skeleton", () => {
    hoisted.state = null;
    hoisted.prohibited = true;

    const html = renderToStaticMarkup(<SubscribeOnlyApp />);

    expect(html).toContain("This content is prohibited");
    expect(html).not.toContain("skeleton");
  });

  afterEach(async () => {
    for (const { container, root } of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
      container.remove();
    }
    vi.useRealTimers();
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("renders the persisted disabled subscribed button immediately", () => {
    const html = renderToStaticMarkup(<SubscribeOnlyApp />);

    expect(html).toContain("h-[100px]");
    expect(html).toContain("sg-goal-frame");
    expect(html).toContain("Subscribed to r/ExampleSub");
    expect(html).not.toContain("Subscribe to r/ExampleSub");
    expect(html).toContain('data-subscription-button-mode="subscribed"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("progress");
    expect(html).not.toContain("r/SubGoal");
  });

  it("renders the persisted Tiny CTA immediately on initial load", () => {
    useWideViewportWithoutReducedMotion();
    hoisted.state = createTinyState({
      afterSubscribeAction: {
        type: "link",
        buttonText: "Visit Website",
        url: "https://example.com/",
        colorTheme: "pink",
      },
    });

    const html = renderToStaticMarkup(<SubscribeOnlyApp />);

    expect(html).toContain("Visit Website");
    expect(html).toContain('data-sg-theme="pink"');
    expect(html).not.toContain("Subscribed to r/ExampleSub");
    expect(html).not.toContain("Return to Previous Page");
    expect(html).toContain("r/SubGoal");
  });

  it("shows light confetti for Tiny background input", async () => {
    useWideViewportWithoutReducedMotion();
    const container = await renderApp();

    await act(async () => {
      container
        .querySelector('[data-app-interaction-shell="true"]')
        ?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });

    expect(
      container
        .querySelector('[data-celebration-effect="confetti"]')
        ?.getAttribute("data-confetti-piece-count"),
    ).toBe("28");
  });

  it("does not show light confetti for Tiny controls", async () => {
    useWideViewportWithoutReducedMotion();
    const container = await renderApp();
    const button = getActionButton(container);

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      button?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail: 0 }),
      );
    });

    expect(
      container.querySelector('[data-celebration-effect="confetti"]'),
    ).toBeNull();
  });

  it("shows confirmation for two seconds before the disabled subscribed button", async () => {
    vi.useFakeTimers();
    useWideViewportWithoutReducedMotion();
    hoisted.state = createTinyState({ subscribed: false });
    const container = await renderApp();

    expect(container.textContent).toContain("123 subscribers");

    await act(async () => {
      getActionButton(container)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(container.textContent).toContain("Subscribe to r/ExampleSub");
    expect(container.textContent).toContain("Subscribed to r/ExampleSub");
    expect(
      container.querySelector('[data-tiny-transition-outgoing="true"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-celebration-effect="confetti"]')
        ?.getAttribute("data-confetti-piece-count"),
    ).toBe("70");

    await act(async () => {
      vi.advanceTimersByTime(tinyViewTransitionDurationMs);
    });
    expect(container.textContent).toContain("Subscribed to r/ExampleSub");
    expect(container.textContent).toContain("r/SubGoal");
    expect(getActionButton(container)).toBeNull();
    expect(getPromoButton(container)).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(
        tinySubscriptionConfirmationPhaseDurationMs -
          tinyViewTransitionDurationMs,
      );
    });
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-subscription-button-mode="subscribed"] button',
      )?.disabled,
    ).toBe(true);
    expect(container.textContent).toContain("Subscribed to r/ExampleSub");
    expect(getPromoButton(container)).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(tinyViewTransitionDurationMs);
    });
    expect(vi.getTimerCount()).toBe(1);
    expect(
      container.querySelector('[data-tiny-transition-outgoing="true"]'),
    ).toBeNull();
    expect(container.textContent).toContain("123 subscribers");
    expect(container.textContent).toContain("4 new today");
    expect(container.textContent).toContain("Subscribed to r/ExampleSub");
    expect(
      tinySubscriptionConfirmationPhaseDurationMs +
        tinyViewTransitionDurationMs,
    ).toBe(tinySubscriptionConfirmationDurationMs);

    await act(async () => {
      vi.advanceTimersByTime(
        confettiPresets.subscribe.durationMs -
          tinySubscriptionConfirmationDurationMs,
      );
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(
      container.querySelector('[data-celebration-effect="confetti"]'),
    ).toBeNull();
  });

  it("shows a localized confirmation before the configured CTA", async () => {
    vi.useFakeTimers();
    useWideViewportWithoutReducedMotion();
    hoisted.state = createTinyState({
      subscribed: false,
      language: "es",
      afterSubscribeAction: {
        type: "link",
        buttonText: "Visitar sitio",
        url: "https://example.com/",
        colorTheme: "pink",
      },
    });
    const container = await renderApp();

    await act(async () => {
      getActionButton(container)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(
      container
        .querySelector('[data-app-interaction-shell="true"]')
        ?.getAttribute("data-sg-theme"),
    ).toBe("purple");
    expect(container.textContent).toContain("Suscrito a r/ExampleSub");
    expect(container.textContent).not.toContain("Visitar sitio");

    await act(async () => {
      vi.advanceTimersByTime(tinyViewTransitionDurationMs);
    });
    expect(container.textContent).toContain("Suscrito a r/ExampleSub");
    expect(container.textContent).toContain("r/SubGoal");
    expect(container.textContent).not.toContain("123 suscriptores");

    await act(async () => {
      vi.advanceTimersByTime(
        tinySubscriptionConfirmationDurationMs - tinyViewTransitionDurationMs,
      );
    });
    const cta = getActionButton(container);
    expect(cta?.textContent).toBe("Visitar sitio");
    expect(container.textContent).toContain("123 suscriptores");
    expect(
      container.querySelector('[data-subscription-button-mode="link"]'),
    ).not.toBeNull();
    expect(container.querySelector(".sg-subscribe-attention")).not.toBeNull();
    expect(
      container
        .querySelector('[data-app-interaction-shell="true"]')
        ?.getAttribute("data-sg-theme"),
    ).toBe("pink");

    await act(async () => {
      cta?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(hoisted.navigateTo).toHaveBeenCalledWith("https://example.com/");
  });

  it("keeps the subscribe button visible when subscription fails", async () => {
    vi.useFakeTimers();
    hoisted.state = createTinyState({ subscribed: false });
    hoisted.subscribe.mockResolvedValue({
      state: null,
      error: "Subscription failed.",
    });
    const container = await renderApp();

    await act(async () => {
      getActionButton(container)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(container.textContent).toBe("Subscribe to r/ExampleSub");
    expect(container.querySelector("button")?.disabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the confirmation timer when unmounted under Strict Mode", async () => {
    vi.useFakeTimers();
    hoisted.state = createTinyState({ subscribed: false });
    const container = await renderApp();

    await act(async () => {
      getActionButton(container)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(vi.getTimerCount()).toBe(3);

    const mounted = mountedRoots.pop();
    await act(async () => mounted?.root.unmount());
    mounted?.container.remove();
    expect(vi.getTimerCount()).toBe(0);
  });
});
