import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  CtaOnlyState,
  SubscriberGoalState,
} from "../../../shared/types/api";
import { getNotificationMessages } from "../../../shared/notificationI18n";
import { subGoalLanguages } from "../../../shared/subGoalPostI18n";
import { NotificationSettingsPage } from "./NotificationSettingsPage";

const state: SubscriberGoalState = {
  colorTheme: "green",
  postHeight: "regular",
  language: "en",
  afterSubscribeAction: { type: "disabled" },
  goal: 1_000,
  recentSubscriber: null,
  completedTime: null,
  headerText: null,
  subscribed: false,
  user: { id: "t2_user", username: "alice" },
  appSettings: { promoSubreddit: "SubGoal" },
  subreddit: {
    id: "t5_example",
    name: "ExampleSub",
    icon: "/icon.png",
    subscribers: 900,
    isNsfw: false,
  },
};

const props = {
  authenticated: true,
  enabled: true,
  loading: false,
  submitting: false,
  error: null,
  onToggle: vi.fn(),
  onReturn: vi.fn(),
  onVisitPromoSub: vi.fn(),
};

describe("NotificationSettingsPage", () => {
  it("renders the full enabled management view", () => {
    const html = renderToStaticMarkup(
      <NotificationSettingsPage state={state} {...props} />,
    );
    expect(html).toContain('data-notification-layout="regular"');
    expect(html).toContain("Notification Settings");
    expect(html).toContain("r/ExampleSub");
    expect(html).toContain("Enabled");
    expect(html).toContain("Disable Notifications");
    expect(html).toContain("Return to Previous Page");
    expect(html).toContain('aria-label="Return to previous page"');
    expect(html).toContain("bg-red-600");
    expect(html).not.toContain('alt="Subreddit icon"');
  });

  it("renders the standardized responsive short layout", () => {
    const html = renderToStaticMarkup(
      <NotificationSettingsPage
        state={{ ...state, postHeight: "short" }}
        {...props}
        enabled={false}
      />,
    );
    expect(html).toContain('data-notification-layout="short"');
    expect(html).toContain('data-notification-preference-row="true"');
    expect(html).toContain('data-notification-bell-state="disabled"');
    expect(html).toContain('aria-label="Notifications: Disabled"');
    expect(html).toContain(">Enable</span>");
    expect(html).toContain("bg-green-700");
    expect(html).toContain(">Return</button>");
    expect(html).toContain("text-base");
    expect(html).toContain("flex-col");
    expect(html).toContain("sm:flex-row");
    expect(html).toContain("px-4");
    expect(html).not.toContain("r/ExampleSub");
  });

  it("renders a compact CTA layout without a subreddit icon", () => {
    const compactState: CtaOnlyState = {
      colorTheme: "blue",
      postHeight: "cta",
      promoSubreddit: "SubGoal",
      language: "en",
      afterSubscribeAction: { type: "disabled" },
      subreddit: {
        name: "ExampleSub",
        subscribers: 900,
        growth: { count: 2, period: "today" },
      },
    };
    const html = renderToStaticMarkup(
      <NotificationSettingsPage state={compactState} {...props} />,
    );
    expect(html).toContain('data-notification-layout="compact"');
    expect(html).not.toContain('alt="Subreddit icon"');
    expect(html).toContain('aria-label="Return to previous page"');
    expect(html).toContain('data-notification-bell-state="enabled"');
    expect(html).toContain('aria-label="Notifications: Enabled"');
    expect(html).toContain(">Disable</span>");
    expect(html).toContain("text-base");
    expect(html).toContain('data-notification-stable-slot="state"');
    expect(html).toContain('data-notification-stable-slot="action"');
    expect(html).not.toContain("Return to Previous Page");
  });

  it("disables consent changes for logged-out users", () => {
    const html = renderToStaticMarkup(
      <NotificationSettingsPage
        state={state}
        {...props}
        authenticated={false}
        enabled={false}
      />,
    );
    expect(html).toContain("Please log in to manage notifications.");
    expect(html).toContain("disabled");
  });

  it("keeps compact state visible during loading and signed-out states", () => {
    const compactState: CtaOnlyState = {
      colorTheme: "blue",
      postHeight: "cta",
      promoSubreddit: "SubGoal",
      language: "en",
      afterSubscribeAction: { type: "disabled" },
      subreddit: {
        name: "ExampleSub",
        subscribers: 900,
        growth: { count: 2, period: "today" },
      },
    };
    const loadingHtml = renderToStaticMarkup(
      <NotificationSettingsPage
        state={compactState}
        {...props}
        loading
        enabled={false}
      />,
    );
    expect(loadingHtml).toContain('aria-label="Notifications: …"');
    expect(loadingHtml).toContain(">Enabled</span>");
    expect(loadingHtml).toContain(">Disabled</span>");
    expect(loadingHtml).toContain(">Enable</span>");
    expect(loadingHtml).toContain(">Disable</span>");

    const signedOutHtml = renderToStaticMarkup(
      <NotificationSettingsPage
        state={compactState}
        {...props}
        authenticated={false}
        enabled={false}
      />,
    );
    expect(signedOutHtml).toContain('aria-label="Notifications: Disabled"');
    expect(signedOutHtml).toContain("Please log in to manage notifications.");
  });

  it("keeps compact state visible while showing an error notice", () => {
    const compactState: CtaOnlyState = {
      colorTheme: "blue",
      postHeight: "cta",
      promoSubreddit: "SubGoal",
      language: "en",
      afterSubscribeAction: { type: "disabled" },
      subreddit: {
        name: "ExampleSub",
        subscribers: 900,
        growth: { count: 2, period: "today" },
      },
    };
    const html = renderToStaticMarkup(
      <NotificationSettingsPage
        state={compactState}
        {...props}
        enabled={false}
        error="Notification settings could not be updated."
      />,
    );
    expect(html).toContain('aria-label="Notifications: Disabled"');
    expect(html).toContain("Notification settings could not be updated.");
    expect(html).toContain("text-red-500");
  });

  it("intrinsically reserves state and action space in every language", () => {
    for (const language of subGoalLanguages) {
      const messages = getNotificationMessages(language);
      const html = renderToStaticMarkup(
        <NotificationSettingsPage
          state={{ ...state, postHeight: "short", language }}
          {...props}
          loading
          submitting
          enabled={false}
        />,
      );

      expect(html).toContain('data-notification-stable-slot="state"');
      expect(html).toContain('data-notification-stable-slot="action"');
      expect(html).toContain(messages.enabled);
      expect(html).toContain(messages.disabled);
      expect(html).toContain(messages.enableShort);
      expect(html).toContain(messages.disableShort);
    }
  });
});
