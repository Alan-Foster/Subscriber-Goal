import type { RedisClient } from '../types';
import type { BasicUserData } from './basicData';
import { postRecentSubscriberSuffix, subscriberGoalsKey } from './subGoalData';

export const subscriberStatsKey = 'subscriber_stats';
export const subscriberStatsByUserIdKey = 'subscriber_stats_by_user_id';

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

type ParsedSubscriberMember = {
  id: string;
  username: string;
  subscribers: number;
  timestamp?: number;
};

const parseSubscriberMember = (member: string): ParsedSubscriberMember | undefined => {
  const [id, username, subscribers, timestamp] = member.split(':');
  if (!id || !username || !subscribers) {
    return undefined;
  }
  const parsedSubscribers = parseInt(subscribers, 10);
  if (Number.isNaN(parsedSubscribers)) {
    return undefined;
  }
  return {
    id,
    username,
    subscribers: parsedSubscribers,
    ...(timestamp && !Number.isNaN(parseInt(timestamp, 10))
      ? { timestamp: parseInt(timestamp, 10) }
      : {}),
  };
};

export async function getSubscriberStats(
  redis: RedisClient,
  userId: string
): Promise<SubscriberStats | undefined> {
  const indexedMember = await redis.hGet(subscriberStatsByUserIdKey, userId);
  if (indexedMember) {
    const parsed = parseSubscriberMember(indexedMember);
    if (parsed) {
      return {
        id: parsed.id,
        username: parsed.username,
        timestamp: parsed.timestamp ?? Date.now(),
        subscribers: parsed.subscribers,
      };
    }
    console.error(
      'Found malformed indexed subscriber stats record: ',
      JSON.stringify(indexedMember)
    );
  }

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
  const parsed = parseSubscriberMember(firstRecord.member);
  if (!parsed) {
    console.error('Found malformed subscriber stats record: ', JSON.stringify(firstRecord));
    return;
  }
  const subStats = {
    id: parsed.id,
    username: parsed.username,
    timestamp: firstRecord.score,
    subscribers: parsed.subscribers,
  };
  if (!isSubscriberStats(subStats)) {
    console.error('Found invalid subscriber stats: ', JSON.stringify(foundSubscribers));
    return;
  }
  await redis.hSet(subscriberStatsByUserIdKey, {
    [subStats.id]: `${subStats.id}:${subStats.username}:${subStats.subscribers}:${subStats.timestamp}`,
  });
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
  const now = Date.now();
  await redis.zAdd(subscriberStatsKey, {
    member: `${user.id}:${user.username}:${currentSubscribers}`,
    score: now,
  });
  await redis.hSet(subscriberStatsByUserIdKey, {
    [user.id]: `${user.id}:${user.username}:${currentSubscribers}:${now}`,
  });
  return true;
}

export async function untrackSubscriberById(
  redis: RedisClient,
  userId: string
): Promise<void> {
  await redis.hDel(subscriberStatsByUserIdKey, [userId]);
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
    const userIds = foundRecords
      .map((record) => parseSubscriberMember(record.member)?.id)
      .filter((id): id is string => Boolean(id));
    if (userIds.length > 0) {
      await redis.hDel(subscriberStatsByUserIdKey, userIds);
    }
    await redis.zRem(
      subscriberStatsKey,
      foundRecords.map((record) => record.member)
    );
  }
}
