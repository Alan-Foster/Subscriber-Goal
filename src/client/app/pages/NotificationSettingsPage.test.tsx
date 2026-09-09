import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  CtaOnlyState,
  SubscriberGoalState,
} from "../../../shared/types/api";
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
    expect(html).toContain("bg-red-600");
    expect(html).not.toContain('alt="Subreddit icon"');
    expect(html).not.toContain("absolute left-4 top-4");
  });

  it("renders the short horizontal layout", () => {
    const html = renderToStaticMarkup(
      <NotificationSettingsPage
        state={{ ...state, postHeight: "short" }}
        {...props}
        enabled={false}
      />,
    );
    expect(html).toContain('data-notification-layout="short"');
    expect(html).toContain("Disabled");
    expect(html).toContain("Enable Notifications");
    expect(html).toContain("bg-green-700");
    expect(html).toContain(">Return</button>");
    expect(html).not.toContain("max-w-32");
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
    expect(html).toContain("Notifications");
    expect(html).toContain(">Disable</button>");
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
});
