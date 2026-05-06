import type { ServerAppSettings } from '../settings';
import type { RedditClient, RedisClient } from '../types';
import type { SubGoalColorTheme } from '../../shared/subGoalColorTheme';
import { createGoalPost } from './post';
import {
  cancelAllAutoCreateNextGoals,
  registerNewSubGoalPost,
  setSubredditDisplayNameForPost,
  type CrosspostDispatchResult
} from '../data/subGoalData';
import { setSavedSubredditDisplayName } from '../data/subredditDisplayNameData';
import { getQueuedUpdates, getTrackedPosts, queueUpdate } from '../data/updaterData';
import { isLinkId } from '../types';
import { clearUserStickies } from '../utils/redditUtils';
import { applyTextFallback } from '../utils/textFallback';

type CreateSubscriberGoalOptions = {
  title: string;
  goal: number;
  subredditDisplayName: string;
  crosspost: boolean;
  colorTheme: SubGoalColorTheme;
  autoCreateNextGoal: boolean;
  cancelPendingAutoCreateGoals?: boolean;
};

export type CreateSubscriberGoalResult = {
  post: Awaited<ReturnType<typeof createGoalPost>>;
  crosspostDispatchResult: CrosspostDispatchResult;
};

export async function createSubscriberGoal({
  reddit,
  redis,
  appSettings,
  options
}: {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  options: CreateSubscriberGoalOptions;
}): Promise<CreateSubscriberGoalResult> {
  const subreddit = await reddit.getCurrentSubreddit();
  const appUser = await reddit.getAppUser();
  if (!appUser?.username) {
    throw new Error('Could not resolve app user.');
  }

  await clearUserStickies(reddit, appUser.username);

  const post = await createGoalPost({
    title: options.title,
    subredditName: subreddit.name
  });

  await applyTextFallback(post, {
    goal: options.goal,
    subscribers: subreddit.numberOfSubscribers,
    subredditName: options.subredditDisplayName,
    completedTime: null
  });
  await setSavedSubredditDisplayName(redis, options.subredditDisplayName);

  const crosspostDispatchResult = await registerNewSubGoalPost(
    reddit,
    redis,
    appSettings,
    post,
    options.goal,
    options.crosspost,
    options.subredditDisplayName,
    options.colorTheme,
    options.autoCreateNextGoal
  );

  const trackedPosts = await getTrackedPosts(redis);
  const queuedPosts = await getQueuedUpdates(redis);
  const activePostIds = [...new Set([...trackedPosts, ...queuedPosts])];
  for (const activePostId of activePostIds) {
    if (!isLinkId(activePostId)) {
      continue;
    }
    try {
      const activePost = await reddit.getPostById(activePostId);
      if (activePost.subredditId !== subreddit.id) {
        continue;
      }
      await setSubredditDisplayNameForPost(redis, activePostId, options.subredditDisplayName);
      await queueUpdate(redis, activePostId, new Date());
    } catch (backfillError) {
      console.warn(
        `Failed to backfill subreddit display name for active post ${activePostId}: ${String(
          backfillError
        )}`
      );
    }
  }

  await post.approve();
  await post.sticky();

  if (options.cancelPendingAutoCreateGoals) {
    await cancelAllAutoCreateNextGoals(redis);
  }

  return { post, crosspostDispatchResult };
}
