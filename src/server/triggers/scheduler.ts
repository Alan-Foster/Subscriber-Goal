import { context, reddit, redis } from '@devvit/web/server';
import { checkCompletionStatus, getSubGoalData } from '../data/subGoalData';
import { cancelUpdates, getQueuedUpdates, queueUpdate } from '../data/updaterData';
import { isLinkId } from '../types';
import { applyTextFallback } from '../utils/textFallback';
import { getAppSettings } from '../settings';
import { processCrosspostDispatchQueue } from './modAction';

export async function onPostsUpdaterJob(): Promise<void> {
  console.log(`postsUpdaterJob ran at ${new Date().toISOString()}`);

  const appSettings = await getAppSettings(
    (context as { settings?: { getAll<T>(): Promise<Partial<T>> } }).settings
  );
  const ingestionSummary = await processCrosspostDispatchQueue(
    appSettings,
    'scheduler_posts_updater'
  );
  console.info(
    `[crosspost] scheduler ingestion summary: status=${ingestionSummary.status} revisionsFetched=${ingestionSummary.revisionsFetched} newPostsSeen=${ingestionSummary.newPostsSeen} crosspostsCreated=${ingestionSummary.crosspostsCreated} crosspostsSkipped=${ingestionSummary.crosspostsSkipped} crosspostsFailed=${ingestionSummary.crosspostsFailed} actionsMirrored=${ingestionSummary.actionsMirrored} actionsFailed=${ingestionSummary.actionsFailed} crosspostPersistencePartial=${ingestionSummary.crosspostPersistencePartial} crosspostPersistenceFailedAfterCreate=${ingestionSummary.crosspostPersistenceFailedAfterCreate} crosspostsSkippedBySourceCooldown=${ingestionSummary.crosspostsSkippedBySourceCooldown} crosspostsSkippedByInFlight=${ingestionSummary.crosspostsSkippedByInFlight} crosspostsSkippedByExistingDetection=${ingestionSummary.crosspostsSkippedByExistingDetection} error=${ingestionSummary.errorMessage ?? 'none'}`
  );

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
        subredditName: subreddit.name,
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
