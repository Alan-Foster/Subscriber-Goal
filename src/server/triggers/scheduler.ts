import { context, reddit, redis, settings } from '@devvit/web/server';
import {
  checkCompletionStatus,
  getSubGoalData,
  processRecentSubscriberIndexMigrationBatch,
} from '../data/subGoalData';
import { cancelUpdates, getQueuedUpdates, queueUpdate } from '../data/updaterData';
import { isLinkId } from '../types';
import { applyTextFallback } from '../utils/textFallback';
import { getAppSettings } from '../settings';
import {
  isCrosspostAuthorityInstall,
  processCrosspostDispatchQueue,
} from './modAction';
import { countPendingCrossposts } from '../data/crosspostData';
import { processSubscriberStatsMigrationBatch } from '../data/subscriberStats';

export async function onPostsUpdaterJob(): Promise<void> {
  console.log(`postsUpdaterJob ran at ${new Date().toISOString()}`);

  const appSettings = await getAppSettings(settings);
  const currentSubredditName =
    context.subredditName ?? (await reddit.getCurrentSubreddit()).name;
  if (isCrosspostAuthorityInstall(appSettings, currentSubredditName)) {
    const ingestionSummary = await processCrosspostDispatchQueue(
      appSettings,
      'scheduler_posts_updater'
    );
    const pendingDepth = await countPendingCrossposts(
      redis,
      appSettings.promoSubreddit
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
      ingestionSummary.status !== 'success'
    ) {
      console.info(
        `[crosspost] scheduler ingestion summary: status=${ingestionSummary.status} revisionsFetched=${ingestionSummary.revisionsFetched} newPostsSeen=${ingestionSummary.newPostsSeen} crosspostsCreated=${ingestionSummary.crosspostsCreated} crosspostsSkipped=${ingestionSummary.crosspostsSkipped} crosspostsFailed=${ingestionSummary.crosspostsFailed} actionsMirrored=${ingestionSummary.actionsMirrored} actionsFailed=${ingestionSummary.actionsFailed} crosspostPersistenceFailedAfterCreate=${ingestionSummary.crosspostPersistenceFailedAfterCreate} crosspostsSkippedBySourceCooldown=${ingestionSummary.crosspostsSkippedBySourceCooldown} crosspostsSkippedByInFlight=${ingestionSummary.crosspostsSkippedByInFlight} crosspostsSkippedByExistingDetection=${ingestionSummary.crosspostsSkippedByExistingDetection} pendingDepth=${pendingDepth} error=${ingestionSummary.errorMessage ?? 'none'}`
      );
    }
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
        continue;
      }

      if (subreddit.numberOfSubscribers >= subGoalData.goal && !subGoalData.completedTime) {
        await checkCompletionStatus(reddit, redis, postId);
      }

      const completedTime = subGoalData.completedTime
        ? new Date(subGoalData.completedTime)
        : null;
      if (!isLinkId(postId)) {
        console.error(`Skipping invalid post id in scheduler queue: ${postId}`);
        await cancelUpdates(redis, postId);
        continue;
      }
      const post = await reddit.getPostById(postId);
      await applyTextFallback(post, {
        goal: subGoalData.goal,
        subscribers: subreddit.numberOfSubscribers,
        subredditName: subGoalData.subredditDisplayName ?? subreddit.name,
        completedTime,
      });

      if (subGoalData.completedTime) {
        await cancelUpdates(redis, postId);
        continue;
      }

      await queueUpdate(redis, postId, new Date());
    } catch (e) {
      console.error(`Error updating post ${postId}: ${String(e)}`);
    }
  }
}
