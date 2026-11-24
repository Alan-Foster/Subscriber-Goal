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
import {
  defineDueJob,
  dispatchDueJobs,
  jobRunnerBudgetMs,
} from "../jobs/runner";
import { updateJobRecord } from "../jobs/queue";

export { appRepairLockKey, appRepairStateKey };
const repairBackoff = { baseMs: 5 * 60 * 1000, maxMs: 60 * 60 * 1000 };
const highlightBudgetReserveMs = 10_000;
const flairCheckpointReserveMs = 1_000;
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
  now = nowMs === undefined ? Date.now : () => nowMs,
  deadlineMs,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  nowMs?: number;
  now?: () => number;
  deadlineMs?: number;
}): Promise<"not_due" | "complete" | "retry"> {
  const window = { now, deadlineMs: deadlineMs ?? now() + jobRunnerBudgetMs };
  const worker = createAppRepairJob(reddit, redis, window);
  const outcomes = await dispatchDueJobs(redis, [worker], window);
  const outcome = outcomes.get(worker.id);
  if (outcome === "complete" || outcome === "retry") return outcome;
  return "not_due";
}

export function createAppRepairJob(
  reddit: RedditClient,
  redis: RedisClient,
  { now, deadlineMs }: { now: () => number; deadlineMs: number },
) {
  return defineDueJob({
    storage: appRepairJob,
    lockKey: appRepairLockKey,
    // A request can run for 30 seconds. Allow another 30 for expiry margin.
    lockTtlMs: 60_000,
    backoff: repairBackoff,
    handle: (record, startedAt, canStart) =>
      runAppRepair({ reddit, redis }, record, startedAt, {
        deadlineMs,
        canStart,
        canStartHighlight: () => deadlineMs - now() >= highlightBudgetReserveMs,
        canStartFlair: () => deadlineMs - now() > flairCheckpointReserveMs,
      }),
  });
}

type RepairWork = { reddit: RedditClient; redis: RedisClient };
type RepairSubreddit = Awaited<ReturnType<RedditClient["getCurrentSubreddit"]>>;
type RepairProgress = {
  failures: string[];
  highlightDeferred: boolean;
  budgetDeferred: boolean;
};
type RepairBudget = {
  deadlineMs: number;
  canStart: () => boolean;
  canStartHighlight: () => boolean;
  canStartFlair: () => boolean;
};
type RunPhase = (
  phase: string,
  operation: () => Promise<unknown>,
  hasReserve?: () => boolean,
) => Promise<void>;

