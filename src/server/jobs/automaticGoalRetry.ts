import { logDiagnostic } from "../../shared/diagnostics";
import {
  processDueAutoCreateNextGoals,
  type AutoCreateNextGoalSummary,
} from "../core/autoCreateNextGoal";
import type { CommunityGoalMutationLease } from "../core/communityGoalMutation";
import { autoCreateNextGoalQueueKey } from "../data/subGoalData";
import type { ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import { dueJobsKey, updateJobRecord } from "./queue";
import { createJobCodec, jobRecordFields, timeField } from "./record";
import { defineDueJob, dispatchDueJobs, jobRunnerLockTtlMs } from "./runner";

const automaticGoalJob = {
  id: "automatic_goal_retry",
  stateKey: "automatic_goal_retry_job_v1_state",
  version: "1",
  codec: createJobCodec({ ...jobRecordFields, sourceDueAt: timeField }),
};

async function nextAutomaticGoalDeadline(redis: RedisClient) {
  const [head] = await redis.zRange(autoCreateNextGoalQueueKey, 0, 0);
  return head?.score;
}

async function indexAutomaticGoalJob(redis: RedisClient): Promise<void> {
  const sourceDueAt = await nextAutomaticGoalDeadline(redis);
  const indexedAt = await redis.zScore(dueJobsKey, automaticGoalJob.id);
  if (sourceDueAt === indexedAt) return;

  await updateJobRecord(redis, automaticGoalJob, (record) => {
    if (record.status === "processing") return;
    if (sourceDueAt === undefined) return null;
    if (record.sourceDueAt === sourceDueAt && indexedAt != null) return;
    return {
      version: automaticGoalJob.version,
      status: "pending",
      nextRunAt: sourceDueAt,
      sourceDueAt,
      attempts: 0,
    };
  });
}

export async function runAutoGoalSuccessorQueue({
  reddit,
  redis,
  appSettings,
  nowMs,
  mutationLease,
  deadlineMs,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  nowMs?: number;
  mutationLease?: CommunityGoalMutationLease;
  deadlineMs?: number;
}): Promise<AutoCreateNextGoalSummary | undefined> {
  const invokedAt = Date.now();
  const now =
    nowMs === undefined
      ? Date.now
      : () => nowMs + Math.max(0, Date.now() - invokedAt);
  let summary: AutoCreateNextGoalSummary | undefined;
  const worker = defineDueJob({
    storage: automaticGoalJob,
    lockKey: "automatic_goal_retry_job_v1_lock",
    lockTtlMs: jobRunnerLockTtlMs,
    backoff: { baseMs: 60_000, maxMs: 60_000 },
    index: indexAutomaticGoalJob,
    handle: async (_record, startedAt, canStart) => {
      // Retries and first attempts share the same ordered source queue.
      summary = await processDueAutoCreateNextGoals({
        reddit,
        redis,
        appSettings,
        nowMs: nowMs ?? startedAt,
        ...(mutationLease ? { mutationLease } : {}),
        canStart,
      });
      const nextRunAt = await nextAutomaticGoalDeadline(redis);
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
  await dispatchDueJobs(redis, [worker], {
    now,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  return summary;
}

export async function dispatchAutomaticGoalRetryJob(
  reddit: RedditClient,
  redis: RedisClient,
  appSettings: ServerAppSettings,
  deadlineMs: number,
): Promise<void> {
  try {
    const summary = await runAutoGoalSuccessorQueue({
      reddit,
      redis,
      appSettings,
      deadlineMs,
    });
    if (summary && summary.due > 0) {
      const fields = Object.entries(summary)
        .map(([name, count]) => `${name}=${count}`)
        .join(" ");
      console.info(`[autoCreateNextGoal] scheduler summary: ${fields}`);
    }
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "auto_create_next_goal" },
      error,
    );
  }
}
