import type { RedisClient } from "../types";
import { acquireRedisLock, releaseRedisLock } from "../utils/redisOwnedLock";
import { boundedLockTtlMs, userFacingLockTtlMs } from "../utils/lockTtl";
import {
  logLeaseBusy,
  logLeaseTiming,
  recordLeaseHolder,
} from "./communityGoalLeaseDiagnostics";

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
  label = "unlabeled",
): Promise<CommunityGoalMutationLease | undefined> {
  const token = await acquireRedisLock(
    redis,
    communityGoalMutationLockKey,
    communityGoalMutationLockTtlMs,
    { nowMs },
  );
  if (!token) return undefined;
  await recordLeaseHolder(redis, label, nowMs, communityGoalMutationLockTtlMs);
  return { key: communityGoalMutationLockKey, token };
}

export async function releaseCommunityGoalMutationLease(
  redis: RedisClient,
  lease: CommunityGoalMutationLease,
): Promise<void> {
  await releaseRedisLock(redis, lease.key, lease.token);
}

/**
 * Runs `operation` while holding the community-wide mutation lease.
 * `label` names the caller in timing and "lock busy" logs (#237, R-S7-01).
 */
export async function withCommunityGoalMutationLease<T>(
  redis: RedisClient,
  operation: (lease: CommunityGoalMutationLease) => Promise<T>,
  existingLease?: CommunityGoalMutationLease,
  retry?: { maxWaitMs: number; intervalMs: number },
  label = "unlabeled",
): Promise<T> {
  if (existingLease) return operation(existingLease);
  const startedAt = Date.now();
  const deadline = startedAt + (retry?.maxWaitMs ?? 0);
  let lease = await acquireCommunityGoalMutationLease(redis, startedAt, label);
  while (!lease && retry) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(retry.intervalMs, remaining)),
    );
    lease = await acquireCommunityGoalMutationLease(redis, Date.now(), label);
  }
  const acquiredAt = Date.now();
  if (!lease) {
    await logLeaseBusy(redis, label, acquiredAt - startedAt, acquiredAt);
    throw new CommunityGoalMutationInProgressError();
  }
  try {
    return await operation(lease);
  } finally {
    await releaseCommunityGoalMutationLease(redis, lease);
    logLeaseTiming(label, acquiredAt - startedAt, Date.now() - acquiredAt);
  }
}
