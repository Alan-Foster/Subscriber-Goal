import type { RedisClient } from "../types";

export const highlightManagementStateKey =
  "subscriber_goal_highlight_management_v2_state";

export type HighlightReconciliationContext =
  | "legacy_upgrade"
  | "repair"
  | "onboarding"
  | "manual_creation"
  | "automatic_successor";

type CanonicalGoalPointer = {
  canonicalPostId: string;
  reconciledAt: number;
};

export async function getCanonicalGoalPointer(
  redis: RedisClient,
): Promise<CanonicalGoalPointer | undefined> {
  const [canonicalPostId, rawReconciledAt] = await redis.hMGet(
    highlightManagementStateKey,
    ["canonicalPostId", "reconciledAt"],
  );
  const reconciledAt = Number(rawReconciledAt ?? NaN);
  if (!canonicalPostId || !Number.isFinite(reconciledAt)) return undefined;
  return { canonicalPostId, reconciledAt };
}

export async function saveCanonicalGoalPointer(
  redis: RedisClient,
  { canonicalPostId, reconciledAt }: CanonicalGoalPointer,
): Promise<void> {
  await redis.hSet(highlightManagementStateKey, {
    canonicalPostId,
    reconciledAt: String(reconciledAt),
  });
}

export async function clearCanonicalGoalPointerForPost(
  redis: RedisClient,
  postId: string,
): Promise<void> {
  const pointer = await getCanonicalGoalPointer(redis);
  if (pointer?.canonicalPostId === postId) {
    await redis.del(highlightManagementStateKey);
  }
}
