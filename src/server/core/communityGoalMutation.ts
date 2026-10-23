import type { RedisClient } from "../types";

export const communityGoalMutationLockKey =
  "subscriber_goal_community_mutation_v1_lock";
export const communityGoalMutationLockTtlMs = 15 * 60 * 1000;

export type CommunityGoalMutationLease = {
  key: typeof communityGoalMutationLockKey;
  token: string;
};

export class CommunityGoalMutationInProgressError extends Error {
  constructor() {
    super("Another Subscriber Goal change is already in progress.");
    this.name = "CommunityGoalMutationInProgressError";
  }
}

export async function acquireCommunityGoalMutationLease(
  redis: RedisClient,
  nowMs = Date.now(),
): Promise<CommunityGoalMutationLease | undefined> {
  const token = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(communityGoalMutationLockKey, token, {
    nx: true,
    expiration: new Date(nowMs + communityGoalMutationLockTtlMs),
  });
  return (await redis.get(communityGoalMutationLockKey)) === token
    ? { key: communityGoalMutationLockKey, token }
    : undefined;
}

export async function releaseCommunityGoalMutationLease(
  redis: RedisClient,
  lease: CommunityGoalMutationLease,
): Promise<void> {
  if ((await redis.get(lease.key)) === lease.token) await redis.del(lease.key);
}

export async function withCommunityGoalMutationLease<T>(
  redis: RedisClient,
  operation: (lease: CommunityGoalMutationLease) => Promise<T>,
  existingLease?: CommunityGoalMutationLease,
): Promise<T> {
  if (existingLease) return operation(existingLease);
  const lease = await acquireCommunityGoalMutationLease(redis);
  if (!lease) throw new CommunityGoalMutationInProgressError();
  try {
    return await operation(lease);
  } finally {
    await releaseCommunityGoalMutationLease(redis, lease);
  }
}
