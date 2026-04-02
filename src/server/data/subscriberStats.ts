import type { RedisClient } from '../types';
import type { BasicUserData } from './basicData';
import { postRecentSubscriberSuffix, subscriberGoalsKey } from './subGoalData';

export const subscriberStatsKey = 'subscriber_stats';

export type SubscriberStats = {
  id: string;
  username: string;
  timestamp: number;
  subscribers: number;
};

export function isSubscriberStats(object: unknown): object is SubscriberStats {
  if (!object || typeof object !== 'object') {
    return false;
  }
  const subStats = object as SubscriberStats;
  return (
    typeof subStats.id === 'string' &&
    typeof subStats.username === 'string' &&
    typeof subStats.timestamp === 'number' &&
    typeof subStats.subscribers === 'number'
  );
}

const getMatchingSubscribers = async (
  redis: RedisClient,
  match: (member: string) => boolean
) => {
  const allSubscribers = await redis.zRange(subscriberStatsKey, 0, -1);
  return allSubscribers.filter((record) => match(record.member));
};

export async function getSubscriberStats(
  redis: RedisClient,
  userId: string
): Promise<SubscriberStats | undefined> {
  const foundSubscribers = await getMatchingSubscribers(redis, (member) =>
    member.startsWith(`${userId}:`)
  );
  if (foundSubscribers.length === 0) {
    return;
  }
  if (foundSubscribers.length > 1) {
    console.warn(
      'Found multiple entries for user, this should not happen: ',
      JSON.stringify(foundSubscribers)
    );
  }
  const firstRecord = foundSubscribers[0];
  if (!firstRecord) {
    return;
  }
  const [id, username, subscribers] = firstRecord.member.split(':');
  if (!id || !username || !subscribers) {
    console.error('Found malformed subscriber stats record: ', JSON.stringify(firstRecord));
    return;
  }
  const parsedSubscribers = parseInt(subscribers, 10);
  if (Number.isNaN(parsedSubscribers)) {
    console.error('Found malformed subscriber count in stats record: ', JSON.stringify(firstRecord));
    return;
  }
  const subStats = {
    id,
    username,
    timestamp: firstRecord.score,
    subscribers: parsedSubscribers,
  };
  if (!isSubscriberStats(subStats)) {
    console.error('Found invalid subscriber stats: ', JSON.stringify(foundSubscribers));
    return;
  }
  return subStats;
}

export async function isTrackedSubscriber(
  redis: RedisClient,
  userId: string
): Promise<boolean> {
  const subscriberStats = await getSubscriberStats(redis, userId);
  return subscriberStats !== undefined;
}

export async function setNewSubscriber(
  redis: RedisClient,
  postId: string,
  currentSubscribers: number,
  user: BasicUserData,
  shareUsername: boolean
): Promise<boolean> {
  const alreadySubscribed = await isTrackedSubscriber(redis, user.id);
  if (alreadySubscribed) {
    return false;
  }

  await redis.hSet(subscriberGoalsKey, {
    [`${postId}${postRecentSubscriberSuffix}`]: shareUsername ? user.username : '',
  });
  await redis.zAdd(subscriberStatsKey, {
    member: `${user.id}:${user.username}:${currentSubscribers}`,
    score: Date.now(),
  });
  return true;
}

export async function untrackSubscriberById(
  redis: RedisClient,
  userId: string
): Promise<void> {
  const foundRecords = await getMatchingSubscribers(redis, (member) =>
    member.startsWith(`${userId}:`)
  );

  if (foundRecords.length > 0) {
    await redis.zRem(
      subscriberStatsKey,
      foundRecords.map((record) => record.member)
    );
  }
}

export async function untrackSubscriberByUsername(
  redis: RedisClient,
  username: string
): Promise<void> {
  const matchToken = `:${username}:`;
  const foundRecords = await getMatchingSubscribers(redis, (member) =>
    member.includes(matchToken)
  );

  if (foundRecords.length > 0) {
    await redis.zRem(
      subscriberStatsKey,
      foundRecords.map((record) => record.member)
    );
  }
}
