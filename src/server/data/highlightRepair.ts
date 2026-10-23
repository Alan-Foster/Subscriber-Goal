import type { RedisClient } from "../types";

export const appRepairStateKey = "app_repair_community_highlights_v2_state";
export const appRepairLockKey = "app_repair_community_highlights_v2_lock";
export const appRepairVersion = "app_repair_community_highlights_v2";

export async function scheduleHighlightRepair(
  redis: RedisClient,
  {
    nowMs = Date.now(),
    delayMs = Math.floor(Math.random() * 60_000),
    force = false,
    reason = "lifecycle",
    targetPostId,
  }: {
    nowMs?: number;
    delayMs?: number;
    force?: boolean;
    reason?: string;
    targetPostId?: string;
  } = {},
): Promise<void> {
  const current = await redis.hGetAll(appRepairStateKey);
  const existingPending =
    current.version === appRepairVersion && current.status === "pending";
  if (current.version === appRepairVersion && !force) return;
  const requestedRunAt = nowMs + Math.max(0, delayMs);
  const existingRunAt = Number(current.nextRunAt);
  const nextRunAt =
    existingPending && Number.isFinite(existingRunAt)
      ? Math.min(existingRunAt, requestedRunAt)
      : requestedRunAt;
  await redis.hSet(appRepairStateKey, {
    version: appRepairVersion,
    status: "pending",
    attempts: force ? current.attempts || "0" : "0",
    nextRunAt: String(nextRunAt),
    scheduledAt: current.scheduledAt || String(nowMs),
    lastError: force ? current.lastError || "" : "",
    reason,
    targetPostId: targetPostId ?? current.targetPostId ?? "",
  });
}
