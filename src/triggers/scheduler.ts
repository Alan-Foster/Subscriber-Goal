import {Devvit, ScheduledJobEvent, TriggerContext} from '@devvit/public-api';

import {previewMaker, PreviewProps} from '../customPost/components/preview.js';
import {checkCompletionStatus, getSubGoalData} from '../data/subGoalData.js';
import {cancelUpdates, getQueuedUpdates, queueUpdate} from '../data/updaterData.js';
import {getAppSettings} from '../settings.js';
import {getSubredditIcon} from '../utils/subredditUtils.js';

export async function onPostsUpdaterJob (event: ScheduledJobEvent<undefined>, context: TriggerContext) {
  console.log(`postsUpdaterJob job ran at ${new Date().toISOString()}`);

  const appSettings = await getAppSettings(context.settings);
  const subreddit = await context.reddit.getCurrentSubreddit();
  if (subreddit.name.toLowerCase() === appSettings.promoSubreddit.toLowerCase()) {
    // TODO: Implement r/SubGoal post creation here
  }

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

      const textFallback = subGoalData.completedTime
        ? `r/${subreddit.name} reached ${subGoalData.goal} subscribers!\n\nGoal reached at ${new Date(subGoalData.completedTime).toLocaleTimeString('en', {timeZone: 'UTC'})} on ${new Date(subGoalData.completedTime).toLocaleDateString('en', {timeZone: 'UTC'})}`
        : `Welcome to r/${subreddit.name}\n\n${subreddit.numberOfSubscribers} / ${subGoalData.goal} subscribers.\n  Help us reach our goal!\n\nVisit this post on Shreddit to enjoy interactive features.)`;
      await post.setTextFallback({text: textFallback});

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

export const postsUpdaterJob = Devvit.addSchedulerJob({
  name: 'postsUpdaterJob',
  onRun: onPostsUpdaterJob,
});
