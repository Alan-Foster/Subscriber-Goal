import { describe, expect, it } from "vitest";
import type { SubscriberGoalState } from "../../../shared/types/api";
import {
  getSecondaryActions,
  getSubscriptionAction,
} from "./subGoalPageActions";

const state: SubscriberGoalState = {
  goal: 500,
  recentSubscriber: null,
  completedTime: null,
  headerText: null,
  colorTheme: "red",
  postHeight: "regular",
  language: "en",
  afterSubscribeAction: {
    type: "link",
    url: "https://example.com",
    buttonText: "Read more",
    colorTheme: "blue",
  },
  subscribed: false,
  moderatorInstallPromoEligible: false,
  canViewStatistics: false,
  user: null,
  appSettings: { promoSubreddit: "SubGoal" },
  subreddit: {
    id: "t5_example",
    name: "ExampleSub",
    icon: "/icon.png",
    subscribers: 123,
    isNsfw: true,
  },
};

describe("getSubscriptionAction", () => {
  it("shows authentication for a logged-out viewer and prioritizes submitting", () => {
    expect(getSubscriptionAction(state, false)).toMatchObject({
      buttonMode: "subscribe",
      showAuthenticationButtons: true,
      afterSubscribeAction: null,
    });
    expect(getSubscriptionAction(state, true)).toMatchObject({
      buttonMode: "submitting",
      showAuthenticationButtons: false,
    });
  });

  it("uses the configured CTA label for a subscriber", () => {
    expect(
      getSubscriptionAction({ ...state, subscribed: true }, false),
    ).toMatchObject({
      buttonMode: "link",
      buttonLabel: "Read more",
      afterSubscribeAction: state.afterSubscribeAction,
      showAuthenticationButtons: false,
    });
  });
});

describe("getSecondaryActions", () => {
  it("uses the configured action for a non-subscriber", () => {
    expect(getSecondaryActions(state, false, false)).toEqual({
      automaticAction: null,
      secondaryAction: state.afterSubscribeAction,
    });
  });

  it("derives a legacy automatic action and respects an explicit opt-out", () => {
    const subscribed = { ...state, subscribed: true };
    expect(getSecondaryActions(subscribed, true, false)).toMatchObject({
      automaticAction: { type: "top-post-day" },
      secondaryAction: state.afterSubscribeAction,
    });
    expect(
      getSecondaryActions(
        { ...subscribed, automaticAfterSubscribeAction: null },
        true,
        false,
      ),
    ).toEqual({
      automaticAction: null,
      secondaryAction: null,
    });
  });

  it("omits the automatic action while submitting or after completion", () => {
    const subscribed = { ...state, subscribed: true };
    expect(
      getSecondaryActions(subscribed, true, true).automaticAction,
    ).toBeNull();
    expect(
      getSecondaryActions(
        { ...subscribed, completedTime: "2026-01-01T00:00:00Z" },
        true,
        false,
      ).automaticAction,
    ).toBeNull();
  });
});
