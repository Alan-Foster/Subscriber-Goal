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
  moderatorInstallPromoEligible: false,
  canViewStatistics: false,
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
  promoSubreddit: "SubGoal",
  language: "en",
  afterSubscribeAction: { type: "disabled" },
  subscribed: false,
  authenticated: true,
  subreddit: {
    name: "ExampleSub",
    subscribers: 123,
    growth: { count: 4, period: "today" },
  },
};

describe("SubGoalPage", () => {
  const commonProps = {
    onSubscribe: vi.fn(),
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

    expect(html).toContain("Show my username when I join");
    expect(html).toContain("sg-hover-grow h-3 w-3");
    expect(html).toContain('<span class="sg-hover-grow">');
  });

  it.each(["regular", "short"] as const)(
    "renders localized authentication buttons for logged-out %s goals",
    (postHeight) => {
      const html = renderToStaticMarkup(
        <SubGoalPage
          state={{ ...baseState, postHeight, user: null }}
          {...commonProps}
        />,
      );

      expect(html).toContain("Sign Up");
      expect(html).toContain("Log In");
      expect(html).toContain('data-logged-out-auth-buttons="true"');
      expect(html).not.toContain('data-subscription-button-mode="subscribe"');
    },
  );

  it("renders logged-out authentication buttons for tiny goals", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{ ...tinyState, authenticated: false }}
        {...commonProps}
      />,
    );

    expect(html).toContain("Sign Up");
    expect(html).toContain("Log In");
    expect(html).not.toContain('viewBox="0 0 20 20"');
  });

  it("makes only regular goal titles and progress bars accessible subscription controls", () => {
    const regularHtml = renderToStaticMarkup(
      <SubGoalPage state={baseState} {...commonProps} />,
    );
    const tinyHtml = renderToStaticMarkup(
      <SubGoalPage state={tinyState} {...commonProps} />,
    );

    expect(regularHtml).toContain("Join r/ExampleSub using the progress bar");
    expect(regularHtml).toContain('role="progressbar"');
    expect(regularHtml).toContain('aria-valuenow="123"');
    expect(regularHtml).toContain("r/ExampleSub</span>");
    expect(regularHtml).toContain('data-subgoal-header-group="true"');
    expect(tinyHtml).not.toContain('role="progressbar"');
  });

  it("renders complete progress text from emergency recovered state", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{
          ...baseState,
          goal: 75,
          subreddit: { ...baseState.subreddit, subscribers: 74 },
        }}
        {...commonProps}
      />,
    );

    expect(html).toContain('aria-valuenow="74"');
    expect(html).toContain('aria-valuemax="75"');
    expect(html).toContain("74 / 75");
  });

  it("renders Spanish post text", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage state={{ ...baseState, language: "es" }} {...commonProps} />,
    );

    expect(html).toContain("r/ExampleSub");
    expect(html).toContain("Unirse a r/ExampleSub");
    expect(html).toContain("Mostrar mi nombre de usuario cuando me una");
  });

  it("renders Hindi post text", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage state={{ ...baseState, language: "hi" }} {...commonProps} />,
    );

    expect(html).toContain("r/ExampleSub");
    expect(html).toContain("r/ExampleSub में शामिल हों");
    expect(html).toContain("शामिल होते समय मेरा यूज़रनेम दिखाएँ");
  });

  it("renders Punjabi regular post text", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage state={{ ...baseState, language: "pa" }} {...commonProps} />,
    );

    expect(html).toContain("r/ExampleSub");
    expect(html).toContain("r/ExampleSub ਵਿੱਚ ਸ਼ਾਮਲ ਹੋਵੋ");
    expect(html).toContain("ਸ਼ਾਮਲ ਹੋਣ ਵੇਲੇ ਮੇਰਾ ਯੂਜ਼ਰਨੇਮ ਦਿਖਾਓ");
  });

  it("renders Marathi short post text", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{ ...baseState, language: "mr", postHeight: "short" }}
        {...commonProps}
      />,
    );

    expect(html).toContain("r/ExampleSub");
    expect(html).toContain("r/ExampleSub मध्ये सामील व्हा");
    expect(html).toContain('alt="Subreddit icon"');
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

  it("crossfades the centered header while showing a join notice", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={baseState}
        {...commonProps}
        notice="u/alice just joined!"
      />,
    );

    expect(html).toContain("u/alice just joined!");
    expect(html).toContain("duration-500");
    expect(html).not.toContain("translate-x-");
    expect(html).toContain("motion-reduce:transition-none");
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

    expect(html).not.toContain("Show my username when I join");
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

  it("keeps the subreddit logo in the compact short header", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{ ...baseState, postHeight: "short" }}
        {...commonProps}
      />,
    );

    expect(html).toContain('alt="Subreddit icon"');
    expect(html).toContain("gap-6 px-4 py-6");
    expect(html).toContain("width:40px;height:40px");
    expect(html).toContain("gap-2.5");
    expect(html).toContain("r/ExampleSub");
    expect(html).toContain("w-full pt-12");
    expect(html).toContain("Join r/ExampleSub");
  });

  it("reduces the desktop header top offset when the username share control is shown", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage state={baseState} {...commonProps} />,
    );

    expect(html).toContain('class="w-full pt-12 sm:pt-4"');
  });

  it("renders only the centered subscribe experience for unsubscribed tiny posts", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={tinyState}
        {...commonProps}
        notice="u/alice just joined!"
      />,
    );

    expect(html).toContain("Join r/ExampleSub");
    expect(html).not.toContain('alt="Subreddit icon"');
    expect(html).not.toContain("Welcome to r/ExampleSub");
    expect(html).not.toContain("123 / 500");
    expect(html).not.toContain("u/alice just joined!");
    expect(html).not.toContain("Show my username when I join");
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

    expect(html).toContain("Joined r/ExampleSub");
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

    expect(html).toContain("Join r/ExampleSub");
    expect(html).toContain("Join the Discord");
    expect(html).toContain("gap-6 px-4 py-6");
    expect(html).toContain('data-subgoal-action-area="two-actions"');
    expect(html).toContain(
      "flex-col items-center justify-center gap-5 sm:flex-row sm:gap-6",
    );
    expect(html).toContain("[&amp;&gt;.sg-attention-host]:min-w-0");
    expect(html).toContain("[&amp;&gt;.sg-attention-host&gt;button]:min-w-0");
  });

  it("shows compact short goals' second action only at desktop widths", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{
          ...baseState,
          postHeight: "short",
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

    expect(html).toContain("Join r/ExampleSub");
    expect(html).toContain("Join the Discord");
    expect(html).toContain('class="sm:hidden"');
    expect(html).toContain('class="hidden sm:flex"');
    expect(html).toContain('data-subgoal-action-area="two-actions"');
  });

  it("replaces Join with an automatic action after a viewer has joined", () => {
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
    expect(html).not.toContain('data-subscription-button-mode="subscribe"');
    expect(html).toContain('data-subgoal-action-area="two-actions"');
    expect(html.indexOf("Join the Discord")).toBeLessThan(
      html.indexOf("View the Top Post Today"),
    );
  });

  it.each(["regular", "short"] as const)(
    "shows a configured-first pair on subscribed %s reload",
    (postHeight) => {
      const html = renderToStaticMarkup(
        <SubGoalPage
          {...commonProps}
          state={{
            ...baseState,
            postHeight,
            subscribed: true,
            afterSubscribeAction: {
              type: "top-post-day",
              buttonText: "Featured pick",
              colorTheme: "blue",
            },
          }}
        />,
      );
      expect(html).toContain('data-subgoal-action-area="two-actions"');
      expect(html.indexOf("Featured pick")).toBeLessThan(
        html.indexOf("View the Most Recent Post"),
      );
      expect(html).toContain('data-sg-theme="green"');
      expect(html).not.toContain('data-subscription-button-mode="subscribe"');
    },
  );

  it.each(["logged out", "unconfirmed", "submitting", "completed"])(
    "does not add an automatic action for %s",
    (reason) => {
      const state = {
        ...baseState,
        subscribed: reason !== "unconfirmed",
        user: reason === "logged out" ? null : baseState.user,
        completedTime: reason === "completed" ? 1_000 : null,
        afterSubscribeAction: {
          type: "top-post-day" as const,
          buttonText: "Featured pick",
          colorTheme: "blue" as const,
        },
      };
      const html = renderToStaticMarkup(
        <SubGoalPage
          {...commonProps}
          state={state}
          isSubmitting={reason === "submitting"}
        />,
      );
      expect(html).not.toContain("View the Most Recent Post");
    },
  );

  it.each([
    { community: "NSFW communities", nsfw: true },
    { community: "communities with unknown safety", nsfw: undefined },
  ])("shows the automatic second button in $community", ({ nsfw }) => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        {...commonProps}
        state={{
          ...baseState,
          subscribed: true,
          subreddit: {
            ...baseState.subreddit,
            isNsfw: nsfw as boolean,
          },
          afterSubscribeAction: {
            type: "top-post-day",
            buttonText: "Featured pick",
            colorTheme: "green",
          },
        }}
      />,
    );
    expect(html).toContain('data-subgoal-action-area="two-actions"');
    expect(html).toContain("Featured pick");
    expect(html).toContain("View the Most Recent Post");
    expect(html).toContain('data-sg-theme="blue"');
  });

  it.each([false, true])(
    "renders the effective NSFW pair when subscribed is %s",
    (subscribed) => {
      const html = renderToStaticMarkup(
        <SubGoalPage
          {...commonProps}
          state={{
            ...baseState,
            subscribed,
            subreddit: { ...baseState.subreddit, isNsfw: true },
            afterSubscribeAction: {
              type: "newest-post",
              buttonText: "View the Most Recent Post",
              colorTheme: "blue",
            },
            automaticAfterSubscribeAction: {
              type: "link",
              buttonText: "Create a New Post",
              url: "https://www.reddit.com/r/ExampleSub/submit/",
              colorTheme: "green",
            },
          }}
        />,
      );
      expect(html).toContain('data-subgoal-action-area="two-actions"');
      expect(html).toContain("View the Most Recent Post");
      if (subscribed) {
        expect(html).toContain("Create a New Post");
      } else {
        expect(html).toContain('data-subscription-button-mode="subscribe"');
        expect(html).not.toContain("Create a New Post");
      }
    },
  );

  it("does not add attention glow while submitting", () => {
    const html = renderToStaticMarkup(
      <SubGoalPage state={baseState} {...commonProps} isSubmitting />,
    );

    expect(html).not.toContain("sg-subscribe-attention");
  });
});
