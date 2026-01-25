/**
 * @file This file contains the functions for keeping a list of all created subscriber goal posts and for managing their preview and completion updates (which happen as a scheduled job).
 */

import {RedisClient} from '@devvit/public-api';

export const postsKey = 'posts';
export const updatesKey = 'updater';

/**
 * This should be called when a new custom post is created by this app.
 * @param redis - Instance of RedisClient.
 * @param postId - Full ID of the post to track (e.g. 't3_18da1zl').
 * @param created - Date when the post was created.
 */
export async function trackPost (redis: RedisClient, postId: string, created: Date) {
  await redis.zAdd(postsKey, {member: postId, score: created.getTime()});
}

/**
 * This should only be called when a subscriber goal post is fully deleted. It should not be called when it is finished or removed by mods.
 * @param redis - Instance of RedisClient.
 * @param postId - Full ID of the post to track (e.g. 't3_18da1zl').
 */
export async function untrackPost (redis: RedisClient, postId: string) {
  await redis.zRem(postsKey, [postId]);
}

/**
 * This function returns a list of all tracked post IDs, meaning all subscriber goal custom posts that exist.
 * @param redis - Instance of RedisClient.
 * @returns List of all tracked post IDs.
 */
export async function getTrackedPosts (redis: RedisClient): Promise<string[]> {
  const zRangeResult = await redis.zRange(postsKey, 0, -1);
  return zRangeResult.map(result => result.member);
}

/**
 * This function returns a list of all post IDs that have been queued for updates.
 * @param redis - Instance of RedisClient.
 * @returns List of all post IDs that have been queued for updates.
 */
export async function getQueuedUpdates (redis: RedisClient): Promise<string[]> {
  const zRangeResult = await redis.zRange(updatesKey, 0, -1);
  return zRangeResult.map(result => result.member);
}

/**
 * This function queues a post for updates, meaning it will be processed by the scheduled job that updates the preview and completion status of posts.
 * @param redis - Instance of RedisClient.
 * @param postId - Full ID of the post to queue (e.g. 't3_18da1zl').
 * @param lastUpdate - Date when the post was last updated, which allows the scheduler to sort and update most out of date posts first.
 */
export async function queueUpdate (redis: RedisClient, postId: string, lastUpdate: Date) {
  await redis.zAdd(updatesKey, {member: postId, score: lastUpdate.getTime()});
}

/**
 * This function allows the bulk queuing of updates for multiple posts, it's mainly used to update the previews of all posts when the app is updated.
 * @param redis - Instance of RedisClient.
 * @param postIds - List of post IDs to queue for updates.
 */
export async function queueUpdates (redis: RedisClient, postIds: string[]) {
  const members = postIds.map(postId => ({member: postId, score: Date.now()}));
  await redis.zAdd(updatesKey, ...members);
}

/**
 * Cancels further updates for a post. This should be called when a subscriber goal post is updated to the completed state, or when it is deleted or removed by mods.
 * @param redis - Instance of RedisClient.
 * @param postId - Full ID of the post to cancel updates for (e.g. 't3_18da1zl').
 */
export async function cancelUpdates (redis: RedisClient, postId: string) {
  await redis.zRem(updatesKey, [postId]);
}
