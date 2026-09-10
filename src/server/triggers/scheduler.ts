import { context, reddit, redis } from "@devvit/web/server";
import {
  cancelAutoCreateNextGoal,
  checkCompletionStatus,
  getSubGoalData,
  processRecentSubscriberIndexMigrationBatch,
} from "../data/subGoalData";
import {
  cancelUpdates,
  getQueuedUpdates,
  queueUpdate,
  untrackPost,
} from "../data/updaterData";
import { isLinkId } from "../types";
import { applyTextFallback } from "../utils/textFallback";
import { getAppSettings } from "../settings";
import {
  isCrosspostAuthorityInstall,
  processCrosspostDispatchQueue,
} from "./modAction";
import { countPendingCrossposts } from "../data/crosspostData";
import { processSubscriberStatsMigrationBatch } from "../data/subscriberStats";
import { processPostKindMigrationBatch } from "../data/postKindMigration";
import { processLegacyAfterSubscribeActionMigrationBatch } from "../data/legacyAfterSubscribeActionMigration";
import { processDueAutoCreateNextGoals } from "../core/autoCreateNextGoal";
import { processDueOnboardingSubscriberGoal } from "../core/onboardingSubscriberGoal";
import { processDueOnboardingReminder } from "../core/onboardingReminder";
import { applyGoalPostFrameStyle } from "../core/post";
import {
  getTerminalRemovedByCategory,
  isMissingPostError,
} from "../utils/postStatus";
import { removeSubscriberGoalPost } from "../data/subscriberGoalPostRegistry";
import { observeDailySubscriberCount } from "../data/subscriberDailyStats";
import { ensureCommunityPostActivityBackfill } from "../data/ctaActivity";
import { logDiagnostic } from "../../shared/diagnostics";

async function cleanupInactivePost(
  postId: string,
  reason: string,
): Promise<void> {
  await cancelUpdates(redis, postId);
  await untrackPost(redis, postId);
  await cancelAutoCreateNextGoal(redis, postId);
  await removeSubscriberGoalPost(redis, postId);
  console.info(
    `[updater] cleaned up inactive post: postId=${postId} reason=${reason}`,
  );
}