async function runAppRepair(
  work: RepairWork,
  state: AppRepairRecord,
  nowMs: number,
  budget: RepairBudget,
) {
  try {
    if (!budget.canStart()) return deferRepairForBudget(nowMs);
    return await runRepairPhases(work, state, nowMs, budget);
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
  budget: RepairBudget,
) {
  const { reddit, redis } = work;
  const progress: RepairProgress = {
    failures: [],
    highlightDeferred: false,
    budgetDeferred: false,
  };
  const runPhase = createRepairPhaseRunner(progress, budget.canStart);
  let recurringHighlightCheck = false;
  const subreddit = await reddit.getCurrentSubreddit();

  await runPhase("activity_backfill", () =>
    ensureCommunityPostActivityBackfill(reddit, redis, subreddit.name),
  );

  let candidatePostIds: string[] | undefined;
  let trackedPosts: string[] | undefined;
  let flairId: string | undefined;
  await runPhase("candidate_discovery", async () => {
    candidatePostIds = await getSubscriberGoalCandidatePostIds(redis);
  });
  await runPhase("tracked_post_discovery", async () => {
    trackedPosts = await getTrackedPosts(redis);
  });

  if (candidatePostIds && trackedPosts) {
    flairId = await prepareRepairPosts(
      work,
      subreddit,
      candidatePostIds,
      trackedPosts,
      runPhase,
    );
    await runPhase(
      "highlight_reconciliation",
      async () => {
        recurringHighlightCheck = await reconcileRepairHighlights(
          work,
          state.targetPostId,
          nowMs,
          budget.deadlineMs,
        );
      },
      budget.canStartHighlight,
    );
  } else if (!progress.budgetDeferred) {
    progress.failures.push("migration_discovery: incomplete");
  }
  await repairAccountHealth(work, subreddit, runPhase);

  const posts = candidatePostIds;
  const templateId = flairId;
  const backfillComplete =
    state.flairBackfillTemplateId === templateId && state.flairBackfillComplete;
  if (templateId && posts && !backfillComplete && !progress.budgetDeferred) {
    await runPhase(
      "flair_backfill",
      async () => {
        progress.budgetDeferred = await resumeFlairBackfill({
          work,
          subreddit,
          candidatePostIds: posts,
          flairId: templateId,
          state,
          startedAt: nowMs,
          canStart: () => budget.canStart() && budget.canStartFlair(),
        });
      },
      budget.canStartFlair,
    );
  }

  if (progress.budgetDeferred) return deferRepairForBudget(nowMs);
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

function deferRepairForBudget(nowMs: number) {
  logDiagnostic("info", "app_repair_phase_deferred", {
    workflow: "app_repair",
    phase: "execution",
    reason: "budget",
  });
  return { status: "defer" as const, nextRunAt: nowMs + 60_000 };
}

function createRepairPhaseRunner(
  progress: RepairProgress,
  canStart: () => boolean,
): RunPhase {
  return async (phase, operation, hasReserve) => {
    if (!canStart() || (hasReserve && !hasReserve())) {
      progress.budgetDeferred = true;
      return;
    }
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
): Promise<string | undefined> {
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
  return flairId;
}

function repairAccountHealth(
  { reddit, redis }: RepairWork,
  subreddit: RepairSubreddit,
  runPhase: RunPhase,
): Promise<void> {
  return runPhase("app_account_health", () =>
    checkAppAccountHealth({
      reddit,
      redis,
      subredditName: subreddit.name,
      subredditId: subreddit.id,
      language: subreddit.language,
    }),
  );
}

async function resumeFlairBackfill({
  work: { reddit, redis },
  subreddit,
  candidatePostIds,
  flairId,
  state,
  startedAt,
  canStart,
}: {
  work: RepairWork;
  subreddit: RepairSubreddit;
  candidatePostIds: string[];
  flairId: string;
  state: AppRepairRecord;
  startedAt: number;
  canStart: () => boolean;
}): Promise<boolean> {
  const sameTemplate = state.flairBackfillTemplateId === flairId;
  const activeRunId = await redis.get(appRepairLockKey);
  if (!activeRunId || !canStart()) return true;
  const result = await backfillSubscriberGoalPostFlair(
    reddit,
    subreddit,
    candidatePostIds,
    flairId,
    {
      canStart,
      afterPostId: sameTemplate ? (state.flairBackfillAfterPostId ?? "") : "",
    },
  );
  const hasRemaining = result.nextAfterPostId !== undefined;
  const hadFailures =
    result.failed.length > 0 ||
    (sameTemplate && state.flairBackfillHadFailures === true);
  await updateJobRecord(redis, appRepairJob, (current) => {
    if (
      current.version !== appRepairJob.version ||
      current.startedAt !== startedAt ||
      current.activeRunId !== activeRunId
    )
      return;
    return {
      flairBackfillTemplateId: flairId,
      flairBackfillAfterPostId: result.nextAfterPostId ?? "",
      flairBackfillHadFailures: hasRemaining && hadFailures,
      flairBackfillComplete: !hasRemaining && !hadFailures,
    };
  });
  return hasRemaining;
}

async function reconcileRepairHighlights(
  { reddit, redis }: RepairWork,
  targetPostId: string | undefined,
  nowMs: number,
  deadlineMs: number,
): Promise<boolean> {
  const result = await withCommunityGoalMutationLease(redis, (mutationLease) =>
    ensureExistingSubscriberGoalHighlighted({
      reddit,
      redis,
      nowMs,
      notifyOnFailure: true,
      scheduleRepairOnDegraded: false,
      reconciliationContext: "repair",
      highlightVerification: { deadlineMs },
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
