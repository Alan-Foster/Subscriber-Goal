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
import { SubscribeOnlyApp } from "./SubscribeOnlyApp";

const createTinyState = (
  overrides: Partial<SubscribeOnlyState> = {},
): SubscribeOnlyState => ({
  postHeight: "tiny",
  colorTheme: "purple",
  language: "en",
  afterSubscribeAction: { type: "disabled" },
  subscribed: true,
  authenticated: true,
  subreddit: { name: "ExampleSub", subscribers: 123 },
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

    expect(html).toContain("Subscribed to r/ExampleSub");
    expect(html).not.toContain("Subscribe to r/ExampleSub");
    expect(html).toContain('data-subscription-button-mode="subscribed"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("progress");
  });

  it("renders the persisted Tiny CTA immediately on initial load", () => {
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
  });

  it("shows confirmation for two seconds before the disabled subscribed button", async () => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: "(min-width: 640px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    hoisted.state = createTinyState({ subscribed: false });
    const container = await renderApp();

    expect(container.textContent).toContain("123 subscribers");

    await act(async () => {
      container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toBe("Subscribed to r/ExampleSub");
    expect(container.querySelector("button")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(tinySubscriptionConfirmationDurationMs - 1);
    });
    expect(container.querySelector("button")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(container.textContent).toContain("123 subscribers");
    expect(container.textContent).toContain("Subscribed to r/ExampleSub");
  });

  it("shows a localized confirmation before the configured CTA", async () => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: "(min-width: 640px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
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
      container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toBe("Suscrito a r/ExampleSub");
    expect(container.textContent).not.toContain("Visitar sitio");
    expect(container.textContent).not.toContain("123 suscriptores");

    await act(async () => {
      vi.advanceTimersByTime(tinySubscriptionConfirmationDurationMs);
    });
    const cta = container.querySelector("button");
    expect(cta?.textContent).toBe("Visitar sitio");
    expect(container.textContent).toContain("123 suscriptores");
    expect(
      container.querySelector('[data-subscription-button-mode="link"]'),
    ).not.toBeNull();
    expect(container.querySelector(".sg-subscribe-attention")).not.toBeNull();

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
      container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
      container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(vi.getTimerCount()).toBe(1);

    const mounted = mountedRoots.pop();
    await act(async () => mounted?.root.unmount());
    mounted?.container.remove();
    expect(vi.getTimerCount()).toBe(0);
  });
});
