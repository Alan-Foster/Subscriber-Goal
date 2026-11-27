import {
  checkAppAccountHealth,
  type AppAccountHealthResult,
} from "../core/appAccountHealth";
import {
  appAccountHealthBackoff,
  healthRetryDeadline,
  isActiveHealthRetry,
  readAppAccountHealthRetry,
} from "../data/appAccountHealthRetry";
import type { RedditClient, RedisClient } from "../types";
import { dueJobsKey, updateJobRecord } from "./queue";
import { createJobCodec, jobRecordFields, timeField } from "./record";
import { defineDueJob, dispatchDueJobs, jobRunnerLockTtlMs } from "./runner";

const healthJob = {
  id: "app_account_health",
  stateKey: "app_account_health_job_v1_state",
  version: "1",
  codec: createJobCodec({ ...jobRecordFields, sourceDueAt: timeField }),
};

async function indexHealthRetry(redis: RedisClient): Promise<void> {
  // Foreground checks and recovery still own the v1 retry hash. The job
  // record owns the scheduler claim without changing that hash's status.
  const sourceDueAt = healthRetryDeadline(
    await readAppAccountHealthRetry(redis),
  );
  const indexedAt = await redis.zScore(dueJobsKey, healthJob.id);
  if (sourceDueAt === undefined && indexedAt == null) return;

  await updateJobRecord(redis, healthJob, (record) => {
    if (record.status === "processing") return;
    if (sourceDueAt === undefined) return null;
    if (record.sourceDueAt === sourceDueAt && indexedAt != null) return;
    return {
      version: healthJob.version,
      status: "pending",
      nextRunAt: sourceDueAt,
      sourceDueAt,
      attempts: 0,
    };
  });
}

export async function resolveAppAccountHealthGate({
  reddit,
  redis,
  now = Date.now,
  deadlineMs,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  now?: () => number;
  deadlineMs?: number;
}): Promise<AppAccountHealthResult | undefined> {
  let result: AppAccountHealthResult | undefined;
  const worker = defineDueJob({
    storage: healthJob,
    lockKey: "app_account_health_job_v1_lock",
    lockTtlMs: jobRunnerLockTtlMs,
    backoff: appAccountHealthBackoff,
    index: indexHealthRetry,
    handle: async (_record, startedAt, canStart) => {
      const retry = await readAppAccountHealthRetry(redis);
      const dueAt = healthRetryDeadline(retry);
      if (dueAt === undefined || !retry.subredditName)
        return { status: "remove" };
      if (startedAt < dueAt || !canStart()) {
        return {
          status: "complete",
          fields: { recurring: true, nextRunAt: dueAt, sourceDueAt: dueAt },
        };
      }
      result = await checkAppAccountHealth({
        reddit,
        redis,
        subredditName: retry.subredditName,
        ...(retry.subredditId ? { subredditId: retry.subredditId } : {}),
        ...(retry.language ? { language: retry.language } : {}),
        nowMs: startedAt,
      });
      const nextRunAt = healthRetryDeadline(
        await readAppAccountHealthRetry(redis),
      );
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
  const outcomes = await dispatchDueJobs(redis, [worker], {
    now,
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
  });
  const retry = await readAppAccountHealthRetry(redis);
  if (result && !result.healthy) return result;
  if (isActiveHealthRetry(retry) || outcomes.get(healthJob.id) === "retry") {
    return {
      status:
        retry.lastError === "missing_posts_permission"
          ? "unhealthy"
          : "unknown",
      healthy: false,
      permissions: [],
      notification: "not_needed",
    };
  }
  return result;
}
