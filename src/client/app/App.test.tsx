// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubGoalState, SubscribeOnlyState } from "../../shared/types/api";

const hoisted = vi.hoisted(() => ({
  createState: () => ({
    goal: 1000,
    recentSubscriber: null,
    completedTime: null,
    headerText: null,
    colorTheme: "red",
    postHeight: "regular",
    language: "en",
    afterSubscribeAction: { type: "disabled" },
    subscribed: false,
    user: { id: "t2_user", username: "alice" },
    appSettings: {
      promoSubreddit: "SubGoal",
    },
    subreddit: {
      id: "t5_test",
      name: "ExampleSub",
      icon: "/icon.png",
      subscribers: 123,
      isNsfw: false,
    },
  }),
  createTinyState: (subscribed = false): SubscribeOnlyState => ({
    colorTheme: "red",
    postHeight: "tiny",
    language: "en",
    afterSubscribeAction: { type: "disabled" },
    subscribed,
    authenticated: true,
    subreddit: { name: "ExampleSub" },
  }),
  state: undefined as unknown as SubGoalState,
  subscribe: vi.fn(),
  setError: vi.fn(),
  showNotice: vi.fn(),
  navigateTo: vi.fn(),
  showToast: vi.fn(),
}));

hoisted.state = hoisted.createState() as SubGoalState;

vi.mock("@devvit/web/client", () => ({
  context: {},
  navigateTo: hoisted.navigateTo,
  showToast: hoisted.showToast,
}));

vi.mock("../hooks/useSubGoal", () => ({
  useSubGoal: () => ({
    state: hoisted.state,
    loading: false,
    submitting: false,
    subscribe: hoisted.subscribe,
    setError: hoisted.setError,
    notice: null,
    showNotice: hoisted.showNotice,
  }),
}));

import { App } from "./App";

describe("App", () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    hoisted.state = hoisted.createState() as SubGoalState;
    hoisted.subscribe.mockResolvedValue({ state: hoisted.state, error: null });
  });

  it("defaults username sharing to enabled on SFW subreddits", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Show my username when I subscribe");
    expect(html).toContain('checked=""');
  });

  it("uses the compact shell height for short posts", () => {
    hoisted.state.postHeight = "short";
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("h-[234px]");
    expect(html).not.toContain('alt="Subreddit icon"');
  });

  it("uses the tiny shell height for tiny posts", () => {
    hoisted.state = hoisted.createTinyState();
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("h-[120px]");
    expect(html).not.toContain('alt="Subreddit icon"');
  });

  it("subscribes without a username payload and renders only the tiny confirmation", async () => {
    hoisted.state = hoisted.createTinyState();
    hoisted.subscribe.mockResolvedValue({
      state: hoisted.createTinyState(true),
      error: null,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    const subscribeButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent === "Subscribe to r/ExampleSub");
    expect(subscribeButton).toBeDefined();

    await act(async () => {
      subscribeButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(hoisted.subscribe).toHaveBeenCalledWith(undefined);
    expect(container.textContent).toContain("Subscribed to r/ExampleSub");
    expect(container.textContent).not.toContain("Return to Previous Page");
    expect(container.textContent).not.toContain("subscribers in the community");
    expect(hoisted.showNotice).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("navigates to the persisted HTTPS CTA after subscription", async () => {
    hoisted.state = {
      ...hoisted.createState(),
      subscribed: true,
      afterSubscribeAction: {
        type: "link",
        buttonText: "Join the Discord",
        url: "https://discord.com/invite/example",
        colorTheme: "pink",
      },
    } as SubGoalState;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });
    const cta = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Join the Discord",
    );
    expect(cta?.getAttribute("data-sg-theme")).toBe("pink");

    await act(async () => {
      cta?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    expect(hoisted.navigateTo).toHaveBeenCalledWith(
      "https://discord.com/invite/example",
    );

    await act(async () => root.unmount());
    container.remove();
  });
});
