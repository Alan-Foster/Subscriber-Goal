import {Post, RedditAPIClient, RedisClient} from '@devvit/public-api';

import {queueUpdate, trackPost} from './updaterData.js';

export const subscriberGoalsKey = 'subscriber_goals';

export type SubGoalData = {
  goal: number;
  recentSubscriber: string | null;
  completedTime: number;
};

export async function getSubGoalData (redis: RedisClient, postId: string): Promise<SubGoalData> {
  const [goal, recentSubscriber, completedTime] = await redis.hMGet(subscriberGoalsKey, [
    `${postId}_goal`,
    `${postId}_recent_subscriber`,
    `${postId}_completed_time`,
  ]) as [string | null, string | null, string | null, string | null];
  return {
    goal: goal ? parseInt(goal) : 0,
    recentSubscriber: recentSubscriber ?? null,
    completedTime: completedTime ? parseInt(completedTime) : 0,
  };
}

export async function setSubGoalData (redis: RedisClient, postId: string, data: SubGoalData): Promise<void> {
  await redis.hSet(subscriberGoalsKey, {
    [`${postId}_goal`]: data.goal.toString(),
    [`${postId}_recent_subscriber`]: data.recentSubscriber ?? '',
    [`${postId}_completed_time`]: data.completedTime.toString(),
  });
}

export async function checkCompletionStatus (reddit: RedditAPIClient, redis: RedisClient, postId: string): Promise<number> {
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

export async function registerNewSubGoalPost (redis: RedisClient, post: Post, goal: number): Promise<void> {
  await setSubGoalData(redis, post.id, {
    goal,
    recentSubscriber: '',
    completedTime: 0,
  });
  await trackPost(redis, post.id, post.createdAt);
  await queueUpdate(redis, post.id, post.createdAt);
}
