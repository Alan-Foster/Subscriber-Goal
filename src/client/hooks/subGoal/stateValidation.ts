import type {
  InitResponse,
  RefreshResponse,
  SubGoalState,
  SubscribeResponse,
} from "../../../shared/types/api";

import { subGoalLanguages } from "../../../shared/subGoalPostI18n";
import { isSubGoalColorTheme } from "../../../shared/subGoalColorTheme";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNullableFiniteNumber = (value: unknown): boolean =>
  value === null || isFiniteNumber(value);

const isNullableString = (value: unknown): boolean =>
  value === null || typeof value === "string";

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.length > 0
    );
  } catch {
    // diagnostic-allow-silent: URL parsing is an expected validation probe.
    return false;
  }
};

const isAfterSubscribeAction = (value: unknown): boolean => {
  if (!isObject(value) || typeof value.type !== "string") return false;
  if (value.type === "disabled") return true;
  if (
    value.type !== "link" &&
    value.type !== "top-post-day" &&
    value.type !== "newest-post"
  ) {
    return false;
  }
  if (
    typeof value.buttonText !== "string" ||
    value.buttonText.length === 0 ||
    !isSubGoalColorTheme(value.colorTheme)
  ) {
    return false;
  }
  return value.type !== "link" || isHttpUrl(value.url);
};

const isCtaActivity = (value: unknown): boolean =>
  isObject(value) &&
  (value.kind === "posts" || value.kind === "clicks") &&
  isFiniteNumber(value.count) &&
  value.count >= 0 &&
  (value.period === "today" || value.period === "week");

const isCompactSubreddit = (value: unknown): boolean =>
  isObject(value) &&
  typeof value.name === "string" &&
  value.name.length > 0 &&
  isFiniteNumber(value.subscribers) &&
  value.subscribers >= 0 &&
  isObject(value.growth) &&
  isFiniteNumber(value.growth.count) &&
  (value.growth.period === "today" || value.growth.period === "week");

const hasValidSharedState = (value: Record<string, unknown>): boolean =>
  isSubGoalColorTheme(value.colorTheme) &&
  subGoalLanguages.includes(
    value.language as (typeof subGoalLanguages)[number],
  ) &&
  isAfterSubscribeAction(value.afterSubscribeAction) &&
  (value.trackCtaClicks === undefined ||
    typeof value.trackCtaClicks === "boolean");

function hasValidCompactState(value: Record<string, unknown>): boolean {
  return (
    typeof value.promoSubreddit === "string" &&
    value.promoSubreddit.length > 0 &&
    isCompactSubreddit(value.subreddit) &&
    (value.ctaActivity === undefined || isCtaActivity(value.ctaActivity)) &&
    (value.postHeight === "cta" ||
      (typeof value.subscribed === "boolean" &&
        typeof value.authenticated === "boolean"))
  );
}

function isRegularSubreddit(subreddit: unknown): boolean {
  return (
    isObject(subreddit) &&
    typeof subreddit.id === "string" &&
    subreddit.id.length > 0 &&
    typeof subreddit.name === "string" &&
    subreddit.name.length > 0 &&
    typeof subreddit.icon === "string" &&
    isFiniteNumber(subreddit.subscribers) &&
    subreddit.subscribers >= 0 &&
    typeof subreddit.isNsfw === "boolean"
  );
}

function hasRegularGoalFields(value: Record<string, unknown>): boolean {
  return (
    (value.automaticAfterSubscribeAction === undefined ||
      value.automaticAfterSubscribeAction === null ||
      isAfterSubscribeAction(value.automaticAfterSubscribeAction)) &&
    typeof value.subscribed === "boolean" &&
    typeof value.moderatorInstallPromoEligible === "boolean" &&
    typeof value.canViewStatistics === "boolean" &&
    isNullableFiniteNumber(value.goal) &&
    (value.goal === null || (value.goal as number) > 0) &&
    isNullableString(value.recentSubscriber) &&
    isNullableFiniteNumber(value.completedTime) &&
    (value.completedTime === null || (value.completedTime as number) >= 0) &&
    isNullableString(value.headerText)
  );
}

function isRegularUser(user: unknown): boolean {
  return (
    user === null ||
    (isObject(user) &&
      typeof user.id === "string" &&
      user.id.length > 0 &&
      typeof user.username === "string" &&
      user.username.length > 0)
  );
}

function hasRegularAppSettings(appSettings: unknown): boolean {
  return (
    isObject(appSettings) &&
    typeof appSettings.promoSubreddit === "string" &&
    appSettings.promoSubreddit.length > 0
  );
}

export const isSubGoalState = (value: unknown): value is SubGoalState => {
  if (!isObject(value) || !hasValidSharedState(value)) return false;
  if (value.postHeight === "tiny" || value.postHeight === "cta") {
    return hasValidCompactState(value);
  }
  return (
    (value.postHeight === "short" || value.postHeight === "regular") &&
    isRegularSubreddit(value.subreddit) &&
    hasRegularGoalFields(value) &&
    isRegularUser(value.user) &&
    hasRegularAppSettings(value.appSettings)
  );
};

export const isRefreshResponse = (value: unknown): value is RefreshResponse =>
  isObject(value) &&
  value.type === "refresh" &&
  typeof value.postId === "string" &&
  value.postId.length > 0 &&
  isSubGoalState(value.state) &&
  (value.subscriptionAttemptConfirmed === undefined ||
    typeof value.subscriptionAttemptConfirmed === "boolean");

export const isInitResponse = (value: unknown): value is InitResponse =>
  isObject(value) &&
  value.type === "init" &&
  typeof value.postId === "string" &&
  value.postId.length > 0 &&
  isSubGoalState(value.state);

export const isSubscribeResponse = (
  value: unknown,
): value is SubscribeResponse =>
  isObject(value) &&
  value.type === "subscribe" &&
  typeof value.postId === "string" &&
  value.postId.length > 0 &&
  isSubGoalState(value.state) &&
  (value.journeyTelemetryHandled === undefined ||
    typeof value.journeyTelemetryHandled === "boolean");
