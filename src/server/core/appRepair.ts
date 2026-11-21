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
  appRepairVersion,
  scheduleHighlightRepair,
  recurringHighlightRepairIntervalMs,
  updateAppRepairState,
} from "../data/highlightRepair";
import {
  CommunityGoalMutationInProgressError,
  withCommunityGoalMutationLease,
} from "./communityGoalMutation";
import { isSubscriberGoalPostRetired } from "./postRetirement";
import { autoCreateNextGoalSuccessorsKey } from "../data/subGoalData";
import { acquireRedisLock, releaseRedisLock } from "../utils/redisOwnedLock";

export { appRepairLockKey, appRepairStateKey, appRepairVersion };
const retryBaseMs = 5 * 60 * 1000;
const retryMaxMs = 60 * 60 * 1000;
export { recurringHighlightRepairIntervalMs };

function isAppRepairDue(state: Record<string, string>, nowMs: number): boolean {
  const nextRunAt = Number(state.nextRunAt);
  return (
    state.version === appRepairVersion &&
    (state.status !== "complete" || state.recurring === "true") &&
    Number.isFinite(nextRunAt) &&
    nowMs >= nextRunAt
  );
}

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
  nowMs = Date.now(),
}: {
  reddit: RedditClient;
  redis: RedisClient;
  nowMs?: number;
}): Promise<"not_due" | "complete" | "retry"> {
  if (!isAppRepairDue(await redis.hGetAll(appRepairStateKey), nowMs)) {
    return "not_due";
  }

  const lockToken = await acquireRedisLock(
    redis,
    appRepairLockKey,
    15 * 60 * 1000,
    { nowMs },
  );
  if (!lockToken) return "not_due";

  const failures: string[] = [];
  let highlightDeferred = false;
  let recurringHighlightCheck = false;
  let claimedState: Record<string, string> | undefined;
  const startedAt = String(nowMs);
  const isCurrentRun = (current: Record<string, string>) =>
    current.version === appRepairVersion && current.startedAt === startedAt;
  const retryAfterFailure = async (message: string) => {
    const state = claimedState;
    if (!state) return;
    const attempts = (parseInt(state.attempts ?? "0", 10) || 0) + 1;
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempts - 1));
    await updateAppRepairState(redis, (current) => {
      if (!isCurrentRun(current)) return;
      if (current.status !== "processing" && current.status !== "pending") {
        return;
      }
      const requestedRunAt = Number(current.nextRunAt);
      const nextRunAt =
        current.status === "pending" && Number.isFinite(requestedRunAt)
          ? Math.min(nowMs + delay, requestedRunAt)
          : nowMs + delay;
      return {
        ...(current.status === "processing" ? state : {}),
        status: "pending",
        attempts: String(attempts),
        nextRunAt: String(nextRunAt),
        lastError: message,
      };
    });
  };
  const runPhase = async (phase: string, operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      if (
        phase === "highlight_reconciliation" &&
        error instanceof CommunityGoalMutationInProgressError
      ) {
        highlightDeferred = true;
        logDiagnostic("info", "app_repair_phase_deferred", {
          workflow: "app_repair",
          phase,
          reason: "mutation_lease_busy",
        });
        return;
      }
      failures.push(
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

  try {
    const state = await updateAppRepairState(redis, (current) =>
      isAppRepairDue(current, nowMs)
        ? { status: "processing", startedAt }
        : undefined,
    );
    if (!state) return "not_due";
    claimedState = state;
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
      await runPhase("post_kind_migration", () =>
        initializePostKindMigration(redis, trackedPosts!),
      );
      await runPhase("after_subscribe_action_migration", () =>
        initializeLegacyAfterSubscribeActionMigration(
          redis,
          candidatePostIds!,
          { name: subreddit.name, type: subreddit.type },
        ),
      );
      if (trackedPosts.length > 0) {
        await runPhase("update_queue", () =>
          queueUpdates(redis, trackedPosts!),
        );
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
            candidatePostIds!,
            flairId!,
          ),
        );
      }
      await runPhase("highlight_reconciliation", async () => {
        const result = await withCommunityGoalMutationLease(
          redis,
          (mutationLease) =>
            ensureExistingSubscriberGoalHighlighted({
              reddit,
              redis,
              nowMs,
              notifyOnFailure: true,
              reconciliationContext: "repair",
              mutationLease,
            }),
        );
        recurringHighlightCheck =
          result.capacityOnly === true ||
          (result.eligiblePostIds?.length ?? 0) > 0;
        const onlyRemovedGoalsUnhighlighted =
          result.pausedByRemovedGoal &&
          (result.unhighlightedEligiblePostIds?.length ?? 0) > 0 &&
          result.unhighlightedEligiblePostIds.every((postId) =>
            result.removedGoalBlockerPostIds?.includes(postId),
          );
        const expectedTargetOutstanding = state.targetPostId
          ? !(await isSubscriberGoalPostRetired(redis, state.targetPostId)) &&
            !(await redis.hGet(
              autoCreateNextGoalSuccessorsKey,
              state.targetPostId,
            ))
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
      });
    } else {
      failures.push("migration_discovery: incomplete");
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

    if (failures.length > 0) {
      await retryAfterFailure(failures.join(" | "));
      return "retry";
    }

    const finished = await updateAppRepairState(redis, (current) => {
      // Scheduling a request changes processing to pending, including requests
      // made by this run and requests with the same timestamp.
      if (!isCurrentRun(current) || current.status !== "processing") return;
      if (highlightDeferred) {
        return {
          ...state,
          status: "pending",
          nextRunAt: String(nowMs + retryBaseMs),
        };
      }
      return {
        ...state,
        status: "complete",
        completedAt: String(nowMs),
        recurring: recurringHighlightCheck ? "true" : "false",
        nextRunAt: recurringHighlightCheck
          ? String(nowMs + recurringHighlightRepairIntervalMs)
          : "",
        targetPostId: "",
        lastError: "",
      };
    });
    return finished && !highlightDeferred ? "complete" : "retry";
  } catch (error) {
    await retryAfterFailure(
      error instanceof Error ? error.message : String(error),
    );
    logDiagnostic(
      "error",
      "app_repair_failed",
      { workflow: "app_repair", phase: "execution" },
      error,
    );
    return "retry";
  } finally {
    await releaseRedisLock(redis, appRepairLockKey, lockToken);
  }
}
