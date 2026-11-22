import { createJobCodec, jobRecordFields, timeField } from "../jobs/record";
import { dueJobsKey, updateJobRecord } from "../jobs/queue";
import { defineDueJob } from "../jobs/runner";
import {
  displacementBatchSize,
  displacementPendingKey,
  displacementWaitMs as waitMs,
  enqueueDisplacementCheck,
  indexLegacyDisplacementPage,
  scheduledPostDisplacementKey,
  updateDisplacementCheck,
} from "../data/scheduledPostDisplacementQueue";
import { subscriberGoalPostKind } from "../../shared/postKind";
import { logDiagnostic } from "../../shared/diagnostics";
import { getSubGoalData } from "../data/subGoalData";
import {
  isLinkId,
  type LinkId,
  type RedditClient,
  type RedisClient,
} from "../types";
import {
  communityHighlightLimit,
  getCommunityHighlights,
} from "../utils/communityHighlights";
import { getPostAvailability, isMissingPostError } from "../utils/postStatus";
import {
  CommunityGoalMutationInProgressError,
  withCommunityGoalMutationLease,
} from "./communityGoalMutation";
import { isSubscriberGoalPostRetired } from "./postRetirement";

export { scheduledPostDisplacementKey } from "../data/scheduledPostDisplacementQueue";
const retryWindowMs = 60 * 60_000;
const logLimit = 25;
const workflow = "scheduled_post_displacement";

type Subreddit = Awaited<ReturnType<RedditClient["getCurrentSubreddit"]>>;

export async function recordScheduledPostDisplacementCheck(
  redis: RedisClient,
  postId: LinkId,
  actionedAt: string | undefined,
): Promise<void> {
  const unpinnedAt = Date.parse(actionedAt ?? "");
  if (!Number.isFinite(unpinnedAt)) {
    logDiagnostic("warn", "scheduled_post_displacement_invalid_unpin_time", {
      workflow,
      postId,
    });
    return;
  }

  await enqueueDisplacementCheck(redis, postId, unpinnedAt);
  logDiagnostic("info", "scheduled_post_displacement_queued", {
    workflow,
    postId,
    unpinnedAt,
    dueAt: unpinnedAt + waitMs,
  });
}

async function repinGoal(
  reddit: RedditClient,
  redis: RedisClient,
  subreddit: Subreddit,
  postId: LinkId,
): Promise<void> {
  const post = await reddit.getPostById(postId).catch((error: unknown) => {
    if (!isMissingPostError(error, postId)) throw error;
  });
  if (
    !post ||
    post.id !== postId ||
    post.subredditId !== subreddit.id ||
    post.archived ||
    getPostAvailability(post).status !== "active"
  )
    return;

  const [appUser, goal, retired] = await Promise.all([
    reddit.getAppUser(),
    getSubGoalData(redis, postId),
    isSubscriberGoalPostRetired(redis, postId),
  ]);
  if (
    !appUser?.id ||
    post.authorId !== appUser.id ||
    retired ||
    goal.postKind !== subscriberGoalPostKind ||
    goal.goal <= 0 ||
    goal.completedTime ||
    subreddit.numberOfSubscribers >= goal.goal
  )
    return;

  const highlights = await getCommunityHighlights(subreddit);
  if (
    highlights.length >= communityHighlightLimit ||
    highlights.some((highlight) => highlight.postId === postId)
  )
    return;

  await post.highlight();
  const after = await getCommunityHighlights(subreddit);
  const position = after.findIndex((highlight) => highlight.postId === postId);
  logDiagnostic("info", "scheduled_post_displacement_repinned", {
    workflow,
    postId,
    listedPosition: position === -1 ? undefined : position + 1,
    highlightCount: after.length,
  });
}

const displacementJob = {
  id: workflow,
  version: "scheduled_post_displacement_job_v1",
  stateKey: "scheduled_post_displacement_job_v1_state",
  codec: createJobCodec({ ...jobRecordFields, scanCursor: timeField }),
};

export function createScheduledPostDisplacementJob(
  reddit: RedditClient,
  redis: RedisClient,
  subreddit: Subreddit,
) {
  return defineDueJob({
    storage: displacementJob,
    lockKey: "scheduled_post_displacement_job_v1_lock",
    lockTtlMs: 60_000,
    backoff: { baseMs: 60_000, maxMs: 60_000 },
    index: indexDisplacementJob,
    handle: async (record, startedAt, canStart) => {
      const scanCursor =
        record.scanCursor === null
          ? null
          : await indexLegacyDisplacementPage(redis, record.scanCursor ?? 0);
      await processDisplacementBatch(
        { reddit, redis, subreddit },
        startedAt,
        canStart,
      );
      const nextRunAt =
        scanCursor === null
          ? await firstDisplacementDeadline(redis)
          : startedAt;
      return nextRunAt === undefined
        ? { status: "remove" }
        : {
            status: "complete",
            fields: { recurring: true, nextRunAt, scanCursor },
          };
    },
  });
}

