import {Devvit, ScheduledJobEvent, TriggerContext} from '@devvit/public-api';

import {previewMaker, PreviewProps, textFallbackMaker} from '../customPost/components/preview.js';
import {checkCompletionStatus, getSubGoalData} from '../data/subGoalData.js';
import {cancelUpdates, getQueuedUpdates, queueUpdate} from '../data/updaterData.js';
import {getSubredditIcon} from '../utils/subredditUtils.js';

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

export const postsUpdaterJob = Devvit.addSchedulerJob({
  name: 'postsUpdaterJob',
  onRun: onPostsUpdaterJob,
});
