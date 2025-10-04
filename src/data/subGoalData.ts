/**
 * @file This file contains the functions for managing the data of individual subscriber goal posts.
 */

import {Post, RedditAPIClient, RedisClient} from '@devvit/public-api';

import {sendPostCreateEvent} from '../services/wikiEventService/producers/postCreateSender.js';
import {AppSettings} from '../settings.js';
import {queueUpdate, trackPost} from './updaterData.js';

export const subscriberGoalsKey = 'subscriber_goals';
export const postGoalSuffix = '_goal';
export const postRecentSubscriberSuffix = '_recent_subscriber';
export const postCompletedTimeSuffix = '_completed_time';

export type SubGoalData = {
  goal: number;
  recentSubscriber: string | null;
  completedTime: number;
  sendWikiEvents?: boolean;
  showRecentSubscriber?: boolean;
  subredditDisplayName?: string;
};

/**
 * Retrieves the subscriber goal data for a specific post from Redis.
 * @param redis - Instance of RedisClient.
 * @param postId - The ID of the post for which to retrieve the sub-goal data.
 * @returns Data about the subscriber goal for the specified post, or an object with default values if not found (goal is 0, recentSubscriber is null, completedTime is 0).
 */
export async function getSubGoalData (redis: RedisClient, postId: string): Promise<SubGoalData> {
  const [goal, recentSubscriber, completedTime] = await redis.hMGet(subscriberGoalsKey, [
    `${postId}${postGoalSuffix}`,
    `${postId}${postRecentSubscriberSuffix}`,
    `${postId}${postCompletedTimeSuffix}`,
  ]) as [string | null, string | null, string | null, string | null];
  return {
    goal: goal ? parseInt(goal) : 0,
    recentSubscriber: recentSubscriber ?? null,
    completedTime: completedTime ? parseInt(completedTime) : 0,
  };
}

/**
 * Sets the subscriber goal data for a specific post in Redis.
 * @param redis - Instance of RedisClient.
 * @param postId - The full ID of the post for which to set the sub-goal data.
 * @param data - The SubGoalData object containing the goal, most recent subscriber, and completion time.
 */
export async function setSubGoalData (redis: RedisClient, postId: string, data: SubGoalData): Promise<void> {
  await redis.hSet(subscriberGoalsKey, {
    [`${postId}${postGoalSuffix}`]: data.goal.toString(),
    [`${postId}${postRecentSubscriberSuffix}`]: data.recentSubscriber ?? '',
    [`${postId}${postCompletedTimeSuffix}`]: data.completedTime.toString(),
  });
}

/**
 * This function checks if a subscriber goal has been completed for a specific post, it both reads and updates the completion state.
 * @param reddit - Instance of RedditAPIClient.
 * @param redis - Instance of RedisClient.
 * @param postId - The ID of the post for which to check the completion status.
 * @returns Timestamp of when the goal was completed, or 0 if it has not been completed yet.
 */
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

/**
 * Registers a new subscriber goal post in Redis, queues it for updates, and calls {@linkcode dispatchNewPost} to send it to the central subreddit (unless disabled).
 * @param reddit - Instance of RedditAPIClient.
 * @param redis - Instance of RedisClient.
 * @param appSettings - Application settings object, specifically used for setting the central promo subreddit and optionally disabling that feature.
 * @param post - This is the Devvit Post object that is returned when a post is submitted.
 * @param goal - The subscriber goal for this post.
 * @param crosspost - Whether to crosspost this to the central subreddit.
 */
export async function registerNewSubGoalPost (reddit: RedditAPIClient, redis: RedisClient, appSettings: AppSettings, post: Post, goal: number, crosspost: boolean): Promise<void> {
  await setSubGoalData(redis, post.id, {
    goal,
    recentSubscriber: '',
    completedTime: 0,
  });
  await trackPost(redis, post.id, post.createdAt);
  await queueUpdate(redis, post.id, post.createdAt);
  if (appSettings.promoSubreddit.toLowerCase() !== post.subredditName.toLowerCase()) {
    await sendPostCreateEvent({
      reddit,
      targetSubredditName: appSettings.promoSubreddit,
      post,
      subGoalData: {
        goal,
        recentSubscriber: '',
        completedTime: 0,
        sendWikiEvents: crosspost,
        subredditDisplayName: post.subredditName,
      },
    });
  }
}

/**
 * This function purges a username from the recent subscribers list for all posts tracked by the current app installation.
 * @param redis - Instance of RedisClient.
 * @param username - The username to be erased from the recent subscribers list.
 */
export async function eraseFromRecentSubscribers (redis: RedisClient, username: string): Promise<void> {
  const foundRecords = await redis.hGetAll(subscriberGoalsKey);
  const keysToUpdate: Record<string, string> = {};

  username = username.toLowerCase();

  for (const key in foundRecords) {
    if (foundRecords[key].toLowerCase() === username && key.endsWith(postRecentSubscriberSuffix)) {
      keysToUpdate[key] = '';
    }
  }

  if (Object.keys(keysToUpdate).length > 0) {
    await redis.hSet(subscriberGoalsKey, keysToUpdate);
  }
}