async function firstDisplacementDeadline(
  redis: RedisClient,
): Promise<number | undefined> {
  const [first] = await redis.zRange(displacementPendingKey, 0, 0);
  return first?.score;
}

async function indexDisplacementJob(
  redis: RedisClient,
  nowMs: number,
): Promise<void> {
  const indexedAt = await redis.zScore(dueJobsKey, displacementJob.id);
  const earliest = await firstDisplacementDeadline(redis);
  if (
    indexedAt == null &&
    earliest === undefined &&
    (await redis.hLen(scheduledPostDisplacementKey)) === 0
  )
    return;
  await updateJobRecord(redis, displacementJob, (current) => {
    if (current.status === "processing") return;
    const nextRunAt = current.scanCursor === null ? earliest : nowMs;
    if (nextRunAt === undefined) return null;
    if (indexedAt === nextRunAt && current.nextRunAt === nextRunAt) return;
    return { version: displacementJob.version, status: "pending", nextRunAt };
  });
}

type DisplacementWork = {
  reddit: RedditClient;
  redis: RedisClient;
  subreddit: Subreddit;
};

async function processDisplacementBatch(
  work: DisplacementWork,
  nowMs: number,
  canStart: () => boolean,
): Promise<void> {
  const due = await work.redis.zRange(displacementPendingKey, "-inf", nowMs, {
    by: "score",
    limit: { offset: 0, count: displacementBatchSize },
  });
  for (const { member } of due) {
    if (!canStart()) {
      logDiagnostic("info", "job_runner_budget_deferred", {
        workflow: "job_runner",
        jobId: displacementJob.id,
      });
      return;
    }
    try {
      await checkScheduledDisplacement(work, member, nowMs);
    } catch (error) {
      logDiagnostic(
        "warn",
        "scheduled_post_displacement_check_failed",
        {
          workflow,
          postId: member,
          phase: "pending_index",
          subredditName: work.subreddit.name,
        },
        error,
      );
    }
  }
}

async function checkScheduledDisplacement(
  { reddit, redis, subreddit }: DisplacementWork,
  postId: string,
  nowMs: number,
): Promise<void> {
  const raw = await redis.hGet(scheduledPostDisplacementKey, postId);
  const unpinnedAt = Number(raw);
  const dueAt = unpinnedAt + waitMs;
  if (
    !isLinkId(postId) ||
    raw === undefined ||
    !Number.isFinite(unpinnedAt) ||
    nowMs >= dueAt + retryWindowMs
  ) {
    await updateDisplacementCheck(redis, postId, raw);
    return;
  }
  if (nowMs < dueAt) {
    await updateDisplacementCheck(redis, postId, raw, dueAt);
    return;
  }

  const diagnostic = {
    workflow,
    postId,
    unpinnedAt,
    dueAt,
    subredditName: subreddit.name,
  };
  try {
    const complete = await withCommunityGoalMutationLease(redis, async () => {
      if ((await redis.hGet(scheduledPostDisplacementKey, postId)) !== raw)
        return true;
      let submissions;
      try {
        submissions = await reddit
          .getModerationLog({
            subredditName: subreddit.name,
            type: "submit_scheduled_post",
            limit: logLimit,
            pageSize: logLimit,
          })
          .get(logLimit);
      } catch (error) {
        logDiagnostic(
          "warn",
          "scheduled_post_displacement_log_read_failed",
          diagnostic,
          error,
        );
        return false;
      }
      const match = submissions.find((entry) => {
        const publishedAt = entry.createdAt.getTime();
        return (
          entry.type === "submit_scheduled_post" &&
          publishedAt >= unpinnedAt - waitMs &&
          publishedAt <= dueAt
        );
      });
      logDiagnostic("info", "scheduled_post_displacement_checked", {
        ...diagnostic,
        entriesRead: submissions.length,
        matchedAt: match?.createdAt.getTime(),
        matchedActionId: match?.id,
      });

      // Consume before the write so a failed or ambiguous attempt cannot repeat.
      if ((await updateDisplacementCheck(redis, postId, raw)) && match) {
        await repinGoal(reddit, redis, subreddit, postId);
      }
      return true;
    });
    if (complete) return;
  } catch (error) {
    if (!(error instanceof CommunityGoalMutationInProgressError)) {
      logDiagnostic(
        "warn",
        "scheduled_post_displacement_check_failed",
        diagnostic,
        error,
      );
    }
  }

  // The next cron tick can retry. Place this failure behind checks that were already due.
  await updateDisplacementCheck(redis, postId, raw, nowMs + 1);
}
