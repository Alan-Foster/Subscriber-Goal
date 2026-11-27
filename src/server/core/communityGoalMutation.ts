import type { RedisClient } from "../types";
import { acquireRedisLock, releaseRedisLock } from "../utils/redisOwnedLock";
import { boundedLockTtlMs, userFacingLockTtlMs } from "../utils/lockTtl";

export const communityGoalMutationLockKey =
  "subscriber_goal_community_mutation_v1_lock";
export const communityGoalMutationLockTtlMs = boundedLockTtlMs(
  "community_goal_mutation",
  userFacingLockTtlMs,
);

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
  const token = await acquireRedisLock(
    redis,
    communityGoalMutationLockKey,
    communityGoalMutationLockTtlMs,
    { nowMs },
  );
  return token ? { key: communityGoalMutationLockKey, token } : undefined;
}

export async function releaseCommunityGoalMutationLease(
  redis: RedisClient,
  lease: CommunityGoalMutationLease,
): Promise<void> {
  await releaseRedisLock(redis, lease.key, lease.token);
}

export async function withCommunityGoalMutationLease<T>(
  redis: RedisClient,
  operation: (lease: CommunityGoalMutationLease) => Promise<T>,
  existingLease?: CommunityGoalMutationLease,
  retry?: { maxWaitMs: number; intervalMs: number },
): Promise<T> {
  if (existingLease) return operation(existingLease);
  const deadline = Date.now() + (retry?.maxWaitMs ?? 0);
  let lease = await acquireCommunityGoalMutationLease(redis);
  while (!lease && retry) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(retry.intervalMs, remaining)),
    );
    lease = await acquireCommunityGoalMutationLease(redis);
  }
  if (!lease) throw new CommunityGoalMutationInProgressError();
  try {
    return await operation(lease);
  } finally {
    await releaseCommunityGoalMutationLease(redis, lease);
  }
}
