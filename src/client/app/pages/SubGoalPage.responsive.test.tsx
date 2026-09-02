// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SubscribeOnlyState } from "../../../shared/types/api";

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
    expect(subscribedHtml).toContain("Subscribed to r/ExampleSub");
    expect(followUpHtml).toContain("15.1k subscribers");
    expect(followUpHtml).toContain("Visit Website");
  });
});
