import type { RedisClient } from "../types";

export const appRepairStateKey = "app_repair_community_highlights_v3_state";
export const appRepairLockKey = "app_repair_community_highlights_v3_lock";
export const recurringHighlightRepairIntervalMs = 6 * 60 * 60 * 1000;
export const appRepairVersion = "app_repair_community_highlights_v3";

export async function updateAppRepairState(
  redis: RedisClient,
  update: (
    current: Record<string, string>,
  ) => Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const transaction = await redis.watch(appRepairStateKey);
    let multiStarted = false;
    try {
      const current = await redis.hGetAll(appRepairStateKey);
      const changes = update(current);
      if (!changes) {
        await transaction.unwatch();
        return undefined;
      }
      await transaction.multi();
      multiStarted = true;
      await transaction.hSet(appRepairStateKey, changes);
      if ((await transaction.exec()).length > 0) return current;
    } catch (error) {
      try {
        await (multiStarted ? transaction.discard() : transaction.unwatch());
      } catch {
        // diagnostic-allow-silent: preserve the original transaction error.
      }
      throw error;
    }
  }
  throw new Error("App repair state changed during every update attempt.");
}

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
  const requestedRunAt = nowMs + Math.max(0, delayMs);
  await updateAppRepairState(redis, (current) => {
    const currentVersion = current.version === appRepairVersion;
    const restartingCompleted = currentVersion && current.status === "complete";
    if (currentVersion && !force && !restartingCompleted) return;

    const existingRunAt = Number(current.nextRunAt);
    const nextRunAt =
      currentVersion &&
      current.status === "pending" &&
      Number.isFinite(existingRunAt)
        ? Math.min(existingRunAt, requestedRunAt)
        : requestedRunAt;
    const preserveRetry = force && !restartingCompleted;
    return {
      version: appRepairVersion,
      status: "pending",
      attempts: preserveRetry ? current.attempts || "0" : "0",
      nextRunAt: String(nextRunAt),
      scheduledAt:
        restartingCompleted || current.status === "processing"
          ? String(nowMs)
          : current.scheduledAt || String(nowMs),
      lastError: preserveRetry ? current.lastError || "" : "",
      reason,
      targetPostId:
        targetPostId ?? (restartingCompleted ? "" : current.targetPostId) ?? "",
    };
  });
}
