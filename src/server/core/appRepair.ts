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
import { ensureExistingSubscriberGoalHighlighted } from "./onboardingSubscriberGoal";
import {
  appRepairLockKey,
  appRepairStateKey,
  appRepairVersion,
  scheduleHighlightRepair,
  recurringHighlightRepairIntervalMs,
} from "../data/highlightRepair";
import { withCommunityGoalMutationLease } from "./communityGoalMutation";
import { isSubscriberGoalPostRetired } from "./postRetirement";
import { autoCreateNextGoalSuccessorsKey } from "../data/subGoalData";

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
  let state = await redis.hGetAll(appRepairStateKey);
  if (!isAppRepairDue(state, nowMs)) return "not_due";

  const lockToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(appRepairLockKey, lockToken, {
    nx: true,
    expiration: new Date(nowMs + 15 * 60 * 1000),
  });
  if ((await redis.get(appRepairLockKey)) !== lockToken) return "not_due";

  const failures: string[] = [];
  let recurringHighlightCheck = false;
  const runPhase = async (phase: string, operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
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
    state = await redis.hGetAll(appRepairStateKey);
    if (!isAppRepairDue(state, nowMs)) return "not_due";
    await redis.hSet(appRepairStateKey, {
      ...state,
      status: "processing",
      startedAt: String(nowMs),
    });
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

    if (failures.length === 0) {
      await redis.hSet(appRepairStateKey, {
        ...state,
        status: "complete",
        completedAt: String(nowMs),
        recurring: recurringHighlightCheck ? "true" : "false",
        nextRunAt: recurringHighlightCheck
          ? String(nowMs + recurringHighlightRepairIntervalMs)
          : "",
        targetPostId: "",
        lastError: "",
      });
      return "complete";
    }

    const attempts = (parseInt(state.attempts ?? "0", 10) || 0) + 1;
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempts - 1));
    await redis.hSet(appRepairStateKey, {
      ...state,
      status: "pending",
      attempts: String(attempts),
      nextRunAt: String(nowMs + delay),
      lastError: failures.join(" | "),
    });
    return "retry";
  } catch (error) {
    const attempts = (parseInt(state.attempts ?? "0", 10) || 0) + 1;
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempts - 1));
    await redis.hSet(appRepairStateKey, {
      ...state,
      status: "pending",
      attempts: String(attempts),
      nextRunAt: String(nowMs + delay),
      lastError: error instanceof Error ? error.message : String(error),
    });
    logDiagnostic(
      "error",
      "app_repair_failed",
      { workflow: "app_repair", phase: "execution" },
      error,
    );
    return "retry";
  } finally {
    if ((await redis.get(appRepairLockKey)) === lockToken) {
      await redis.del(appRepairLockKey);
    }
  }
}
