import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  SubscriberGoalState,
  SubscribeOnlyState,
} from "../../../shared/types/api";
import { SubGoalPage } from "./SubGoalPage";

const baseState: SubscriberGoalState = {
  goal: 500,
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
};

const tinyState: SubscribeOnlyState = {
  colorTheme: "red",
  postHeight: "tiny",
  language: "en",
  afterSubscribeAction: { type: "disabled" },
  subscribed: false,
  authenticated: true,
  subreddit: { name: "ExampleSub", subscribers: 123 },
};

describe("SubGoalPage", () => {
  const commonProps = {
    onSubscribe: vi.fn(),
    onCelebrate: vi.fn(),
    onVisitPromoSub: vi.fn(),
    isSubmitting: false,
    shareUsername: false,
    onShareUsernameChange: vi.fn(),
    notice: null,
    onAfterSubscribeNavigate: vi.fn(),
  };

  it("shows username share control on non-NSFW subreddits", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage state={baseState} {...commonProps} />,
    );

    expect(html).toContain("Show my username when I subscribe");
  });

  it("renders Spanish post text", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage state={{ ...baseState, language: "es" }} {...commonProps} />,
    );

    expect(html).toContain("Bienvenido a r/ExampleSub");
    expect(html).toContain("Suscribirse a r/ExampleSub");
    expect(html).toContain("Mostrar mi nombre de usuario cuando me suscriba");
  });

  it("renders custom header text when provided", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{ ...baseState, headerText: "This is a Custom Message" }}
        {...commonProps}
      />,
    );

    expect(html).toContain("This is a Custom Message");
    expect(html).not.toContain("Welcome to r/ExampleSub");
  });

  it("hides username share control on NSFW subreddits", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{
          ...baseState,
          subreddit: { ...baseState.subreddit, isNsfw: true },
        }}
        {...commonProps}
      />,
    );

    expect(html).not.toContain("Show my username when I subscribe");
  });

  it("adds attention glow when subscribe button is actionable", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage state={baseState} {...commonProps} />,
    );

    expect(html).toContain("sg-subscribe-attention");
  });

  it("renders the selected color theme", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{ ...baseState, colorTheme: "purple" }}
        {...commonProps}
      />,
    );

    expect(html).toContain('data-sg-theme="purple"');
  });

  it("hides the subreddit logo for short posts", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{ ...baseState, postHeight: "short" }}
        {...commonProps}
      />,
    );

    expect(html).not.toContain('alt="Subreddit icon"');
    expect(html).toContain("gap-6 px-4 py-6");
    expect(html.match(/h-4/g)).toHaveLength(3);
    expect(html).not.toContain("max-sm:pt-8");
    expect(html).toContain("Welcome to r/ExampleSub");
    expect(html).toContain("Subscribe to r/ExampleSub");
  });

  it("renders only the centered subscribe experience for unsubscribed tiny posts", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={tinyState}
        {...commonProps}
        notice="u/alice just subscribed!"
      />,
    );

    expect(html).toContain("Subscribe to r/ExampleSub");
    expect(html).not.toContain('alt="Subreddit icon"');
    expect(html).not.toContain("Welcome to r/ExampleSub");
    expect(html).not.toContain("123 / 500");
    expect(html).not.toContain("u/alice just subscribed!");
    expect(html).not.toContain("Show my username when I subscribe");
    expect(html).toContain("sg-subscribe-attention");
    expect(html).toContain('data-subscription-button-mode="subscribe"');
  });

  it("keeps the tiny page free of subscriber data", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{ ...tinyState, subscribed: true }}
        {...commonProps}
      />,
    );

    expect(html).toContain("Subscribed to r/ExampleSub");
    expect(html).not.toContain("subscribers");
    expect(html).toContain('disabled=""');
  });

  it("does not add attention glow after subscribing", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{ ...baseState, subscribed: true }}
        {...commonProps}
      />,
    );

    expect(html).not.toContain("sg-subscribe-attention");
  });

  it("renders the configured subscribed CTA with its secondary theme and shared attention glow", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{
          ...baseState,
          subscribed: true,
          afterSubscribeAction: {
            type: "link",
            buttonText: "Join the Discord",
            url: "https://discord.com/invite/example",
            colorTheme: "pink",
          },
        }}
        {...commonProps}
      />,
    );

    expect(html).toContain("Join the Discord");
    expect(html).toContain('data-sg-theme="pink"');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("sg-subscribe-attention");
  });

  it("never shows the follow-up CTA to an unsubscribed viewer", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{
          ...baseState,
          afterSubscribeAction: {
            type: "link",
            buttonText: "Join the Discord",
            url: "https://discord.com/invite/example",
            colorTheme: "pink",
          },
        }}
        {...commonProps}
      />,
    );

    expect(html).toContain("Subscribe to r/ExampleSub");
    expect(html).not.toContain("Join the Discord");
  });

  it("does not add attention glow while submitting", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage state={baseState} {...commonProps} isSubmitting />,
    );

    expect(html).not.toContain("sg-subscribe-attention");
  });
});
