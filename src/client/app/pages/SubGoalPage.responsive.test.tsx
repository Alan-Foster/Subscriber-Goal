// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  SubscribeOnlyState,
  SubscriberGoalState,
} from "../../../shared/types/api";

const hoisted = vi.hoisted(() => ({ isWide: false }));

vi.mock("@devvit/web/client", () => ({ showToast: vi.fn() }));

vi.mock("../../hooks/useWideViewport", () => ({
  useWideViewport: () => hoisted.isWide,
}));

import { SubGoalPage } from "./SubGoalPage";

const createState = (
  overrides: Partial<SubscribeOnlyState> = {},
): SubscribeOnlyState => ({
  colorTheme: "purple",
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
  ...overrides,
});

const commonProps = {
  onSubscribe: vi.fn(),
  onVisitPromoSub: vi.fn(),
  isSubmitting: false,
  shareUsername: false,
  onShareUsernameChange: vi.fn(),
  notice: null,
  onAfterSubscribeNavigate: vi.fn(),
};

describe("SubGoalPage responsive tiny layout", () => {
  it("does not render subscriber data in a narrow viewport", () => {
    hoisted.isWide = false;

    const html = renderToStaticMarkup(
      <SubGoalPage state={createState()} {...commonProps} />,
    );

    expect(html).not.toContain("15.1k subscribers");
    expect(html).not.toContain("3 new today");
    expect(html).not.toContain("data-subscriber-count");
    expect(html).not.toContain("data-subscriber-growth");
    expect(html).not.toContain("data-tiny-wide-layout");
  });

  it("centers the action in a balanced grid with a themed, truncatable count", () => {
    hoisted.isWide = true;

    const html = renderToStaticMarkup(
      <SubGoalPage state={createState()} {...commonProps} />,
    );

    expect(html).toContain("15.1k subscribers");
    expect(html).toContain("3 new today");
    expect(html).toContain('data-tiny-wide-layout="true"');
    expect(html).toContain("grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]");
    expect(html).toContain("text-[color:var(--sg-text-secondary)]");
    expect(html).toContain("block truncate");
    expect(html).toContain('data-sg-theme="purple"');
  });

  it("shows the minimum weekly fallback instead of zero", () => {
    hoisted.isWide = true;

    const html = renderToStaticMarkup(
      <SubGoalPage
        state={createState({
          subreddit: {
            name: "ExampleSub",
            subscribers: 15_100,
            growth: { count: 1, period: "week" },
          },
        })}
        {...commonProps}
      />,
    );

    expect(html).toContain("1 new this week");
  });

  it("retains the count beside subscribed and follow-up actions", () => {
    hoisted.isWide = true;

    const subscribedHtml = renderToStaticMarkup(
      <SubGoalPage
        state={createState({ subscribed: true })}
        {...commonProps}
      />,
    );
    const followUpHtml = renderToStaticMarkup(
      <SubGoalPage
        state={createState({
          subscribed: true,
          afterSubscribeAction: {
            type: "link",
            buttonText: "Visit Website",
            url: "https://example.com/",
            colorTheme: "pink",
          },
        })}
        {...commonProps}
      />,
    );

    expect(subscribedHtml).toContain("15.1k subscribers");
    expect(subscribedHtml).toContain("Joined r/ExampleSub");
    expect(followUpHtml).toContain("15.1k subscribers");
    expect(followUpHtml).toContain("Visit Website");
    expect(followUpHtml).toContain("1 new post this week");
  });

  it("replaces subscriber growth with the configured CTA activity", () => {
    hoisted.isWide = true;
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={createState({
          subscribed: true,
          ctaActivity: { kind: "clicks", count: 4, period: "week" },
          afterSubscribeAction: {
            type: "link",
            buttonText: "Visit Website",
            url: "https://example.com/",
            colorTheme: "blue",
          },
        })}
        {...commonProps}
      />,
    );
    expect(html).toContain("15.1k subscribers");
    expect(html).toContain("4 clicks this week");
    expect(html).not.toContain("3 new today");
  });
});

describe("subscribed classic action layouts", () => {
  const state: SubscriberGoalState = {
    goal: 500,
    recentSubscriber: null,
    completedTime: null,
    headerText: null,
    colorTheme: "red",
    postHeight: "regular",
    language: "en",
    subscribed: true,
    moderatorInstallPromoEligible: false,
    canViewStatistics: false,
    user: { id: "t2_user", username: "alice" },
    appSettings: { promoSubreddit: "SubGoal" },
    subreddit: {
      id: "t5_test",
      name: "ExampleSub",
      icon: "/icon.png",
      subscribers: 123,
      isNsfw: false,
    },
    afterSubscribeAction: {
      type: "top-post-day",
      buttonText: "Featured pick",
      colorTheme: "blue",
    },
  };
  it("reuses the regular column/desktop-row layout with the automatic action second", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <SubGoalPage {...commonProps} state={state} />,
    );
    const area = container.querySelector(
      '[data-subgoal-action-area="two-actions"]',
    )!;
    expect(area.className).toContain("flex-col");
    expect(area.className).toContain("sm:flex-row");
    expect(
      Array.from(area.querySelectorAll("button")).map(
        (button) => button.textContent,
      ),
    ).toEqual(["Featured pick", "View the Most Recent Post"]);
  });
  it("keeps short mobile configured-only while exposing the pair in its desktop branch", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <SubGoalPage
        {...commonProps}
        state={{ ...state, postHeight: "short" }}
      />,
    );
    const desktop = container.querySelector(
      '[data-subgoal-action-area="two-actions"]',
    )!;
    expect(desktop.parentElement?.className).toBe("hidden sm:flex");
    const mobile = container.querySelector(".sm\\:hidden")!;
    expect(
      Array.from(mobile.querySelectorAll("button")).map(
        (button) => button.textContent,
      ),
    ).toEqual(["Featured pick"]);
    expect(desktop.textContent).toContain("View the Most Recent Post");
  });
  it.each([false, true])("keeps Tiny configured-only (wide=%s)", (isWide) => {
    hoisted.isWide = isWide;
    const html = renderToStaticMarkup(
      <SubGoalPage
        {...commonProps}
        state={createState({
          subscribed: true,
          afterSubscribeAction: state.afterSubscribeAction,
        })}
      />,
    );
    expect(html).toContain("Featured pick");
    expect(html).not.toContain("View the Most Recent Post");
    expect(html).not.toContain('data-subgoal-action-area="two-actions"');
  });
});
