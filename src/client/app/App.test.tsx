// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    promoSubreddit: "SubGoal",
    language: "en",
    afterSubscribeAction: { type: "disabled" },
    subscribed,
    authenticated: true,
    subreddit: {
      name: "ExampleSub",
      subscribers: 123,
      growth: { count: 4, period: "today" },
    },
  }),
  state: undefined as unknown as SubGoalState,
  subscribe: vi.fn(),
  setError: vi.fn(),
  showNotice: vi.fn(),
  navigateTo: vi.fn(),
  showToast: vi.fn(),
  prohibited: false,
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
    prohibited: hoisted.prohibited,
  }),
}));

import { App } from "./App";

describe("App", () => {
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

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    hoisted.state = hoisted.createState() as SubGoalState;
    hoisted.prohibited = false;
    hoisted.subscribe.mockResolvedValue({ state: hoisted.state, error: null });
    Reflect.deleteProperty(window, "matchMedia");
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("renders the prohibited message instead of post content", () => {
    hoisted.state = null as unknown as SubGoalState;
    hoisted.prohibited = true;

    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("This content is prohibited");
    expect(html).not.toContain("Unable to load Subscriber Goal data.");
  });

  it("defaults username sharing to enabled on SFW subreddits", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Show my username when I subscribe");
    expect(html).toContain('checked=""');
    expect(html).toContain("sg-goal-frame");
    expect(html).toContain('data-sg-theme="red"');
  });

  it("uses the compact shell height for short posts", () => {
    hoisted.state.postHeight = "short";
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("h-[234px]");
    expect(html).toContain("sg-goal-frame");
    expect(html).not.toContain('alt="Subreddit icon"');
  });

  it("uses the tiny shell height for tiny posts", () => {
    hoisted.state = hoisted.createTinyState();
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("h-[100px]");
    expect(html).toContain("sg-goal-frame");
    expect(html).not.toContain('alt="Subreddit icon"');
  });

  it("shows light confetti for background pointer input", async () => {
    useWideViewportWithoutReducedMotion();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<App />));
    const shell = container.querySelector<HTMLElement>(
      '[data-app-interaction-shell="true"]',
    );
    await act(async () => {
      shell?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });

    expect(
      container
        .querySelector('[data-celebration-effect="confetti"]')
        ?.getAttribute("data-confetti-piece-count"),
    ).toBe("28");
    expect(container.querySelectorAll(".confetti-piece")).toHaveLength(28);

    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps staggered light effects on independent timelines", async () => {
    vi.useFakeTimers();
    useWideViewportWithoutReducedMotion();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<App />));
    const shell = container.querySelector(
      '[data-app-interaction-shell="true"]',
    );
    await act(async () => {
      shell?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      vi.advanceTimersByTime(1000);
      shell?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(
      container.querySelectorAll('[data-celebration-effect="confetti"]'),
    ).toHaveLength(2);
    expect(container.querySelectorAll(".confetti-piece")).toHaveLength(56);

    await act(async () => vi.advanceTimersByTime(600));
    expect(
      container.querySelectorAll('[data-celebration-effect="confetti"]'),
    ).toHaveLength(1);
    expect(container.querySelectorAll(".confetti-piece")).toHaveLength(28);

    await act(async () => vi.advanceTimersByTime(1000));
    expect(
      container.querySelector('[data-celebration-effect="confetti"]'),
    ).toBeNull();

    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("does not show light confetti for interactive controls", async () => {
    useWideViewportWithoutReducedMotion();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<App />));
    const shell = container.querySelector<HTMLElement>(
      '[data-app-interaction-shell="true"]',
    );
    const disabledButton = document.createElement("button");
    disabledButton.disabled = true;
    const nestedButtonContent = document.createElement("span");
    disabledButton.append(nestedButtonContent);
    const link = document.createElement("a");
    link.href = "https://example.com/";
    link.addEventListener("click", (event) => event.preventDefault());
    const roleButton = document.createElement("div");
    roleButton.setAttribute("role", "button");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const markedControl = document.createElement("div");
    markedControl.dataset.celebrationInteractive = "true";
    const controls = [
      disabledButton,
      document.createElement("button"),
      link,
      document.createElement("input"),
      document.createElement("select"),
      document.createElement("textarea"),
      document.createElement("label"),
      roleButton,
      editable,
      markedControl,
    ];
    controls.forEach((control) => shell?.append(control));

    const subredditIcon = container.querySelector(
      'img[alt="Subreddit icon"][data-celebration-interactive="true"]',
    );

    for (const target of [...controls, nestedButtonContent]) {
      await act(async () => {
        target?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        target?.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            detail: 0,
          }),
        );
      });
      expect(
        container.querySelector('[data-celebration-effect="confetti"]'),
      ).toBeNull();
    }

    await act(async () => {
      subredditIcon?.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(
      container.querySelector('[data-celebration-effect="confetti"]'),
    ).toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it("shows light confetti for a keyboard background click", async () => {
    useWideViewportWithoutReducedMotion();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<App />));
    await act(async () => {
      container
        .querySelector('[data-app-interaction-shell="true"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    });
    expect(container.querySelectorAll(".confetti-piece")).toHaveLength(28);

    await act(async () => root.unmount());
    container.remove();
  });

  it("uses a static accent flash when reduced motion is requested", async () => {
    window.matchMedia = vi.fn(
      (query: string) =>
        ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<App />));
    await act(async () => {
      const shell = container.querySelector(
        '[data-app-interaction-shell="true"]',
      );
      shell?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      shell?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });

    expect(
      container.querySelectorAll('[data-celebration-effect="flash"]'),
    ).toHaveLength(2);
    expect(container.querySelector(".confetti-piece")).toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it.each(["regular", "short"] as const)(
    "shows continuous ambient confetti on an already-completed %s goal",
    async (postHeight) => {
      useWideViewportWithoutReducedMotion();
      hoisted.state = {
        ...hoisted.createState(),
        postHeight,
        completedTime: Date.now(),
        subscribed: true,
        afterSubscribeAction: {
          type: "link",
          buttonText: "Join the Discord",
          url: "https://discord.com/invite/example",
          colorTheme: "blue",
        },
      } as SubGoalState;
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);

      await act(async () => root.render(<App />));

      expect(container.textContent).toContain("reached 1000 subscribers");
      expect(
        container
          .querySelector('[data-celebration-effect="ambient-confetti"]')
          ?.getAttribute("data-confetti-piece-count"),
      ).toBe("30");
      expect(
        container.querySelectorAll(".ambient-confetti-piece"),
      ).toHaveLength(30);
      expect(
        container.querySelector('[data-celebration-effect="confetti"]'),
      ).toBeNull();
      expect(
        container
          .querySelector('[data-app-interaction-shell="true"]')
          ?.getAttribute("data-sg-theme"),
      ).toBe("red");

      await act(async () => root.unmount());
      container.remove();
    },
  );

  it("keeps active click feedback when continuous completion confetti starts", async () => {
    useWideViewportWithoutReducedMotion();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<App />));
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

    hoisted.state = {
      ...hoisted.createState(),
      completedTime: Date.now(),
    } as SubGoalState;
    await act(async () => root.render(<App />));
    expect(
      Array.from(
        container.querySelectorAll('[data-celebration-effect="confetti"]'),
      ).map((effect) => effect.getAttribute("data-confetti-piece-count")),
    ).toEqual(["28"]);
    expect(container.querySelectorAll(".confetti-piece")).toHaveLength(28);
    expect(container.querySelectorAll(".ambient-confetti-piece")).toHaveLength(
      30,
    );

    await act(async () => root.unmount());
    container.remove();
  });

  it("does not duplicate ambient confetti during completed-state refreshes", async () => {
    useWideViewportWithoutReducedMotion();
    const completedTime = Date.now();
    hoisted.state = {
      ...hoisted.createState(),
      completedTime,
    } as SubGoalState;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<App />));
    hoisted.state = { ...hoisted.state } as SubGoalState;
    await act(async () => root.render(<App />));

    expect(
      container.querySelectorAll(
        '[data-celebration-effect="ambient-confetti"]',
      ),
    ).toHaveLength(1);
    expect(container.querySelectorAll(".ambient-confetti-piece")).toHaveLength(
      30,
    );

    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps the Subscribe burst when a subscription completes the goal", async () => {
    useWideViewportWithoutReducedMotion();
    const completedState = {
      ...hoisted.createState(),
      completedTime: Date.now(),
      subscribed: true,
      subreddit: {
        ...hoisted.createState().subreddit,
        subscribers: 1000,
      },
    } as SubGoalState;
    hoisted.subscribe.mockResolvedValue({
      state: completedState,
      error: null,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<App />));
    const subscribeButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent === "Subscribe to r/ExampleSub");
    await act(async () => {
      subscribeButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(
      container
        .querySelector('[data-celebration-effect="confetti"]')
        ?.getAttribute("data-confetti-piece-count"),
    ).toBe("70");
    expect(container.querySelectorAll(".ambient-confetti-piece")).toHaveLength(
      30,
    );

    await act(async () => root.unmount());
    container.remove();
  });

  it("does not show ambient completion confetti for reduced motion", async () => {
    window.matchMedia = vi.fn(
      (query: string) =>
        ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    hoisted.state = {
      ...hoisted.createState(),
      completedTime: Date.now(),
    } as SubGoalState;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<App />));

    expect(
      container.querySelector('[data-celebration-effect="ambient-confetti"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-celebration-effect="flash"]'),
    ).toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it("subscribes without a username payload and renders only the tiny confirmation", async () => {
    useWideViewportWithoutReducedMotion();
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

    expect(container.textContent).toContain("r/SubGoal");

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
    expect(container.textContent).toContain("r/SubGoal");
    expect(
      container.querySelector('button[aria-label*="r/SubGoal"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Return to Previous Page");
    expect(container.textContent).not.toContain("subscribers in the community");
    expect(hoisted.showNotice).not.toHaveBeenCalled();
    expect(
      container
        .querySelector('[data-celebration-effect="confetti"]')
        ?.getAttribute("data-confetti-piece-count"),
    ).toBe("70");

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
    expect(
      container
        .querySelector('[data-app-interaction-shell="true"]')
        ?.getAttribute("data-sg-theme"),
    ).toBe("pink");

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
