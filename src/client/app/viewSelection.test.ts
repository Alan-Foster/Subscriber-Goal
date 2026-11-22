import { describe, expect, it } from "vitest";
import type {
  CtaOnlyState,
  SubscribeOnlyState,
  SubscriberGoalState,
} from "../../shared/types/api";
import {
  getGoalFrameColor,
  getGoalFrameHeight,
  selectGoalView,
  selectSubscribeOnlyPhase,
  type PageName,
} from "./viewSelection";

const action = {
  type: "link",
  buttonText: "Visit",
  colorTheme: "blue",
  url: "https://example.com/",
} as const;

const compact: CtaOnlyState = {
  postHeight: "cta",
  colorTheme: "red",
  language: "en",
  promoSubreddit: "SubGoal",
  subreddit: {
    name: "Example",
    subscribers: 10,
    growth: { count: 1, period: "today" },
  },
  afterSubscribeAction: action,
};
const tiny: SubscribeOnlyState = {
  ...compact,
  postHeight: "tiny",
  subscribed: true,
  authenticated: true,
};
const regular: SubscriberGoalState = {
  postHeight: "regular",
  colorTheme: "red",
  language: "en",
  afterSubscribeAction: action,
  subreddit: {
    id: "t5_example",
    name: "Example",
    subscribers: 10,
    isNsfw: false,
    icon: "",
  },
  appSettings: { promoSubreddit: "SubGoal" },
  subscribed: true,
  moderatorInstallPromoEligible: false,
  canViewStatistics: true,
  goal: 20,
  completedTime: null,
  recentSubscriber: null,
  headerText: null,
  user: null,
};

describe("goal view selection", () => {
  it.each([
    ["statistics", tiny, "statistics"],
    ["notifications", compact, "notifications"],
    ["thanks", compact, "cta"],
    ["tinyConfirmation", tiny, "tinyConfirmation"],
    ["completed", tiny, "subGoal"],
    ["notificationConfirmation", tiny, "subGoal"],
    ["thanks", tiny, "thanks"],
    ["tinyConfirmation", regular, "subGoal"],
    ["completed", { ...regular, postHeight: "short" }, "completed"],
    ["notificationConfirmation", regular, "notificationConfirmation"],
  ] as const)("selects %s for %j", (page, state, expected) => {
    expect(selectGoalView(page, state)).toMatchObject({
      page: expected,
      state,
    });
  });

  it("falls back for missing state or a disabled CTA", () => {
    const disabled = {
      ...compact,
      afterSubscribeAction: { type: "disabled" },
    } as const;
    expect(selectGoalView("subGoal", null)).toBeNull();
    expect(selectGoalView("subGoal", disabled)).toBeNull();
    expect(selectGoalView("notifications", disabled)?.page).toBe(
      "notifications",
    );
  });
});

describe("goal frame selection", () => {
  it.each([
    ["subGoal", regular, false, "blue"],
    ["statistics", regular, false, "blue"],
    ["completed", regular, false, "red"],
    ["notificationConfirmation", regular, false, "red"],
    ["thanks", regular, false, "blue"],
    ["thanks", regular, true, "red"],
    ["tinyConfirmation", tiny, false, "red"],
    ["completed", compact, false, "blue"],
    ["notifications", compact, false, "red"],
    ["subGoal", { ...regular, subscribed: false }, false, "red"],
    ["subGoal", null, false, undefined],
  ] as const)(
    "selects the frame color for %s",
    (page: PageName, state, enabled, expected) => {
      expect(getGoalFrameColor(page, state, enabled)).toBe(expected);
    },
  );

  it.each([
    ["tiny", "h-[100px]"],
    ["cta", "h-[100px]"],
    ["short", "h-[234px]"],
    ["regular", "h-[320px]"],
    [undefined, "h-[320px]"],
  ] as const)("selects the frame height for %s", (height, expected) => {
    expect(getGoalFrameHeight(height)).toBe(expected);
  });
});

describe("subscribe-only phases", () => {
  it.each([
    ["subscribe", true, false, "subscribed"],
    ["subscribe", true, true, "subscribe"],
    ["subscribe", false, false, "subscribe"],
    ["confirmation", true, false, "confirmation"],
    ["subscribed", false, true, "subscribed"],
    ["notifications", true, true, "notifications"],
  ] as const)(
    "resolves %s with subscribed=%s and interactionStarted=%s",
    (phase, subscribed, interactionStarted, expected) => {
      expect(
        selectSubscribeOnlyPhase(phase, subscribed, interactionStarted),
      ).toBe(expected);
    },
  );
});