export async function onPostsUpdaterJob(): Promise<void> {
  console.log(`postsUpdaterJob ran at ${new Date().toISOString()}`);

  const appSettings = getAppSettings();
  let subreddit: Awaited<ReturnType<typeof reddit.getCurrentSubreddit>> | null =
    null;
  try {
    subreddit = await reddit.getCurrentSubreddit();
    await observeDailySubscriberCount(redis, subreddit.numberOfSubscribers);
  } catch (error) {
    logDiagnostic("error", "scheduler_task_failed", { workflow: "subscriber_daily_stats" }, error);
  }
  if (subreddit) {
    try {
      await ensureCommunityPostActivityBackfill(reddit, redis, subreddit.name);
    } catch (error) {
      logDiagnostic("error", "scheduler_task_failed", { workflow: "community_post_activity_backfill" }, error);
    }
  }
  const currentSubredditName = context.subredditName ?? subreddit?.name;
  if (
    currentSubredditName &&
    isCrosspostAuthorityInstall(appSettings, currentSubredditName)
  ) {
    const ingestionSummary = await processCrosspostDispatchQueue(
      appSettings,
      "scheduler_posts_updater",
    );
    const pendingDepth = await countPendingCrossposts(
      redis,
      appSettings.promoSubreddit,
    );
    const crosspostWorkOccurred =
      ingestionSummary.revisionsFetched > 0 ||
      ingestionSummary.newPostsSeen > 0 ||
      ingestionSummary.crosspostsCreated > 0 ||
      ingestionSummary.crosspostsSkipped > 0 ||
      ingestionSummary.crosspostsFailed > 0 ||
      ingestionSummary.actionsMirrored > 0 ||
      ingestionSummary.actionsFailed > 0 ||
      ingestionSummary.crosspostPersistenceFailedAfterCreate > 0 ||
      ingestionSummary.crosspostsSkippedBySourceCooldown > 0 ||
      ingestionSummary.crosspostsSkippedByInFlight > 0 ||
      ingestionSummary.crosspostsSkippedByExistingDetection > 0;
    if (
      crosspostWorkOccurred ||
      pendingDepth > 0 ||
      ingestionSummary.status !== "success"
    ) {
      console.info(
        `[crosspost] scheduler ingestion summary: status=${ingestionSummary.status} revisionsFetched=${ingestionSummary.revisionsFetched} newPostsSeen=${ingestionSummary.newPostsSeen} crosspostsCreated=${ingestionSummary.crosspostsCreated} crosspostsSkipped=${ingestionSummary.crosspostsSkipped} crosspostsFailed=${ingestionSummary.crosspostsFailed} actionsMirrored=${ingestionSummary.actionsMirrored} actionsFailed=${ingestionSummary.actionsFailed} crosspostPersistenceFailedAfterCreate=${ingestionSummary.crosspostPersistenceFailedAfterCreate} crosspostsSkippedBySourceCooldown=${ingestionSummary.crosspostsSkippedBySourceCooldown} crosspostsSkippedByInFlight=${ingestionSummary.crosspostsSkippedByInFlight} crosspostsSkippedByExistingDetection=${ingestionSummary.crosspostsSkippedByExistingDetection} pendingDepth=${pendingDepth} error=${ingestionSummary.errorMessage ?? "none"}`,
      );
    }
  }
  try {
    await processPostKindMigrationBatch(reddit, redis);
  } catch (error) {
    logDiagnostic("error", "scheduler_task_failed", { workflow: "post_kind_migration" }, error);
  }
  try {
    if (subreddit) {
      await processLegacyAfterSubscribeActionMigrationBatch(redis, {
        name: subreddit.name,
        type: subreddit.type,
      });
    }
  } catch (error) {
    logDiagnostic("error", "scheduler_task_failed", { workflow: "after_subscribe_action_migration" }, error);
  }
  try {
    await processSubscriberStatsMigrationBatch(redis);
  } catch (error) {
    logDiagnostic("error", "scheduler_task_failed", { workflow: "subscriber_stats_migration" }, error);
  }
  try {
    await processRecentSubscriberIndexMigrationBatch(redis);
  } catch (error) {
    logDiagnostic("error", "scheduler_task_failed", { workflow: "recent_subscriber_migration" }, error);
  }
  try {
    await processDueOnboardingReminder({ reddit, redis });
  } catch (error) {
    logDiagnostic("error", "scheduler_task_failed", { workflow: "onboarding_reminder" }, error);
  }
  try {
    await processDueOnboardingSubscriberGoal({
      reddit,
      redis,
      appSettings,
    });
  } catch (error) {
    logDiagnostic("error", "scheduler_task_failed", { workflow: "onboarding_subscriber_goal" }, error);
  }
  try {
    const autoCreateSummary = await processDueAutoCreateNextGoals({
      reddit,
      redis,
      appSettings,
    });
    if (
      autoCreateSummary.due > 0 ||
      autoCreateSummary.created > 0 ||
      autoCreateSummary.skipped > 0 ||
      autoCreateSummary.failed > 0 ||
      autoCreateSummary.rescheduled > 0 ||
      autoCreateSummary.exhausted > 0
    ) {
      console.info(
        `[autoCreateNextGoal] scheduler summary: due=${autoCreateSummary.due} created=${autoCreateSummary.created} skipped=${autoCreateSummary.skipped} failed=${autoCreateSummary.failed} rescheduled=${autoCreateSummary.rescheduled} exhausted=${autoCreateSummary.exhausted}`,
      );
    }
  } catch (error) {
    logDiagnostic("error", "scheduler_task_failed", { workflow: "auto_create_next_goal" }, error);
  }

  const postIds = await getQueuedUpdates(redis);
  if (!postIds.length) {
    return;
  }
  if (!subreddit) {
    try {
      subreddit = await reddit.getCurrentSubreddit();
    } catch (error) {
      logDiagnostic("error", "scheduler_task_failed", { workflow: "subreddit_lookup" }, error);
      return;
    }
  }
  console.log(`Updating ${postIds.length} posts`);

  for (const postId of postIds) {
    try {
      const subGoalData = await getSubGoalData(redis, postId);
      if (!subGoalData.goal) {
        logDiagnostic("error", "scheduler_post_update_failed", {
          workflow: "post_update",
          phase: "missing_state",
          postId,
        });
        await cleanupInactivePost(postId, "missing_goal_data");
        continue;
      }

      if (
        subreddit.numberOfSubscribers >= subGoalData.goal &&
        !subGoalData.completedTime
      ) {
        subGoalData.completedTime = await checkCompletionStatus(
          reddit,
          redis,
          postId,
        );
      }

      const completedTime = subGoalData.completedTime
        ? new Date(subGoalData.completedTime)
        : null;
      if (!isLinkId(postId)) {
        logDiagnostic("error", "scheduler_post_update_failed", {
          workflow: "post_update",
          phase: "invalid_post_id",
          postId,
        });
        await cleanupInactivePost(postId, "invalid_post_id");
        continue;
      }
      const post = await reddit.getPostById(postId);
      const removedByCategory = getTerminalRemovedByCategory(post);
      if (removedByCategory) {
        await cleanupInactivePost(
          postId,
          `removedByCategory:${removedByCategory}`,
        );
        continue;
      }
      await applyTextFallback(post, {
        goal: subGoalData.goal,
        subscribers: subreddit.numberOfSubscribers,
        subredditName: subGoalData.subredditDisplayName ?? subreddit.name,
        completedTime,
        language: subGoalData.language,
      });
      await applyGoalPostFrameStyle(post, subGoalData.postHeight);

      if (subGoalData.completedTime) {
        await cancelUpdates(redis, postId);
        continue;
      }

      await queueUpdate(redis, postId, new Date());
    } catch (e) {
      if (isLinkId(postId) && isMissingPostError(e)) {
        await cleanupInactivePost(postId, "missing_post");
        continue;
      }
      logDiagnostic("error", "scheduler_post_update_failed", { workflow: "post_update", postId }, e);
    }
  }
}
