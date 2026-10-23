import type { ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import {
  autoCreateNextGoalSuccessorsKey,
  cancelAllAutoCreateNextGoals,
  cancelAutoCreateNextGoal,
  getDueAutoCreateNextGoalPostIds,
  getSubGoalData,
  markAutoCreateNextGoalExhausted,
  recordAutoCreateNextGoalFailure,
  postHeightSuffix,
  postKindSuffix,
  subscriberGoalsKey,
} from "../data/subGoalData";
import { getDefaultSubscriberGoal } from "../utils/numberUtils";
import { createSubscriberGoal } from "./createSubscriberGoal";
import { getSubGoalPostMessages } from "../../shared/subGoalPostI18n";
import {
  getTerminalRemovedByCategory,
  isMissingPostError,
} from "../utils/postStatus";
import { isLinkId } from "../types";
import {
  getPostUrl,
  notifyHighlightFailure,
} from "../utils/highlightFailureNotifications";
import { logDiagnostic } from "../../shared/diagnostics";
import { getAutomaticGoalEligibility } from "./automaticGoalEligibility";
import {
  acquireCommunityGoalMutationLease,
  releaseCommunityGoalMutationLease,
  type CommunityGoalMutationLease,
} from "./communityGoalMutation";
import { retireSubscriberGoalPost } from "./postRetirement";
import { getSubscriberGoalCandidatePostIds } from "../data/subscriberGoalCandidates";

export type AutoCreateNextGoalSummary = {
  due: number;
  created: number;
  skipped: number;
  failed: number;
  rescheduled: number;
  exhausted: number;
};

export const autoCreateNextGoalLockKeyPrefix = "auto_create_next_goal_v1_lock";
export { autoCreateNextGoalSuccessorsKey } from "../data/subGoalData";
const autoCreateNextGoalLockTtlMs = 15 * 60 * 1000;

export async function processDueAutoCreateNextGoals({
  reddit,
  redis,
  appSettings,
  nowMs = Date.now(),
  mutationLease: existingMutationLease,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  nowMs?: number;
  mutationLease?: CommunityGoalMutationLease;
}): Promise<AutoCreateNextGoalSummary> {
  const duePostIds = await getDueAutoCreateNextGoalPostIds(redis, nowMs);
  const summary: AutoCreateNextGoalSummary = {
    due: duePostIds.length,
    created: 0,
    skipped: 0,
    failed: 0,
    rescheduled: 0,
    exhausted: 0,
  };

  for (const [sourceIndex, sourcePostId] of duePostIds.entries()) {
    const lockKey = `${autoCreateNextGoalLockKeyPrefix}:${sourcePostId}`;
    const lockToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
    let acquired = false;
    let mutationLease: CommunityGoalMutationLease | undefined;
    let acquiredMutationLease = false;
    try {
      if (!isLinkId(sourcePostId)) {
        summary.skipped += 1;
        await cancelAutoCreateNextGoal(redis, sourcePostId);
        console.info(
          `[autoCreateNextGoal] skipping inactive source post: sourcePostId=${sourcePostId} reason=invalid_post_id`,
        );
        continue;
      }

      mutationLease =
        existingMutationLease ??
        (await acquireCommunityGoalMutationLease(redis, nowMs));
      if (!mutationLease) {
        // Leave scheduler state untouched so the same due work is retried.
        summary.skipped += 1;
        continue;
      }
      acquiredMutationLease = existingMutationLease === undefined;

      await redis.set(lockKey, lockToken, {
        nx: true,
        expiration: new Date(nowMs + autoCreateNextGoalLockTtlMs),
      });
      acquired = (await redis.get(lockKey)) === lockToken;
      if (!acquired) {
        summary.skipped += 1;
        continue;
      }

      const existingSuccessor = await redis.hGet(
        autoCreateNextGoalSuccessorsKey,
        sourcePostId,
      );
      if (existingSuccessor && isLinkId(existingSuccessor)) {
        summary.skipped += 1;
        await cancelAutoCreateNextGoal(redis, sourcePostId);
        continue;
      }

      const sourceGoalData = await getSubGoalData(redis, sourcePostId);
      if (
        !sourceGoalData.goal ||
        !sourceGoalData.completedTime ||
        !sourceGoalData.autoCreateNextGoal
      ) {
        summary.skipped += 1;
        await cancelAutoCreateNextGoal(redis, sourcePostId);
        continue;
      }

      let sourceCreatedAtMs = 0;
      try {
        const sourcePost = await reddit.getPostById(sourcePostId);
        sourceCreatedAtMs = new Date(sourcePost.createdAt).getTime() || 0;
        const removedByCategory = getTerminalRemovedByCategory(sourcePost);
        if (removedByCategory) {
          summary.skipped += 1;
          await retireSubscriberGoalPost(
            redis,
            sourcePostId,
            `removedByCategory:${removedByCategory}`,
            nowMs,
          );
          console.info(
            `[autoCreateNextGoal] skipping inactive source post: sourcePostId=${sourcePostId} reason=removedByCategory:${removedByCategory}`,
          );
          continue;
        }
      } catch (sourcePostError) {
        if (isMissingPostError(sourcePostError, sourcePostId)) {
          summary.skipped += 1;
          await retireSubscriberGoalPost(
            redis,
            sourcePostId,
            "confirmed_missing_auto_successor_source",
            nowMs,
          );
          console.info(
            `[autoCreateNextGoal] skipping inactive source post: sourcePostId=${sourcePostId} reason=missing_post`,
          );
          continue;
        }
        throw sourcePostError;
      }

      const newerActiveGoal = await findNewerActiveClassicGoal({
        reddit,
        redis,
        sourcePostId,
        sourceCreatedAtMs,
      });
      if (newerActiveGoal) {
        await redis.hSet(autoCreateNextGoalSuccessorsKey, {
          [sourcePostId]: newerActiveGoal,
        });
        await cancelAutoCreateNextGoal(redis, sourcePostId);
        summary.skipped += 1;
        continue;
      }

      const subreddit = await reddit.getCurrentSubreddit();
      const eligibility = getAutomaticGoalEligibility(subreddit);
      if (!eligibility.eligible) {
        summary.skipped += duePostIds.length - sourceIndex;
        await cancelAllAutoCreateNextGoals(redis);
        logDiagnostic("info", "auto_create_goal_ineligible", {
          workflow: "auto_create_next_goal",
          phase: "eligibility",
          subredditType: eligibility.subredditType,
          isSfw: eligibility.isSfw,
          safetyStatus: eligibility.safetyStatus,
          reason: eligibility.reason,
        });
        break;
      }

      const subredditDisplayName =
        sourceGoalData.subredditDisplayName ?? subreddit.name;
      const messages = getSubGoalPostMessages(sourceGoalData.language);
      const crosspost =
        subreddit.name.toLowerCase() !==
        appSettings.promoSubreddit.toLowerCase();

      const { post, highlightResult } = await createSubscriberGoal({
        reddit,
        redis,
        appSettings,
        options: {
          title: messages.defaultPostTitle({
            subredditName: subredditDisplayName,
          }),
          goal: getDefaultSubscriberGoal(subreddit.numberOfSubscribers),
          subredditDisplayName,
          crosspost,
          colorTheme: sourceGoalData.colorTheme,
          postHeight: sourceGoalData.postHeight,
          autoCreateNextGoal: true,
          language: sourceGoalData.language,
          afterSubscribeAction: sourceGoalData.afterSubscribeAction,
          ...(sourceGoalData.afterSubscribePreset
            ? { afterSubscribePreset: sourceGoalData.afterSubscribePreset }
            : {}),
          cancelPendingAutoCreateGoals: false,
          operationId: `auto-next:${sourcePostId}`,
          reconciliationContext: "automatic_successor",
          mutationLease,
        },
      });
      if (highlightResult.issues.length > 0) {
        logDiagnostic("warn", "auto_create_goal_degraded", {
          workflow: "auto_create_next_goal",
          phase: "highlight",
          postId: post.id,
          failureCategories: highlightResult.issues
            .map(({ category }) => category)
            .join(","),
          capacityOutcome: highlightResult.capacityOutcome,
          cleanupOutcome: highlightResult.cleanupOutcome,
          rollbackOutcome: highlightResult.rollbackOutcome,
          reorderOutcome: highlightResult.reorderOutcome,
        });
        await notifyHighlightFailure({
          reddit,
          subredditId: subreddit.id,
          subredditName: subreddit.name,
          postTitle: post.title,
          postUrl: getPostUrl(post),
          errorMessage: highlightResult.errorMessage,
          highlightResult,
        });
      }
      await redis.hSet(autoCreateNextGoalSuccessorsKey, {
        [sourcePostId]: post.id,
      });
      try {
        await cancelAllAutoCreateNextGoals(redis);
      } catch (cancelError) {
        logDiagnostic(
          "error",
          "auto_create_cleanup_failed",
          {
            workflow: "auto_create_next_goal",
            phase: "cancel_all",
            postId: sourcePostId,
          },
          cancelError,
        );
        try {
          await cancelAutoCreateNextGoal(redis, sourcePostId);
        } catch (sourceCancelError) {
          logDiagnostic(
            "error",
            "auto_create_cleanup_failed",
            {
              workflow: "auto_create_next_goal",
              phase: "cancel_source",
              postId: sourcePostId,
            },
            sourceCancelError,
          );
        }
      }
      summary.created += 1;
      break;
    } catch (error) {
      logDiagnostic(
        "error",
        "auto_create_goal_failed",
        {
          workflow: "auto_create_next_goal",
          phase: "create",
          postId: sourcePostId,
        },
        error,
      );
      summary.failed += 1;
      const retry = await recordAutoCreateNextGoalFailure(
        redis,
        sourcePostId,
        nowMs,
      );
      if (retry.retryAt !== null) {
        summary.rescheduled += 1;
        logDiagnostic(
          "warn",
          "auto_create_goal_retry_scheduled",
          {
            workflow: "auto_create_next_goal",
            phase: "retry",
            postId: sourcePostId,
            failureCount: retry.failureCount,
          },
          error,
        );
      } else {
        summary.exhausted += 1;
        await markAutoCreateNextGoalExhausted(
          redis,
          sourcePostId,
          retry.failureCount,
        );
        logDiagnostic(
          "error",
          "auto_create_goal_retries_exhausted",
          {
            workflow: "auto_create_next_goal",
            phase: "terminal",
            postId: sourcePostId,
            failureCount: retry.failureCount,
          },
          error,
        );
      }
    } finally {
      if (acquired && (await redis.get(lockKey)) === lockToken) {
        await redis.del(lockKey);
      }
      if (mutationLease && acquiredMutationLease) {
        await releaseCommunityGoalMutationLease(redis, mutationLease);
      }
    }
  }

  return summary;
}

async function findNewerActiveClassicGoal({
  reddit,
  redis,
  sourcePostId,
  sourceCreatedAtMs,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  sourcePostId: `t3_${string}`;
  sourceCreatedAtMs: number;
}): Promise<`t3_${string}` | undefined> {
  let newest: { postId: `t3_${string}`; createdAtMs: number } | undefined;
  for (const candidateId of await getSubscriberGoalCandidatePostIds(redis)) {
    if (!isLinkId(candidateId) || candidateId === sourcePostId) continue;
    const [kind, height] = await redis.hMGet(subscriberGoalsKey, [
      `${candidateId}${postKindSuffix}`,
      `${candidateId}${postHeightSuffix}`,
    ]);
    if (
      kind !== "subscriber-goal-v1" ||
      (height !== "regular" && height !== "short")
    ) {
      continue;
    }
    const data = await getSubGoalData(redis, candidateId);
    if (!data.goal || data.completedTime) continue;
    try {
      const post = await reddit.getPostById(candidateId);
      if (getTerminalRemovedByCategory(post)) continue;
      const createdAtMs = new Date(post.createdAt).getTime() || 0;
      if (
        createdAtMs > sourceCreatedAtMs &&
        (!newest || createdAtMs > newest.createdAtMs)
      ) {
        newest = { postId: candidateId, createdAtMs };
      }
    } catch (error) {
      // A transient lookup must not authorize creation of another goal.
      if (!isMissingPostError(error, candidateId)) throw error;
    }
  }
  return newest?.postId;
}
