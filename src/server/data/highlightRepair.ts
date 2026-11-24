import type { RedisClient } from "../types";
import {
  createJobCodec,
  flagField,
  jobRecordFields,
  textField,
  timeField,
} from "../jobs/record";
import { updateJobRecord } from "../jobs/queue";

export const appRepairStateKey = "app_repair_community_highlights_v3_state";
export const appRepairLockKey = "app_repair_community_highlights_v3_lock";
export const recurringHighlightRepairIntervalMs = 6 * 60 * 60 * 1000;
export const appRepairVersion = "app_repair_community_highlights_v3";

const appRepairCodec = createJobCodec({
  ...jobRecordFields,
  scheduledAt: timeField,
  reason: textField,
  targetPostId: textField,
  flairBackfillTemplateId: textField,
  flairBackfillAfterPostId: textField,
  flairBackfillHadFailures: flagField,
  flairBackfillComplete: flagField,
});

export const appRepairJob = {
  id: "app_repair",
  stateKey: appRepairStateKey,
  version: appRepairVersion,
  codec: appRepairCodec,
};

export type AppRepairRecord = ReturnType<typeof appRepairCodec.parse>;

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
  await updateJobRecord(redis, appRepairJob, (current) => {
    const currentVersion = current.version === appRepairVersion;
    const restartingCompleted = currentVersion && current.status === "complete";
    if (currentVersion && !force && !restartingCompleted) return;

    const existingRunAt = current.nextRunAt;
    const nextRunAt =
      currentVersion && current.status === "pending" && existingRunAt != null
        ? Math.min(existingRunAt, requestedRunAt)
        : requestedRunAt;
    const preserveRetry = force && !restartingCompleted;
    return {
      version: appRepairVersion,
      status: "pending",
      attempts: preserveRetry ? (current.attempts ?? 0) : 0,
      nextRunAt: nextRunAt,
      scheduledAt:
        restartingCompleted || current.status === "processing"
          ? nowMs
          : (current.scheduledAt ?? nowMs),
      lastError: preserveRetry ? current.lastError || "" : "",
      reason,
      targetPostId:
        targetPostId ?? (restartingCompleted ? "" : current.targetPostId) ?? "",
    };
  });
}
