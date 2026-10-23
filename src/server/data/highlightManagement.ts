import type { HighlightLabelType } from "@devvit/reddit";
import type { RedisClient } from "../types";

export const highlightManagementStateKey =
  "subscriber_goal_highlight_management_v2_state";
export const legacyHighlightManagementStateKey =
  "subscriber_goal_highlight_management_v1_state";
export const highlightManagementVersion = "highlight_management_v2";

export type HighlightReconciliationContext =
  | "legacy_upgrade"
  | "repair"
  | "onboarding"
  | "manual_creation"
  | "automatic_successor";

export type HighlightModeratorOverride =
  | "none"
  | "unhighlighted"
  | "reordered"
  | "expired";

export type HighlightManagementBaselineV2 = {
  version: typeof highlightManagementVersion;
  canonicalPostId: string;
  highlighted: boolean;
  position: number | null;
  highlightLabel: HighlightLabelType | null;
  highlightedUntil: number | null;
  moderatorOverride: HighlightModeratorOverride;
  reconciledAt: number;
  migratedFromVersion?: "highlight_management_v1";
};

export type HighlightManagementBaseline = HighlightManagementBaselineV2;

export async function getHighlightManagementBaseline(
  redis: RedisClient,
): Promise<HighlightManagementBaseline | undefined> {
  let raw = await redis.hGetAll(highlightManagementStateKey);
  let legacy = false;
  if (raw.version !== highlightManagementVersion) {
    raw = await redis.hGetAll(legacyHighlightManagementStateKey);
    legacy = true;
  }
  if (
    (!legacy && raw.version !== highlightManagementVersion) ||
    (legacy && raw.version !== "highlight_management_v1") ||
    !raw.canonicalPostId ||
    !Number.isFinite(Number(raw.reconciledAt))
  ) {
    return undefined;
  }
  const rawPosition = Number(raw.position);
  const moderatorOverride: HighlightModeratorOverride =
    raw.moderatorOverride === "unhighlighted" ||
    raw.moderatorOverride === "reordered" ||
    raw.moderatorOverride === "expired"
      ? raw.moderatorOverride
      : "none";
  const highlightedUntil = Number(raw.highlightedUntil);
  const highlightLabel =
    raw.highlightLabel === "ANNOUNCEMENT" ||
    raw.highlightLabel === "EVENT" ||
    raw.highlightLabel === "MEGATHREAD" ||
    raw.highlightLabel === "SHOW_POST_FLAIR"
      ? raw.highlightLabel
      : null;
  return {
    version: highlightManagementVersion,
    canonicalPostId: raw.canonicalPostId,
    highlighted: raw.highlighted === "true",
    position:
      raw.position === "" || !Number.isFinite(rawPosition) ? null : rawPosition,
    highlightLabel,
    highlightedUntil:
      raw.highlightedUntil === "" || !Number.isFinite(highlightedUntil)
        ? null
        : highlightedUntil,
    moderatorOverride,
    reconciledAt: Number(raw.reconciledAt),
    ...(legacy
      ? { migratedFromVersion: "highlight_management_v1" as const }
      : {}),
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
    highlightLabel: baseline.highlightLabel ?? "",
    highlightedUntil:
      baseline.highlightedUntil === null
        ? ""
        : String(baseline.highlightedUntil),
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
    await redis.del(legacyHighlightManagementStateKey);
  }
}
