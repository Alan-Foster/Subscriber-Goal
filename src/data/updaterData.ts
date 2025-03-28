import {RedisClient} from '@devvit/public-api';

export const postsKey = 'posts';
export const updatesKey = 'updater';

export async function trackPost (redis: RedisClient, postId: string, created: Date) {
  await redis.zAdd(postsKey, {member: postId, score: created.getTime()});
}

export async function untrackPost (redis: RedisClient, postId: string) {
  await redis.zRem(postsKey, [postId]);
}

export async function getTrackedPosts (redis: RedisClient): Promise<string[]> {
  const zRangeResult = await redis.zRange(postsKey, 0, -1);
  return zRangeResult.map(result => result.member);
}

export async function getQueuedUpdates (redis: RedisClient): Promise<string[]> {
  const zRangeResult = await redis.zRange(updatesKey, 0, -1);
  return zRangeResult.map(result => result.member);
}

export async function queueUpdate (redis: RedisClient, postId: string, lastUpdate: Date) {
  await redis.zAdd(updatesKey, {member: postId, score: lastUpdate.getTime()});
}

export async function queueUpdates (redis: RedisClient, postIds: string[]) {
  const members = postIds.map(postId => ({member: postId, score: Date.now()}));
  await redis.zAdd(updatesKey, ...members);
}

export async function cancelUpdates (redis: RedisClient, postId: string) {
  await redis.zRem(updatesKey, [postId]);
}
