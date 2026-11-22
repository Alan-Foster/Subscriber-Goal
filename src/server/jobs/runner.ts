import { logDiagnostic } from "../../shared/diagnostics";
import type { RedisClient } from "../types";
import { withRedisLock } from "../utils/redisOwnedLock";
import { getJobRetry, type BackoffPolicy } from "./backoff";
import {
  dueJobsKey,
  indexStoredJob,
  isDueJobRecord,
  updateJobRecord,
  type JobStorage,
} from "./queue";
import type { JobRecord } from "./record";

export const jobRunnerBudgetMs = 20_000;
const batchSize = 25;

type RunResult = "not_due" | "complete" | "retry" | "exhausted" | "budget";
type JobOutcome<T extends JobRecord> =
  | { status: "complete"; fields?: Partial<T> }
  | { status: "defer"; nextRunAt: number }
  | { status: "retry"; message: string };

type RunWindow = { now: () => number; deadlineMs: number };
type Job = {
  id: string;
  index(redis: RedisClient): Promise<void>;
  run(redis: RedisClient, window: RunWindow): Promise<RunResult>;
};

type JobWorker<T extends JobRecord> = {
  storage: JobStorage<T>;
  lockKey: string;
  lockTtlMs: number;
  backoff: BackoffPolicy;
  handle(record: Partial<T>, startedAt: number): Promise<JobOutcome<T>>;
};

export function defineDueJob<T extends JobRecord>(worker: JobWorker<T>): Job {
  return {
    id: worker.storage.id,
    index: (redis) => indexStoredJob(redis, worker.storage),
    run: (redis, window) => runDueJob(redis, worker, window),
  };
}

export async function dispatchDueJobs(
  redis: RedisClient,
  jobs: readonly Job[],
  {
    now = Date.now,
    deadlineMs = now() + jobRunnerBudgetMs,
  }: Partial<RunWindow> = {},
): Promise<Map<string, RunResult>> {
  const results = new Map<string, RunResult>();
  if (now() >= deadlineMs) {
    logBudget();
    return results;
  }
  for (const job of jobs) {
    if (now() >= deadlineMs) {
      logBudget();
      return results;
    }
    try {
      await job.index(redis);
    } catch (error) {
      logDiagnostic(
        "warn",
        "job_runner_job_failed",
        {
          workflow: "job_runner",
          phase: "index",
          jobId: job.id,
        },
        error,
      );
    }
  }
  if (now() >= deadlineMs) {
    logBudget();
    return results;
  }
  const due = await redis.zRange(dueJobsKey, "-inf", now(), {
    by: "score",
    limit: { offset: 0, count: batchSize },
  });
  const workers = new Map(jobs.map((job) => [job.id, job]));
  for (const [index, { member }] of due.entries()) {
    if (now() >= deadlineMs) {
      logBudget(due.length - index);
      break;
    }
    const job = workers.get(member);
    if (!job) continue;
    try {
      const result = await job.run(redis, { now, deadlineMs });
      if (result === "budget") {
        logBudget(due.length - index);
        break;
      }
      results.set(member, result);
    } catch (error) {
      logDiagnostic(
        "warn",
        "job_runner_job_failed",
        {
          workflow: "job_runner",
          phase: "run",
          jobId: member,
        },
        error,
      );
      results.set(member, "retry");
    }
  }
  return results;
}

