import type { RedisClient } from "../types";

export const subscriberGoalPostRegistryKey = "subscriber_goal_post_registry_v1";

export async function registerSubscriberGoalPost(
  redis: RedisClient,
  postId: string,
  createdAt: Date | number,
): Promise<void> {
  const score = createdAt instanceof Date ? createdAt.getTime() : createdAt;
  await redis.zAdd(subscriberGoalPostRegistryKey, {
    member: postId,
    score: Number.isFinite(score) ? score : Date.now(),
  });
}

export async function removeSubscriberGoalPost(
  redis: RedisClient,
  postId: string,
): Promise<void> {
  await redis.zRem(subscriberGoalPostRegistryKey, [postId]);
}

export async function getRegisteredSubscriberGoalPosts(
  redis: RedisClient,
): Promise<string[]> {
  const entries = await redis.zRange(subscriberGoalPostRegistryKey, 0, -1);
  return entries.map((entry) => entry.member);
}
