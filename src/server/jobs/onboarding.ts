import { logDiagnostic } from "../../shared/diagnostics";
import { processDueOnboarding } from "../core/onboarding";
import { parseOnboardingState } from "../core/onboardingGoalState";
import { AUTOMATIC_ONBOARDING_ENABLED } from "../core/onboardingSubscriberGoal";
import {
  hasEmbeddedOnboardingWarning,
  onboardingSubscriberGoalStateKey,
  readOnboardingWarningFields,
} from "../core/onboardingState";
import { parseOnboardingReminderState } from "../core/onboardingWarning";
import type { RedisClient } from "../types";
import { dueJobsKey, updateJobRecord } from "./queue";
import { createJobCodec, jobRecordFields, timeField } from "./record";
import { defineDueJob, dispatchDueJobs } from "./runner";

const onboardingJob = {
  id: "onboarding",
  stateKey: "onboarding_job_v1_state",
  version: "1",
  codec: createJobCodec({ ...jobRecordFields, sourceDueAt: timeField }),
};

async function nextOnboardingDeadline(
  redis: RedisClient,
): Promise<number | undefined> {
  const workflow = await redis.hGetAll(onboardingSubscriberGoalStateKey);
  const warningFields = await readOnboardingWarningFields(redis, workflow);
  if (
    !hasEmbeddedOnboardingWarning(workflow) &&
    Object.keys(warningFields).length
  )
    return 0;

  const warning = parseOnboardingReminderState(warningFields);
  const goal = parseOnboardingState(workflow);
  if (warning?.status === "dispatching") return 0;
  if (!goal) return AUTOMATIC_ONBOARDING_ENABLED ? 0 : undefined;
  if (goal.status === "complete") return;
  if ((goal.pausedAt !== undefined) === AUTOMATIC_ONBOARDING_ENABLED) return 0;
  if (goal.status !== "awaiting_warning") {
    return AUTOMATIC_ONBOARDING_ENABLED ? goal.nextRunAt : undefined;
  }
  if (warning?.status === "complete") return 0;
  if (!warning) return AUTOMATIC_ONBOARDING_ENABLED ? 0 : undefined;
  if ((warning.pausedAt !== undefined) === AUTOMATIC_ONBOARDING_ENABLED)
    return 0;
  return AUTOMATIC_ONBOARDING_ENABLED ? warning.nextRunAt : undefined;
}

async function indexOnboardingJob(redis: RedisClient): Promise<void> {
  // The workflow hash remains authoritative for lifecycle writers and replay.
  const sourceDueAt = await nextOnboardingDeadline(redis);
  const indexedAt = await redis.zScore(dueJobsKey, onboardingJob.id);
  if (indexedAt === sourceDueAt) return;
  await updateJobRecord(redis, onboardingJob, (record) => {
    if (record.status === "processing") return;
    if (sourceDueAt === undefined) return null;
    if (record.sourceDueAt === sourceDueAt && indexedAt != null) return;
    return {
      version: onboardingJob.version,
      status: "pending",
      nextRunAt: sourceDueAt,
      sourceDueAt,
      attempts: 0,
    };
  });
}

export async function dispatchOnboardingJob(
  options: Pick<
    Parameters<typeof processDueOnboarding>[0],
    "reddit" | "redis" | "appSettings" | "permissionWorkAllowed"
  > & { deadlineMs?: number },
): Promise<void> {
  const { redis, deadlineMs } = options;
  const worker = defineDueJob({
    storage: onboardingJob,
    lockKey: "onboarding_job_v1_lock",
    lockTtlMs: 60_000,
    backoff: { baseMs: 60_000, maxMs: 60_000 },
    index: indexOnboardingJob,
    handle: async (_record, nowMs, canStart) => {
      await processDueOnboarding({ ...options, nowMs, canStart });
      const nextRunAt = await nextOnboardingDeadline(redis);
      return nextRunAt === undefined
        ? { status: "remove" }
        : {
            status: "complete",
            fields: {
              recurring: true,
              nextRunAt,
              sourceDueAt: nextRunAt,
              attempts: 0,
            },
          };
    },
  });
  try {
    await dispatchDueJobs(
      redis,
      [worker],
      deadlineMs === undefined ? {} : { deadlineMs },
    );
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "onboarding" },
      error,
    );
  }
}
