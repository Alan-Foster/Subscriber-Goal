import type { ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import {
  cancelAllAutoCreateNextGoals,
  cancelAutoCreateNextGoal,
  getDueAutoCreateNextGoalPostIds,
  getSubGoalData,
  recordAutoCreateNextGoalFailure,
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
  notifyStickyFailure,
} from "../utils/stickyFailureNotifications";
import { logDiagnostic } from "../../shared/diagnostics";

export type AutoCreateNextGoalSummary = {
  due: number;
  created: number;
  skipped: number;
  failed: number;
  rescheduled: number;
  exhausted: number;
};

export const autoCreateNextGoalLockKeyPrefix = "auto_create_next_goal_v1_lock";
export const autoCreateNextGoalSuccessorsKey = "auto_create_next_goal_v1_successors";
const autoCreateNextGoalLockTtlMs = 15 * 60 * 1000;

export async function processDueAutoCreateNextGoals({
  reddit,
  redis,
  appSettings,
  nowMs = Date.now(),
}: {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  nowMs?: number;
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

  for (const sourcePostId of duePostIds) {
    const lockKey = `${autoCreateNextGoalLockKeyPrefix}:${sourcePostId}`;
    const lockToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
    let acquired = false;
    try {
      if (!isLinkId(sourcePostId)) {
        summary.skipped += 1;
        await cancelAutoCreateNextGoal(redis, sourcePostId);
        console.info(
          `[autoCreateNextGoal] skipping inactive source post: sourcePostId=${sourcePostId} reason=invalid_post_id`,
        );
        continue;
      }

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

      try {
        const sourcePost = await reddit.getPostById(sourcePostId);
        const removedByCategory = getTerminalRemovedByCategory(sourcePost);
        if (removedByCategory) {
          summary.skipped += 1;
          await cancelAutoCreateNextGoal(redis, sourcePostId);
          console.info(
            `[autoCreateNextGoal] skipping inactive source post: sourcePostId=${sourcePostId} reason=removedByCategory:${removedByCategory}`,
          );
          continue;
        }
      } catch (sourcePostError) {
        if (isMissingPostError(sourcePostError)) {
          summary.skipped += 1;
          await cancelAutoCreateNextGoal(redis, sourcePostId);
          console.info(
            `[autoCreateNextGoal] skipping inactive source post: sourcePostId=${sourcePostId} reason=missing_post`,
          );
          continue;
        }
        throw sourcePostError;
      }

      const subreddit = await reddit.getCurrentSubreddit();
      const subredditDisplayName =
        sourceGoalData.subredditDisplayName ?? subreddit.name;
      const messages = getSubGoalPostMessages(sourceGoalData.language);
      const sourceSubredditIsNsfw =
        (subreddit as { isNsfw?: boolean }).isNsfw === true;
      const crosspost =
        !sourceSubredditIsNsfw &&
        subreddit.name.toLowerCase() !==
          appSettings.promoSubreddit.toLowerCase();

      const { post, stickyResult } = await createSubscriberGoal({
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
        },
      });
      if (stickyResult.status === "not_pinned") {
        logDiagnostic("warn", "auto_create_goal_degraded", {
          workflow: "auto_create_next_goal",
          phase: "sticky",
          postId: post.id,
        });
        await notifyStickyFailure({
          reddit,
          subredditId: subreddit.id,
          subredditName: subreddit.name,
          postTitle: post.title,
          postUrl: getPostUrl(post),
          errorMessage: stickyResult.errorMessage,
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
          { workflow: "auto_create_next_goal", phase: "cancel_all", postId: sourcePostId },
          cancelError,
        );
        try {
          await cancelAutoCreateNextGoal(redis, sourcePostId);
        } catch (sourceCancelError) {
          logDiagnostic(
            "error",
            "auto_create_cleanup_failed",
            { workflow: "auto_create_next_goal", phase: "cancel_source", postId: sourcePostId },
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
        { workflow: "auto_create_next_goal", phase: "create", postId: sourcePostId },
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
          { workflow: "auto_create_next_goal", phase: "retry", postId: sourcePostId, failureCount: retry.failureCount },
          error,
        );
      } else {
        summary.exhausted += 1;
        await cancelAutoCreateNextGoal(redis, sourcePostId);
        logDiagnostic(
          "error",
          "auto_create_goal_retries_exhausted",
          { workflow: "auto_create_next_goal", phase: "terminal", postId: sourcePostId, failureCount: retry.failureCount },
          error,
        );
      }
    } finally {
      if (acquired && (await redis.get(lockKey)) === lockToken) {
        await redis.del(lockKey);
      }
    }
  }

  return summary;
}
