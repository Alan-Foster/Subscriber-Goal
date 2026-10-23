import type { RedisClient } from "../types";

export const highlightManagementStateKey =
  "subscriber_goal_highlight_management_v1_state";
export const highlightManagementVersion = "highlight_management_v1";

export type HighlightReconciliationContext =
  | "legacy_upgrade"
  | "repair"
  | "onboarding"
  | "manual_creation"
  | "automatic_successor";

export type HighlightManagementBaseline = {
  version: typeof highlightManagementVersion;
  canonicalPostId: string;
  highlighted: boolean;
  position: number | null;
  moderatorOverride: "none" | "unhighlighted" | "reordered";
  reconciledAt: number;
};

export async function getHighlightManagementBaseline(
  redis: RedisClient,
): Promise<HighlightManagementBaseline | undefined> {
  const raw = await redis.hGetAll(highlightManagementStateKey);
  if (
    raw.version !== highlightManagementVersion ||
    !raw.canonicalPostId ||
    !Number.isFinite(Number(raw.reconciledAt))
  ) {
    return undefined;
  }
  const rawPosition = Number(raw.position);
  const moderatorOverride =
    raw.moderatorOverride === "unhighlighted" ||
    raw.moderatorOverride === "reordered"
      ? raw.moderatorOverride
      : "none";
  return {
    version: highlightManagementVersion,
    canonicalPostId: raw.canonicalPostId,
    highlighted: raw.highlighted === "true",
    position:
      raw.position === "" || !Number.isFinite(rawPosition) ? null : rawPosition,
    moderatorOverride,
    reconciledAt: Number(raw.reconciledAt),
  };
}

export async function saveHighlightManagementBaseline(
  redis: RedisClient,
  baseline: Omit<HighlightManagementBaseline, "version">,
): Promise<void> {
  await redis.hSet(highlightManagementStateKey, {
    version: highlightManagementVersion,
    canonicalPostId: baseline.canonicalPostId,
    highlighted: String(baseline.highlighted),
    position: baseline.position === null ? "" : String(baseline.position),
    moderatorOverride: baseline.moderatorOverride,
    reconciledAt: String(baseline.reconciledAt),
  });
}

export async function clearHighlightManagementBaselineForPost(
  redis: RedisClient,
  postId: string,
): Promise<void> {
  const baseline = await getHighlightManagementBaseline(redis);
  if (baseline?.canonicalPostId === postId) {
    await redis.del(highlightManagementStateKey);
  }
}
