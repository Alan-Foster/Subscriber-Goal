import type { RedditClient, RedisClient } from '../types';
import type { AppSettings } from '../settings';
import { dispatchNewPost } from './crosspostData';
import { queueUpdate, trackPost } from './updaterData';

export const subscriberGoalsKey = 'subscriber_goals';
export const postGoalSuffix = '_goal';
export const postRecentSubscriberSuffix = '_recent_subscriber';
export const postCompletedTimeSuffix = '_completed_time';

export type SubGoalData = {
  goal: number;
  recentSubscriber: string | null;
  completedTime: number;
};

type RedditPost = Awaited<ReturnType<RedditClient['submitCustomPost']>>;

export async function getSubGoalData(
  redis: RedisClient,
  postId: string
): Promise<SubGoalData> {
  const [goal, recentSubscriber, completedTime] = (await redis.hMGet(
    subscriberGoalsKey,
    [
      `${postId}${postGoalSuffix}`,
      `${postId}${postRecentSubscriberSuffix}`,
      `${postId}${postCompletedTimeSuffix}`,
    ]
  )) as [string | null, string | null, string | null, string | null];
  return {
    goal: goal ? parseInt(goal) : 0,
    recentSubscriber: recentSubscriber ?? null,
    completedTime: completedTime ? parseInt(completedTime) : 0,
  };
}

export async function setSubGoalData(
  redis: RedisClient,
  postId: string,
  data: SubGoalData
): Promise<void> {
  await redis.hSet(subscriberGoalsKey, {
    [`${postId}${postGoalSuffix}`]: data.goal.toString(),
    [`${postId}${postRecentSubscriberSuffix}`]: data.recentSubscriber ?? '',
    [`${postId}${postCompletedTimeSuffix}`]: data.completedTime.toString(),
  });
}

export async function checkCompletionStatus(
  reddit: RedditClient,
  redis: RedisClient,
  postId: string
): Promise<number> {
  const subGoalData = await getSubGoalData(redis, postId);
  if (subGoalData.completedTime) {
    return subGoalData.completedTime;
  }

  const currentSubscribers = (await reddit.getCurrentSubreddit()).numberOfSubscribers;
  if (currentSubscribers >= subGoalData.goal) {
    subGoalData.completedTime = Date.now();
    await setSubGoalData(redis, postId, subGoalData);
    return subGoalData.completedTime;
  }
  return 0;
}

export async function registerNewSubGoalPost(
  reddit: RedditClient,
  redis: RedisClient,
  appSettings: AppSettings,
  post: RedditPost,
  goal: number,
  crosspost: boolean
): Promise<void> {
  await setSubGoalData(redis, post.id, {
    goal,
    recentSubscriber: '',
    completedTime: 0,
  });
  await trackPost(redis, post.id, post.createdAt);
  await queueUpdate(redis, post.id, post.createdAt);
  if (
    appSettings.promoSubreddit.toLowerCase() !== post.subredditName.toLowerCase() &&
    crosspost
  ) {
    await dispatchNewPost(reddit, appSettings, post.id, goal);
  }
}

export async function eraseFromRecentSubscribers(
  redis: RedisClient,
  username: string
): Promise<void> {
  const foundRecords = await redis.hGetAll(subscriberGoalsKey);
  const keysToUpdate: Record<string, string> = {};

  const normalized = username.toLowerCase();

  for (const key in foundRecords) {
    if (
      foundRecords[key].toLowerCase() === normalized &&
      key.endsWith(postRecentSubscriberSuffix)
    ) {
      keysToUpdate[key] = '';
    }
  }

  if (Object.keys(keysToUpdate).length > 0) {
    await redis.hSet(subscriberGoalsKey, keysToUpdate);
  }
}
