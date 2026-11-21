import { logDiagnostic } from "../../shared/diagnostics";
import type { RedditClient, RedisClient } from "../types";
import {
  clearHighlightContradictionIncident,
  recordHighlightContradiction,
} from "../data/highlightContradiction";
import { scheduleHighlightRepair } from "../data/highlightRepair";
import {
  createFailedHighlightResult,
  type HighlightResult,
} from "../utils/communityHighlights";
import {
  getPostUrl,
  notifyHighlightFailureIncident,
  type HighlightNotificationOutcome,
} from "../utils/highlightFailureNotifications";
import type { OnboardingGoalCandidate } from "./onboardingSubscriberGoal";

export async function checkCanonicalHighlightContradiction({
  reddit,
  redis,
  selected,
  nowMs,
  notifyOnFailure,
  sameCanonical,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  selected: OnboardingGoalCandidate;
  nowMs: number;
  notifyOnFailure: boolean;
  sameCanonical: boolean;
}): Promise<
  | {
      highlightResult: HighlightResult;
      notificationOutcome: HighlightNotificationOutcome;
    }
  | undefined
> {
  const subreddit = await reddit.getCurrentSubreddit();
  let liveListed: boolean | undefined;
  let livePostState: boolean | undefined;
  try {
    const snapshot = await subreddit.getHighlightedPosts();
    liveListed = snapshot.some(({ postId }) => postId === selected.postId);
    livePostState = selected.post.isHighlighted
      ? await selected.post.isHighlighted()
      : undefined;
  } catch (error) {
    logDiagnostic(
      "warn",
      "canonical_highlight_read_failed",
      {
        workflow: "onboarding_highlight_ensurance",
        phase: "verification",
        postId: selected.postId,
      },
      error,
    );
  }

  if (
    liveListed !== undefined &&
    livePostState !== undefined &&
    liveListed !== livePostState
  ) {
    const contradiction = await recordHighlightContradiction(redis, {
      postId: selected.postId,
      listed: liveListed,
      postState: livePostState,
      nowMs,
    });
    const result = createFailedHighlightResult(
      selected.postId,
      "verification",
      "Reddit reported contradictory Community Highlight state; moderator intent was not recorded.",
    );
    await scheduleHighlightRepair(redis, {
      delayMs: Math.min(
        60 * 60 * 1000,
        5 * 60 * 1000 * 2 ** (contradiction.consecutiveCount - 1),
      ),
      force: true,
      reason: "contradictory_highlight_state",
      nowMs,
    });
    let notificationOutcome: HighlightNotificationOutcome = "not_requested";
    if (notifyOnFailure && contradiction.consecutiveCount >= 3) {
      notificationOutcome = await notifyHighlightFailureIncident({
        reddit,
        redis,
        postId: selected.postId,
        result,
        subredditId: subreddit.id,
        subredditName: subreddit.name,
        postTitle: selected.post.title ?? "Subscriber Goal",
        postUrl: getPostUrl(selected.post),
        errorMessage: result.errorMessage,
        postOrigin: "existing",
        language: subreddit.language,
        nowMs,
      });
    }
    return { highlightResult: result, notificationOutcome };
  }

  if (
    liveListed !== undefined &&
    livePostState !== undefined &&
    liveListed === livePostState
  ) {
    await clearHighlightContradictionIncident(
      redis,
      sameCanonical ? selected.postId : undefined,
    );
  }
  return undefined;
}
