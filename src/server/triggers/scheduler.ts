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
import { applyGoalPostFrameStyle } from "../core/post";
import {
  getTerminalRemovedByCategory,
  isMissingPostError,
} from "../utils/postStatus";

async function cleanupInactivePost(
  postId: string,
  reason: string,
): Promise<void> {
  await cancelUpdates(redis, postId);
  await untrackPost(redis, postId);
  await cancelAutoCreateNextGoal(redis, postId);
  console.info(
    `[updater] cleaned up inactive post: postId=${postId} reason=${reason}`,
  );
}

export async function onPostsUpdaterJob(): Promise<void> {
  console.log(`postsUpdaterJob ran at ${new Date().toISOString()}`);

  const appSettings = getAppSettings();
  const currentSubredditName =
    context.subredditName ?? (await reddit.getCurrentSubreddit()).name;
  if (isCrosspostAuthorityInstall(appSettings, currentSubredditName)) {
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
    console.error(`postKindMigration error: ${String(error)}`);
  }
  try {
    await processLegacyAfterSubscribeActionMigrationBatch(redis);
  } catch (error) {
    console.error(
      `legacyAfterSubscribeActionMigration error: ${String(error)}`,
    );
  }
  try {
    await processSubscriberStatsMigrationBatch(redis);
  } catch (error) {
    console.error(`subscriberStatsMigration error: ${String(error)}`);
  }
  try {
    await processRecentSubscriberIndexMigrationBatch(redis);
  } catch (error) {
    console.error(`recentSubscriberIndexMigration error: ${String(error)}`);
  }
  try {
    const onboardingSummary = await processDueOnboardingSubscriberGoal({
      reddit,
      redis,
      appSettings,
    });
    if (onboardingSummary.shouldLog) {
      console.info(
        `[onboardingSubscriberGoal] scheduler summary: subreddit=${currentSubredditName} status=${onboardingSummary.status} terminalStatus=${onboardingSummary.terminalStatus ?? "none"} source=${onboardingSummary.lifecycleSource ?? "unknown"} existingSource=${onboardingSummary.existingSource ?? "none"} trackedInspected=${onboardingSummary.trackedInspected} pinnedInspected=${onboardingSummary.pinnedInspected} recentInspected=${onboardingSummary.recentInspected} postId=${onboardingSummary.postId ?? "none"} error=${onboardingSummary.errorMessage ?? "none"}`,
      );
    }
  } catch (error) {
    console.error(`onboardingSubscriberGoal error: ${String(error)}`);
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
      autoCreateSummary.failed > 0
    ) {
      console.info(
        `[autoCreateNextGoal] scheduler summary: due=${autoCreateSummary.due} created=${autoCreateSummary.created} skipped=${autoCreateSummary.skipped} failed=${autoCreateSummary.failed}`,
      );
    }
  } catch (error) {
    console.error(`autoCreateNextGoal error: ${String(error)}`);
  }

  const subreddit = await reddit.getCurrentSubreddit();

  const postIds = await getQueuedUpdates(redis);
  if (!postIds.length) {
    return;
  }
  console.log(`Updating ${postIds.length} posts`);

  for (const postId of postIds) {
    try {
      const subGoalData = await getSubGoalData(redis, postId);
      if (!subGoalData.goal) {
        console.error(`Missing subGoalData for post ${postId}`);
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
        console.error(`Skipping invalid post id in scheduler queue: ${postId}`);
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
      console.error(`Error updating post ${postId}: ${String(e)}`);
    }
  }
}
