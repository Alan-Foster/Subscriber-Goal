import {Devvit, ScheduledJobEvent, TriggerContext} from '@devvit/public-api';

import {advancedPreviewMaker, AdvancedPreviewProps} from '../customPost/components/advancedPreview.js';
import {checkCompletionStatus, getSubGoalData} from '../data/subGoalData.js';
import {cancelUpdates, getQueuedUpdates, queueUpdate} from '../data/updaterData.js';
import {getAppSettings} from '../settings.js';

export async function onPostsUpdaterJob (event: ScheduledJobEvent<undefined>, context: TriggerContext) {
  console.log(`postsUpdaterJob job ran at ${new Date().toISOString()}`);

  const appSettings = await getAppSettings(context.settings);
  const subreddit = await context.reddit.getCurrentSubreddit();
  if (subreddit.name.toLowerCase() === appSettings.promoSubreddit.toLowerCase()) {
    // TODO: Implement r/SubGoal post creation here
  }

  const subredditIcon = (await context.reddit.getSubredditStyles(subreddit.id)).icon ?? 'https://i.redd.it/xaaj3xsdy0re1.png';

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

      const previewProps: AdvancedPreviewProps = {
        goal: subGoalData.goal,
        subscribers: subreddit.numberOfSubscribers,
        subredditName: subreddit.name,
        recentSubscriber: subGoalData.recentSubscriber,
        completedTime: subGoalData.completedTime ? new Date(subGoalData.completedTime) : null,
        subredditIcon,
      };

      const post = await context.reddit.getPostById(postId);
      await post.setCustomPostPreview(() => advancedPreviewMaker(previewProps));

      const textFallback = subGoalData.completedTime
        ? `r/${subreddit.name} reached ${subGoalData.goal} subscribers!\n\nGoal reached at ${new Date(subGoalData.completedTime).toLocaleTimeString('en', {timeZone: 'UTC'})} on ${new Date(subGoalData.completedTime).toLocaleDateString('en', {timeZone: 'UTC'})}`
        : `Welcome to r/${subreddit.name}\n\n${subreddit.numberOfSubscribers} / ${subGoalData.goal} subscribers.\n  Help us reach our goal!\n\n[Visit this post on Shreddit to enjoy interactive features](https://sh.reddit.com/${post.permalink})`;
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
