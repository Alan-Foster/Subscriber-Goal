import { logDiagnostic } from "../../shared/diagnostics";
import type { RedditClient, RedisClient } from "../types";
import { checkAppAccountHealth } from "./appAccountHealth";
import {
  backfillSubscriberGoalPostFlair,
  ensureSubscriberGoalPostFlair,
} from "./subscriberGoalPostFlair";
import { ensureCommunityPostActivityBackfill } from "../data/ctaActivity";
import { initializeLegacyAfterSubscribeActionMigration } from "../data/legacyAfterSubscribeActionMigration";
import { initializePostKindMigration } from "../data/postKindMigration";
import { getSubscriberGoalCandidatePostIds } from "../data/subscriberGoalCandidates";
import { getTrackedPosts, queueUpdates } from "../data/updaterData";
import { ensureExistingSubscriberGoalHighlighted } from "./highlightReconciliation";
import {
  appRepairLockKey,
  appRepairStateKey,
  scheduleHighlightRepair,
  recurringHighlightRepairIntervalMs,
  appRepairJob,
  type AppRepairRecord,
} from "../data/highlightRepair";
import {
  CommunityGoalMutationInProgressError,
  withCommunityGoalMutationLease,
} from "./communityGoalMutation";
import { isSubscriberGoalPostRetired } from "./postRetirement";
import { autoCreateNextGoalSuccessorsKey } from "../data/subGoalData";
import { defineDueJob, dispatchDueJobs } from "../jobs/runner";

export { appRepairLockKey, appRepairStateKey };
const repairBackoff = { baseMs: 5 * 60 * 1000, maxMs: 60 * 60 * 1000 };
export { recurringHighlightRepairIntervalMs };

export async function scheduleAppRepair(
  redis: RedisClient,
  nowMs = Date.now(),
  jitterMs = Math.floor(Math.random() * 60_000),
  options: { force?: boolean; reason?: string } = {},
): Promise<void> {
  await scheduleHighlightRepair(redis, {
    nowMs,
    delayMs: jitterMs,
    force: options.force ?? false,
    reason: options.reason ?? "lifecycle",
  });
}

