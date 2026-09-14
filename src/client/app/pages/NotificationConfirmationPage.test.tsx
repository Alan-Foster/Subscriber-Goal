import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SubscriberGoalState } from "../../../shared/types/api";
import { NotificationConfirmationPage } from "./NotificationConfirmationPage";

const state: SubscriberGoalState = {
  goal: 100,
  recentSubscriber: "alice",
  completedTime: null,
  headerText: null,
  colorTheme: "blue",
  postHeight: "regular",
  language: "en",
  afterSubscribeAction: { type: "disabled" },
  subscribed: true,
  user: { id: "t2_user", username: "alice" },
  appSettings: { promoSubreddit: "SubGoal" },
  subreddit: {
    id: "t5_test",
    name: "ExampleSub",
    icon: "/icon.png",
    subscribers: 99,
    isNsfw: false,
  },
};

describe("NotificationConfirmationPage", () => {
  it("preserves the Thanks header and shows notification success", () => {
    const html = renderToStaticMarkup(
      <NotificationConfirmationPage state={state} onVisitPromoSub={vi.fn()} />,
    );

    expect(html).toContain('data-notification-confirmation="true"');
    expect(html).toContain("Thanks for Subscribing!");
    expect(html).toContain("Notifications Enabled!");
    expect(html).toContain("You’ll be notified when the goal is met.");
    expect(html).toContain('data-notification-bell-state="enabled"');
    expect(html).toContain('alt="Subreddit icon"');
    expect(html).toContain("r/SubGoal");
  });

  it("uses the condensed short layout without the subreddit icon", () => {
    const html = renderToStaticMarkup(
      <NotificationConfirmationPage
        state={{ ...state, postHeight: "short" }}
        onVisitPromoSub={vi.fn()}
      />,
    );

    expect(html).toContain("gap-2 py-4");
    expect(html).toContain("Thanks for Subscribing!");
    expect(html).not.toContain('alt="Subreddit icon"');
  });
});
