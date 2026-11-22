import {
  getAutomaticGoalEligibility,
  type AutomaticGoalIneligibilityReason,
} from "./automaticGoalEligibility";
import { onboardingMinimumSubscriberCount } from "./onboardingConfig";

export type OnboardingIneligibilityReason =
  "subscriber_count" | "subreddit_not_sfw" | AutomaticGoalIneligibilityReason;

export type OnboardingEligibility = {
  eligible: boolean;
  subscriberCount: number;
  subredditType: string;
  isSfw: boolean;
  safetyStatus: "sfw" | "nsfw" | "unknown";
  reason?: OnboardingIneligibilityReason;
};

export function getOnboardingEligibility(subreddit: {
  numberOfSubscribers: number;
  type?: unknown;
  nsfw?: unknown;
}): OnboardingEligibility {
  const automaticEligibility = getAutomaticGoalEligibility(subreddit);
  if (!(subreddit.numberOfSubscribers >= onboardingMinimumSubscriberCount)) {
    return {
      eligible: false,
      subscriberCount: subreddit.numberOfSubscribers,
      subredditType: automaticEligibility.subredditType,
      isSfw: automaticEligibility.isSfw,
      safetyStatus: automaticEligibility.safetyStatus,
      reason: "subscriber_count",
    };
  }
  if (!automaticEligibility.eligible) {
    return {
      eligible: false,
      subscriberCount: subreddit.numberOfSubscribers,
      subredditType: automaticEligibility.subredditType,
      isSfw: automaticEligibility.isSfw,
      safetyStatus: automaticEligibility.safetyStatus,
      reason: automaticEligibility.reason,
    };
  }
  return {
    eligible: true,
    subscriberCount: subreddit.numberOfSubscribers,
    subredditType: automaticEligibility.subredditType,
    isSfw: automaticEligibility.isSfw,
    safetyStatus: automaticEligibility.safetyStatus,
  };
}

export function isOnboardingIneligibilityReason(
  value: string | undefined,
): value is OnboardingIneligibilityReason {
  return (
    value === "subscriber_count" ||
    value === "subreddit_not_public" ||
    value === "subreddit_not_sfw"
  );
}
