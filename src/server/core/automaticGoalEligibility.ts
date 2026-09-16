import { getCurrentSubredditNsfw } from "../utils/subredditSafety";

export type AutomaticGoalIneligibilityReason =
  | "subreddit_not_public"
  | "subreddit_not_sfw";

export type AutomaticGoalEligibility =
  | {
      eligible: true;
      subredditType: string;
      isSfw: true;
      safetyStatus: "sfw";
    }
  | {
      eligible: false;
      subredditType: string;
      isSfw: boolean;
      safetyStatus: "sfw" | "nsfw" | "unknown";
      reason: AutomaticGoalIneligibilityReason;
    };

export function getAutomaticGoalEligibility(subreddit: {
  type?: unknown;
  nsfw?: unknown;
}): AutomaticGoalEligibility {
  const subredditType =
    typeof subreddit.type === "string" ? subreddit.type : "unknown";
  const nsfw = getCurrentSubredditNsfw(subreddit);
  const safetyStatus =
    nsfw === false ? "sfw" : nsfw === true ? "nsfw" : "unknown";
  const isSfw = safetyStatus === "sfw";

  if (subredditType !== "public") {
    return {
      eligible: false,
      subredditType,
      isSfw,
      safetyStatus,
      reason: "subreddit_not_public",
    };
  }
  if (!isSfw) {
    return {
      eligible: false,
      subredditType,
      isSfw,
      safetyStatus,
      reason: "subreddit_not_sfw",
    };
  }
  return { eligible: true, subredditType, isSfw, safetyStatus };
}
