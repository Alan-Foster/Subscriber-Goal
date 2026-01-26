import { reddit, redis } from '@devvit/web/server';
import { checkCompletionStatus, getSubGoalData } from '../data/subGoalData';
import { cancelUpdates, getQueuedUpdates, queueUpdate } from '../data/updaterData';
import { applyTextFallback } from '../utils/textFallback';

export async function onPostsUpdaterJob(): Promise<void> {
  console.log(`postsUpdaterJob ran at ${new Date().toISOString()}`);

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