async function runDueJob<T extends JobRecord>(
  redis: RedisClient,
  worker: JobWorker<T>,
  { now, deadlineMs }: RunWindow,
): Promise<RunResult> {
  const { storage, lockKey, lockTtlMs } = worker;
  const locked = await withRedisLock(
    redis,
    lockKey,
    lockTtlMs,
    async (activeRunId): Promise<RunResult> => {
      const startedAt = now();
      if (startedAt >= deadlineMs) return "budget";
      const record = await updateJobRecord(redis, storage, (current) =>
        now() < deadlineMs &&
        isDueJobRecord(current, storage.version, startedAt)
          ? { status: "processing", startedAt, activeRunId }
          : undefined,
      );
      if (!record) {
        if (now() >= deadlineMs) return "budget";
        await updateJobRecord(redis, storage, () => ({}));
        return "not_due";
      }
      if (now() >= deadlineMs) {
        // The claim itself can consume the remaining budget. Preserve the
        // original due time and any force request made during the claim.
        await updateJobRecord(redis, storage, (current) =>
          current.version === storage.version &&
          current.activeRunId === activeRunId &&
          current.status === "processing"
            ? {
                status: record.status ?? "pending",
                startedAt: record.startedAt ?? null,
                activeRunId: "",
              }
            : undefined,
        );
        return "budget";
      }
      const outcome = await executeJob(worker, record, startedAt);
      return persistJobOutcome(
        redis,
        worker,
        { record, activeRunId, startedAt },
        outcome,
      );
    },
    { nowMs: now() },
  );
  return locked.acquired ? locked.result : "not_due";
}

type JobClaim<T extends JobRecord> = {
  record: Partial<T>;
  activeRunId: string;
  startedAt: number;
};

async function executeJob<T extends JobRecord>(
  worker: JobWorker<T>,
  record: Partial<T>,
  startedAt: number,
): Promise<JobOutcome<T>> {
  try {
    return await worker.handle(record, startedAt);
  } catch (error) {
    logDiagnostic(
      "warn",
      "job_runner_job_failed",
      {
        workflow: "job_runner",
        phase: "handler",
        jobId: worker.storage.id,
      },
      error,
    );
    return {
      status: "retry",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function persistJobOutcome<T extends JobRecord>(
  redis: RedisClient,
  { storage, backoff }: JobWorker<T>,
  claim: JobClaim<T>,
  outcome: JobOutcome<T>,
): Promise<RunResult> {
  const { activeRunId, startedAt } = claim;
  if (outcome.status === "retry")
    return retryJob(redis, storage, claim, backoff, outcome.message);
  const finished = await updateJobRecord(redis, storage, (current) => {
    if (
      current.version !== storage.version ||
      current.activeRunId !== activeRunId ||
      current.status !== "processing"
    )
      return;
    return outcome.status === "defer"
      ? {
          status: "pending",
          nextRunAt: outcome.nextRunAt,
          activeRunId: "",
        }
      : {
          ...outcome.fields,
          status: "complete",
          completedAt: startedAt,
          lastError: "",
          activeRunId: "",
        };
  });
  return finished && outcome.status === "complete" ? "complete" : "retry";
}

async function retryJob<T extends JobRecord>(
  redis: RedisClient,
  storage: JobStorage<T>,
  { record, activeRunId, startedAt }: JobClaim<T>,
  backoff: BackoffPolicy,
  message: string,
): Promise<"retry" | "exhausted"> {
  const attempts = (record.attempts ?? 0) + 1;
  const retry = getJobRetry(backoff, attempts);
  const previous = await updateJobRecord(redis, storage, (current) => {
    if (
      current.version !== storage.version ||
      current.activeRunId !== activeRunId
    )
      return;
    if (current.status === "pending") {
      return {
        attempts,
        lastError: message,
        activeRunId: "",
        ...(retry.exhausted
          ? {}
          : {
              nextRunAt: Math.min(
                startedAt + retry.delayMs,
                current.nextRunAt ?? Infinity,
              ),
            }),
      };
    }
    if (current.status !== "processing") return;
    return {
      status: retry.exhausted ? "exhausted" : "pending",
      nextRunAt: retry.exhausted ? null : startedAt + retry.delayMs,
      attempts,
      lastError: message,
      activeRunId: "",
    };
  });
  if (!retry.exhausted || previous?.status !== "processing") return "retry";
  logDiagnostic("warn", "job_runner_attempts_exhausted", {
    workflow: "job_runner",
    jobId: storage.id,
    attempts,
  });
  return "exhausted";
}

function logBudget(deferred?: number): void {
  logDiagnostic("info", "job_runner_budget_deferred", {
    workflow: "job_runner",
    deferred,
  });
}
