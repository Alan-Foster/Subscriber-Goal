/**
 * @file This file contains the scheduled job that is started by the AppInstall and AppUpgrade triggers. It handles updating custom post previews and text fallbacks for posts that are queued for updates.
 */

import {Devvit, ScheduledJobEvent, TriggerContext} from '@devvit/public-api';

import {previewMaker, PreviewProps, textFallbackMaker} from '../customPost/components/preview.js';
import {checkCompletionStatus, getSubGoalData} from '../data/subGoalData.js';
import {cancelUpdates, getQueuedUpdates, queueUpdate} from '../data/updaterData.js';
import {getSubredditIcon} from '../utils/redditUtils.js';

/**
 * This is the function that runs when the `postsUpdaterJob` job is triggered by the scheduler.
 * It fetches all queued posts from Redis, checks their completion status, and updates their custom post previews and text fallbacks.
 * Once it has updated a post, it updates the post's queue position or remove it from the queue if it has been completed.
 * @param event - This could be used to pass additional data to the job, but we only schedule this function to run as a cron job once, so passing data that way isn't useful here.
 * @param context - TriggerContext provided by Devvit, which contains all the stuff for interacting with Reddit, Redis, etc.
 * @todo Maybe send events to the realtime channel from here? At least for completion status changes.
 */
export async function onPostsUpdaterJob (event: ScheduledJobEvent<undefined>, context: TriggerContext) {
  console.log(`postsUpdaterJob job ran at ${new Date().toISOString()}`);

  const subreddit = await context.reddit.getCurrentSubreddit();
  const subredditIcon = await getSubredditIcon(context.reddit, subreddit.id);

  const postIds = await getQueuedUpdates(context.redis);
  console.log(`Updating ${postIds.length} posts`);
  for (const postId of postIds) {
    try {
      console.log(`Updating post ${postId}`);
      const subGoalData = await getSubGoalData(context.redis, postId);
      if (!subGoalData.goal) {
        console.error(`Missing subGoalData for post ${postId}`);
        continue;
      }

      if (subreddit.numberOfSubscribers >= subGoalData.goal && !subGoalData.completedTime) {
        await checkCompletionStatus(context.reddit, context.redis, postId); // This could probably be done better than here
      }

      const previewProps: PreviewProps = {
        goal: subGoalData.goal,
        subscribers: subreddit.numberOfSubscribers,
        subredditName: subreddit.name,
        recentSubscriber: subGoalData.recentSubscriber,
        completedTime: subGoalData.completedTime ? new Date(subGoalData.completedTime) : null,
        subredditIcon,
      };

      const post = await context.reddit.getPostById(postId);
      await post.setCustomPostPreview(() => previewMaker(previewProps));
      await post.setTextFallback({text: textFallbackMaker(previewProps)});

      if (subGoalData.completedTime) {
        await cancelUpdates(context.redis, postId);
        continue;
      } else {
        await queueUpdate(context.redis, postId, new Date());
      }
    } catch (e) {
      console.error(`Error updating post ${postId}: ${String(e)}`);
    }
  }
}

/**
 * @description This registers `postsUpdaterJob` job with `onPostsUpdaterJob` as its associated function. It is exported via main.js to tell Devvit about the scheduler job. This doesn't actually start the job, that part is handled in the {@linkcode onAppChanged} trigger handler.
 */
export const postsUpdaterJob = Devvit.addSchedulerJob({
  name: 'postsUpdaterJob',
  onRun: onPostsUpdaterJob,
});
