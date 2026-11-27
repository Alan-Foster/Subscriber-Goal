import { logDiagnostic } from "../../shared/diagnostics";
import {
  MILESTONE_NOTIFICATION_DELIVERY_ENABLED,
  milestoneNotificationRecoveryKey,
  recoverMilestoneNotificationContinuations,
} from "../core/milestoneNotifications";
import { getSubGoalData } from "../data/subGoalData";
import type { RedditClient, RedisClient } from "../types";
import { dueJobsKey, updateJobRecord } from "./queue";
import { createJobCodec, jobRecordFields, timeField } from "./record";
import { defineDueJob, dispatchDueJobs, jobRunnerLockTtlMs } from "./runner";

const recoveryJob = {
  id: "milestone_notification_recovery",
  stateKey: "milestone_notification_recovery_job_v1_state",
  version: "1",
  codec: createJobCodec({ ...jobRecordFields, sourceDueAt: timeField }),
};

async function nextContinuationDeadline(redis: RedisClient) {
  const [head] = await redis.zRange(milestoneNotificationRecoveryKey, 0, 0);
  return head?.score;
}

async function indexContinuations(redis: RedisClient): Promise<void> {
  // The continuation index is still written atomically with the parent page.
  // The runner claims one batch without modifying those saved page decisions.
  const sourceDueAt = await nextContinuationDeadline(redis);
  const indexedAt = await redis.zScore(dueJobsKey, recoveryJob.id);
  if (sourceDueAt === indexedAt) return;

  await updateJobRecord(redis, recoveryJob, (record) => {
    if (record.status === "processing") return;
    if (sourceDueAt === undefined) return null;
    if (record.sourceDueAt === sourceDueAt && indexedAt != null) return;
    return {
      version: recoveryJob.version,
      status: "pending",
      nextRunAt: sourceDueAt,
      sourceDueAt,
      attempts: 0,
    };
  });
}

type RecoveryOptions = Parameters<
  typeof recoverMilestoneNotificationContinuations
>[0];

export function createMilestoneNotificationRecoveryJob(
  redis: RedisClient,
  options: Pick<
    RecoveryOptions,
    "schedulerClient" | "getCampaign" | "deliveryEnabled"
  >,
) {
  return defineDueJob({
    storage: recoveryJob,
    lockKey: "milestone_notification_recovery_job_v1_lock",
    lockTtlMs: jobRunnerLockTtlMs,
    backoff: { baseMs: 60_000, maxMs: 60_000 },
    index: indexContinuations,
    handle: async (_record, startedAt, canStart) => {
      await recoverMilestoneNotificationContinuations({
        ...options,
        redisClient: redis,
        now: () => startedAt,
        canStart,
      });
      const nextRunAt = await nextContinuationDeadline(redis);
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
}

export async function dispatchMilestoneNotificationRecovery(
  reddit: RedditClient,
  redis: RedisClient,
  schedulerClient: NonNullable<RecoveryOptions["schedulerClient"]>,
  deadlineMs: number,
): Promise<void> {
  if (!MILESTONE_NOTIFICATION_DELIVERY_ENABLED) return;
  const job = createMilestoneNotificationRecoveryJob(redis, {
    schedulerClient,
    getCampaign: async ({ postId, completedTime }) => {
      const goal = await getSubGoalData(redis, postId);
      if (goal.completedTime !== completedTime || goal.goal <= 0) return;
      const community = await reddit.getCurrentSubreddit();
      return {
        postId,
        completedTime,
        subredditName: goal.subredditDisplayName ?? community.name,
        goal: goal.goal,
        language: goal.language,
      };
    },
  });
  try {
    await dispatchDueJobs(redis, [job], { deadlineMs });
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "milestone_notification_recovery" },
      error,
    );
  }
}
