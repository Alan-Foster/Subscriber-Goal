/**
 * @file This file contains the types and functions for managing the subscription data of individual users.
 */

import {RedisClient} from '@devvit/public-api';
import {zScanAll} from 'devvit-helpers';

import {BasicUserData} from './basicData.js';
import {postRecentSubscriberSuffix, subscriberGoalsKey} from './subGoalData.js';

export const subscriberStatsKey = 'subscriber_stats';

export type SubscriberStats = {
  id: string;
  username: string;
  timestamp: number;
  subscribers: number;
}

/**
 * Type predicate to check if an object is of type SubscriberStats.
 * @param object - Any object to check.
 * @returns Returns `true` if the object is of type {@link SubscriberStats}, otherwise `false`.
 */
export function isSubscriberStats (object: unknown): object is SubscriberStats {
  if (!object || typeof object !== 'object') {
    return false;
  }
  const subStats = object as SubscriberStats;
  return typeof subStats.id === 'string'
      && typeof subStats.username === 'string'
      && typeof subStats.timestamp === 'number'
      && typeof subStats.subscribers === 'number';
}

/**
 * The function retrieves the subscriber stats for a given user ID from Redis.
 * @param redis - Instance of RedisClient.
 * @param userId - The full user ID of whose subscriber stats to retrieve (e.g. 't2_qikfu').
 * @returns Returns the subscriber stats for the user, or `undefined` if not found.
 */
export async function getSubscriberStats (redis: RedisClient, userId: string): Promise<SubscriberStats | undefined> {
  // Ideally we would use this, but it's not working properly for some reason: await redis.zRange(subscriberStatsKey, `[${userId}:`, `[${userId}:\xFF`, {by: 'lex'});
  const foundSubscribers = await zScanAll(redis, subscriberStatsKey, `${userId}:*`);
  if (foundSubscribers.length === 0) {
    return;
  }
  if (foundSubscribers.length > 1) {
    console.warn('Found multiple entries for user, this should not happen: ', JSON.stringify(foundSubscribers));
  }
  const [id, username, subscribers] = foundSubscribers[0].member.split(':');
  const subStats = {
    id,
    username,
    timestamp: foundSubscribers[0].score,
    subscribers: parseInt(subscribers),
  };
  if (!isSubscriberStats(subStats)) {
    console.error('Found invalid subscriber stats: ', JSON.stringify(foundSubscribers));
    return;
  }
  return subStats;
}

/**
 * Check whether an entry exists for a user ID in the subscriber stats.
 * @param redis - Instance of RedisClient.
 * @param userId - The full user ID of the user to check (e.g. 't2_qikfu').
 * @returns Returns `true` if the user subscription data is stored, otherwise `false`.
 */
export async function isTrackedSubscriber (redis: RedisClient, userId: string): Promise<boolean> {
  // This is a fancy way of getting entries that start with a prefix (in this case, the user ID)
  const subscriberStats = await getSubscriberStats(redis, userId);
  return subscriberStats !== undefined;
}

/**
 * Adds a new subscriber to the tracked subscriptions if they are not already subscribed.
 * @param redis - Instance of RedisClient.
 * @param postId - The ID of the post from which the user is subscribing.
 * @param currentSubscribers - The current number of subscribers at the time of their subscription.
 * @param user - BasicUserData object containing details about the user subscribing.
 * @returns Returns `true` if the user was successfully added as a subscriber, `false` if they were already subscribed.
 */
export async function setNewSubscriber (redis: RedisClient, postId: string, currentSubscribers: number, user: BasicUserData): Promise<boolean> {
  const alreadySubscribed = await isTrackedSubscriber(redis, user.id);
  if (alreadySubscribed) {
    return false;
  }

  await redis.hSet(subscriberGoalsKey, {
    [`${postId}${postRecentSubscriberSuffix}`]: user.username,
  });
  await redis.zAdd(subscriberStatsKey, {
    member: `${user.id}:${user.username}:${currentSubscribers}`,
    score: Date.now(),
  });
  return true;
}

/**
 * Removes a subscriber from the list of tracked subscriptions by their user ID.
 * @param redis - Instance of RedisClient.
 * @param userId - The full user ID of the user to untrack (e.g. 't2_qikfu').
 */
export async function untrackSubscriberById (redis: RedisClient, userId: string): Promise<void> {
  const foundRecords = await zScanAll(redis, subscriberStatsKey, `${userId}:*`);

  if (foundRecords.length > 0) {
    await redis.zRem(subscriberStatsKey, foundRecords.map(record => record.member));
  }
}

/**
 * Removes a subscriber from the list of tracked subscriptions by their username.
 * @param redis - Instance of RedisClient.
 * @param username - The username of the user to untrack.
 */
export async function untrackSubscriberByUsername (redis: RedisClient, username: string): Promise<void> {
  const foundRecords = await zScanAll(redis, subscriberStatsKey, `*:${username}:*`);

  if (foundRecords.length > 0) {
    await redis.zRem(subscriberStatsKey, foundRecords.map(record => record.member));
  }
}

// TODO: implement getAllSubscriberStats, not needed for now
