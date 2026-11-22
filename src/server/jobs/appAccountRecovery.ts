import { checkAppAccountHealth } from "../core/appAccountHealth";
import {
  processAppAccountRecovery,
  type AppAccountRecoveryResult,
} from "../core/appAccountRecovery";
import {
  appAccountRecoveryStateKey,
  isTerminalRecoveryStatus,
  toRecoveryResultStatus,
  updateRecoveryState,
} from "../core/appAccountRecoveryState";
import type { RedisClient } from "../types";
import { getJobBackoffDelay } from "./backoff";
import { dueJobsKey, updateJobRecord } from "./queue";
import {
  createJobCodec,
  jobRecordFields,
  textField,
  timeField,
} from "./record";
import { defineDueJob, dispatchDueJobs } from "./runner";

const recoveryJob = {
  id: "app_account_recovery",
  stateKey: "app_account_recovery_job_v1_state",
  version: "1",
  codec: createJobCodec({
    ...jobRecordFields,
    incidentToken: textField,
    sourceDueAt: timeField,
  }),
};

type RecoveryClients = Pick<
  Parameters<typeof processAppAccountRecovery>[0],
  "reddit" | "redis" | "scheduler"
>;
type RecoveryState = Record<string, string>;
const verificationBackoff = { baseMs: 60_000, maxMs: 3_600_000 };

function getRecoveryDeadline(state: RecoveryState): number | undefined {
  if (!state.incidentToken || !state.subredditName) return;
  if (isTerminalRecoveryStatus(state.status)) {
    // Terminal records from before periodic verification are due immediately.
    return Number(state.nextVerificationAt) || 0;
  }
  if (
    state.reason &&
    (state.status === "pending" || state.status === "processing")
  ) {
    return Number(state.dueAt) || 0;
  }
}

async function indexRecoveryJob(redis: RedisClient): Promise<void> {
  const state = await redis.hGetAll(appAccountRecoveryStateKey);
  const sourceDueAt = getRecoveryDeadline(state);
  const indexedAt = await redis.zScore(dueJobsKey, recoveryJob.id);
  if (sourceDueAt === undefined && indexedAt == null) return;

  // Keep the incident hash compatible with one-off jobs and lifecycle events.
  await updateJobRecord(redis, recoveryJob, (record) => {
    if (record.status === "processing") return;
    if (sourceDueAt === undefined) return null;
    if (
      record.incidentToken === state.incidentToken &&
      record.sourceDueAt === sourceDueAt &&
      indexedAt != null
    )
      return;
    return {
      version: recoveryJob.version,
      status: "pending",
      incidentToken: state.incidentToken ?? "",
      sourceDueAt,
      nextRunAt: sourceDueAt,
      attempts: 0,
    };
  });
}

async function verifyTerminalRecovery(
  { reddit, redis }: RecoveryClients,
  state: RecoveryState,
  nowMs: number,
): Promise<void> {
  const attempts = Math.min(7, (Number(state.verificationAttempts) || 0) + 1);
  const claimed = await updateRecoveryState(redis, state, {
    verificationToken: crypto.randomUUID(),
    verificationAttempts: String(attempts),
    nextVerificationAt: String(
      nowMs + getJobBackoffDelay(verificationBackoff, attempts),
    ),
  });
  if (!claimed || !state.subredditName) return;
  await checkAppAccountHealth({
    reddit,
    redis,
    subredditName: state.subredditName,
    ...(state.subredditId ? { subredditId: state.subredditId } : {}),
    notify: false,
    scheduleUnknownRetry: false,
    nowMs,
  });
}

export async function resolveAppAccountRecoveryGate({
  now = Date.now,
  deadlineMs,
  ...clients
}: RecoveryClients & {
  now?: () => number;
  deadlineMs?: number;
}): Promise<AppAccountRecoveryResult> {
  const { redis } = clients;
  const worker = defineDueJob({
    storage: recoveryJob,
    lockKey: "app_account_recovery_job_v1_lock",
    lockTtlMs: 60_000,
    backoff: verificationBackoff,
    index: indexRecoveryJob,
    handle: async (_record, startedAt, canStart) => {
      const state = await redis.hGetAll(appAccountRecoveryStateKey);
      const dueAt = getRecoveryDeadline(state);
      if (
        dueAt !== undefined &&
        dueAt <= startedAt &&
        state.incidentToken &&
        canStart()
      ) {
        if (isTerminalRecoveryStatus(state.status)) {
          await verifyTerminalRecovery(clients, state, startedAt);
        } else {
          await processAppAccountRecovery({
            ...clients,
            incidentToken: state.incidentToken,
            nowMs: startedAt,
            canStart,
          });
        }
      }
      const current = await redis.hGetAll(appAccountRecoveryStateKey);
      const nextRunAt = getRecoveryDeadline(current);
      return nextRunAt === undefined
        ? { status: "remove" }
        : {
            status: "complete",
            fields: {
              recurring: true,
              nextRunAt,
              sourceDueAt: nextRunAt,
              incidentToken: current.incidentToken ?? "",
              attempts: 0,
            },
          };
    },
  });
  const result = await dispatchDueJobs(redis, [worker], {
    now,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  const current = await redis.hGetAll(appAccountRecoveryStateKey);
  if (result.get(recoveryJob.id) === "retry") return { status: "locked" };
  if (!current.incidentToken) return { status: "stale" };
  return {
    status: toRecoveryResultStatus(current.status),
    incidentToken: current.incidentToken,
  };
}
