import {RedisClient} from '@devvit/public-api';

import {BasicUserData} from './basicData.js';

export type SubGoalData = {
  goal: number;
  header: string;
  recentSubscriber: string | null;
};

export type SubscriberStats = {
  id: string;
  username: string;
  timestamp: number;
  subscribers: number;
}

export async function getSubGoalData (redis: RedisClient, postId: string): Promise<SubGoalData> {
  const [goal, header, recentSubscriber] = await redis.hMGet('subscriber_goals', [
    `${postId}_goal`,
    `${postId}_header`,
    `${postId}_recent_subscriber`,
  ]) as [string | null, string | null, string | null];
  return {
    goal: goal ? parseInt(goal) : 0,
    header: header ?? '',
    recentSubscriber: recentSubscriber ?? null,
  };
}

export async function setSubGoalData (redis: RedisClient, postId: string, data: SubGoalData): Promise<void> {
  await redis.hSet('subscriber_goals', {
    [`${postId}_goal`]: data.goal.toString(),
    [`${postId}_header`]: data.header,
    [`${postId}_recent_subscriber`]: data.recentSubscriber ?? '',
  });
}

export async function isTrackedSubscriber (redis: RedisClient, userId: string): Promise<boolean> {
  // This is a fancy way of getting entries that start with a prefix (in this case, the user ID)
  const foundSubscribers = await redis.zRange('subscriber_stats', `[${userId}:`, `[${userId}:\xFF`, {by: 'lex'});
  return foundSubscribers.length > 0;
}

export async function setNewSubscriber (redis: RedisClient, postId: string, currentSubscribers: number, user: BasicUserData): Promise<boolean> {
  const alreadySubscribed = await isTrackedSubscriber(redis, user.id);
  if (alreadySubscribed) {
    return false;
  }

  await redis.hSet('subscriber_goals', {
    [`${postId}_recent_subscriber`]: user.username,
  });
  await redis.zAdd('subscriber_stats', {
    member: `${user.id}:${user.username}:${currentSubscribers}`,
    score: Date.now(),
  });
  return true;
}

// TODO: implement getSubscriberStats, either for a specific user or for all entries