export async function processDueAppRepair({
  reddit,
  redis,
  nowMs,
  deadlineMs,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  nowMs?: number;
  deadlineMs?: number;
}): Promise<"not_due" | "complete" | "retry"> {
  const now = nowMs === undefined ? Date.now : () => nowMs;
  const worker = createAppRepairJob(reddit, redis);
  const outcomes = await dispatchDueJobs(redis, [worker], {
    now,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  const outcome = outcomes.get(worker.id);
  if (outcome === "complete" || outcome === "retry") return outcome;
  return "not_due";
}

export function createAppRepairJob(reddit: RedditClient, redis: RedisClient) {
  return defineDueJob({
    storage: appRepairJob,
    lockKey: appRepairLockKey,
    lockTtlMs: 15 * 60 * 1000,
    backoff: repairBackoff,
    handle: (record, startedAt) =>
      runAppRepair({ reddit, redis }, record, startedAt),
  });
}

type RepairWork = { reddit: RedditClient; redis: RedisClient };
type RepairSubreddit = Awaited<ReturnType<RedditClient["getCurrentSubreddit"]>>;
type RepairProgress = { failures: string[]; highlightDeferred: boolean };
type RunPhase = (
  phase: string,
  operation: () => Promise<unknown>,
) => Promise<void>;

async function runAppRepair(
  work: RepairWork,
  state: AppRepairRecord,
  nowMs: number,
) {
  try {
    return await runRepairPhases(work, state, nowMs);
  } catch (error) {
    logDiagnostic(
      "error",
      "app_repair_failed",
      { workflow: "app_repair", phase: "execution" },
      error,
    );
    return {
      status: "retry" as const,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runRepairPhases(
  work: RepairWork,
  state: AppRepairRecord,
  nowMs: number,
) {
  const { reddit, redis } = work;
  const progress: RepairProgress = { failures: [], highlightDeferred: false };
  const runPhase = createRepairPhaseRunner(progress);
  let recurringHighlightCheck = false;
  const subreddit = await reddit.getCurrentSubreddit();

  await runPhase("activity_backfill", () =>
    ensureCommunityPostActivityBackfill(reddit, redis, subreddit.name),
  );

  let candidatePostIds: string[] | undefined;
  let trackedPosts: string[] | undefined;
  await runPhase("candidate_discovery", async () => {
    candidatePostIds = await getSubscriberGoalCandidatePostIds(redis);
  });
  await runPhase("tracked_post_discovery", async () => {
    trackedPosts = await getTrackedPosts(redis);
  });

  if (candidatePostIds && trackedPosts) {
    await prepareRepairPosts(
      work,
      subreddit,
      candidatePostIds,
      trackedPosts,
      runPhase,
    );
    await runPhase("highlight_reconciliation", async () => {
      recurringHighlightCheck = await reconcileRepairHighlights(
        work,
        state.targetPostId,
        nowMs,
      );
    });
  } else {
    progress.failures.push("migration_discovery: incomplete");
  }

  await runPhase("app_account_health", () =>
    checkAppAccountHealth({
      reddit,
      redis,
      subredditName: subreddit.name,
      subredditId: subreddit.id,
      language: subreddit.language,
    }),
  );

  if (progress.failures.length > 0)
    return { status: "retry" as const, message: progress.failures.join(" | ") };
  if (progress.highlightDeferred)
    return {
      status: "defer" as const,
      nextRunAt: nowMs + repairBackoff.baseMs,
    };
  return {
    status: "complete" as const,
    fields: {
      recurring: recurringHighlightCheck,
      nextRunAt: recurringHighlightCheck
        ? nowMs + recurringHighlightRepairIntervalMs
        : null,
      targetPostId: "",
    },
  };
}

function createRepairPhaseRunner(progress: RepairProgress): RunPhase {
  return async (phase, operation) => {
    try {
      await operation();
    } catch (error) {
      if (
        phase === "highlight_reconciliation" &&
        error instanceof CommunityGoalMutationInProgressError
      ) {
        progress.highlightDeferred = true;
        logDiagnostic("info", "app_repair_phase_deferred", {
          workflow: "app_repair",
          phase,
          reason: "mutation_lease_busy",
        });
        return;
      }
      progress.failures.push(
        `${phase}: ${error instanceof Error ? error.message : String(error)}`,
      );
      logDiagnostic(
        "warn",
        "app_repair_phase_failed",
        { workflow: "app_repair", phase },
        error,
      );
    }
  };
}

async function prepareRepairPosts(
  { reddit, redis }: RepairWork,
  subreddit: RepairSubreddit,
  candidatePostIds: string[],
  trackedPosts: string[],
  runPhase: RunPhase,
): Promise<void> {
  await runPhase("post_kind_migration", () =>
    initializePostKindMigration(redis, trackedPosts),
  );
  await runPhase("after_subscribe_action_migration", () =>
    initializeLegacyAfterSubscribeActionMigration(redis, candidatePostIds, {
      name: subreddit.name,
      type: subreddit.type,
    }),
  );
  if (trackedPosts.length > 0) {
    await runPhase("update_queue", () => queueUpdates(redis, trackedPosts));
  }

  let flairId: string | undefined;
  await runPhase("flair_ensure", async () => {
    flairId = (
      await ensureSubscriberGoalPostFlair(reddit, redis, subreddit.name)
    ).id;
  });
  if (flairId) {
    await runPhase("flair_backfill", () =>
      backfillSubscriberGoalPostFlair(
        reddit,
        subreddit,
        candidatePostIds,
        flairId!,
      ),
    );
  }
}

async function reconcileRepairHighlights(
  { reddit, redis }: RepairWork,
  targetPostId: string | undefined,
  nowMs: number,
): Promise<boolean> {
  const result = await withCommunityGoalMutationLease(redis, (mutationLease) =>
    ensureExistingSubscriberGoalHighlighted({
      reddit,
      redis,
      nowMs,
      notifyOnFailure: true,
      reconciliationContext: "repair",
      mutationLease,
    }),
  );
  const recurringHighlightCheck =
    result.capacityOnly === true || (result.eligiblePostIds?.length ?? 0) > 0;
  const onlyRemovedGoalsUnhighlighted =
    result.pausedByRemovedGoal &&
    (result.unhighlightedEligiblePostIds?.length ?? 0) > 0 &&
    result.unhighlightedEligiblePostIds.every((postId) =>
      result.removedGoalBlockerPostIds?.includes(postId),
    );
  const expectedTargetOutstanding = targetPostId
    ? !(await isSubscriberGoalPostRetired(redis, targetPostId)) &&
      !(await redis.hGet(autoCreateNextGoalSuccessorsKey, targetPostId))
    : false;
  if (
    (result.status === "missing" && expectedTargetOutstanding) ||
    (!result.capacityOnly &&
      ((result.status === "existing_not_highlighted" &&
        !onlyRemovedGoalsUnhighlighted) ||
        result.reconciliationOutcome === "degraded" ||
        result.reconciliationOutcome === "failed"))
  ) {
    throw new Error(
      result.errorMessage ??
        `Subscriber Goal Community Highlight reconciliation ${result.reconciliationOutcome ?? "failed"}.`,
    );
  }
  return recurringHighlightCheck;
}
