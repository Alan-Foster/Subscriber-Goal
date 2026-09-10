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
import { reconcileSubscriberGoalStickies } from "../utils/redditUtils";

export const appRepairStateKey = "app_repair_1_9_1_state";
export const appRepairLockKey = "app_repair_1_9_1_lock";
export const appRepairVersion = "app_repair_1_9_1";
const retryBaseMs = 5 * 60 * 1000;
const retryMaxMs = 60 * 60 * 1000;

export async function scheduleAppRepair(
  redis: RedisClient,
  nowMs = Date.now(),
  jitterMs = Math.floor(Math.random() * 60_000),
): Promise<void> {
  const current = await redis.hGetAll(appRepairStateKey);
  if (current.version === appRepairVersion) return;
  await redis.hSet(appRepairStateKey, {
    version: appRepairVersion,
    status: "pending",
    attempts: "0",
    nextRunAt: String(nowMs + Math.max(0, jitterMs)),
    scheduledAt: String(nowMs),
    lastError: "",
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
  const state = await redis.hGetAll(appRepairStateKey);
  if (
    state.version !== appRepairVersion ||
    state.status === "complete" ||
    !Number.isFinite(Number(state.nextRunAt)) ||
    nowMs < Number(state.nextRunAt)
  ) {
    return "not_due";
  }

  const lockToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(appRepairLockKey, lockToken, {
    nx: true,
    expiration: new Date(nowMs + 15 * 60 * 1000),
  });
  if ((await redis.get(appRepairLockKey)) !== lockToken) return "not_due";

  const failures: string[] = [];
  const runPhase = async (phase: string, operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(`${phase}: ${error instanceof Error ? error.message : String(error)}`);
      logDiagnostic(
        "warn",
        "app_repair_phase_failed",
        { workflow: "app_repair", phase },
        error,
      );
    }
  };

  try {
    await redis.hSet(appRepairStateKey, {
      ...state,
      status: "processing",
      startedAt: String(nowMs),
    });
    const subreddit = await reddit.getCurrentSubreddit();

    await runPhase("app_account_health", () =>
      checkAppAccountHealth({
        reddit,
        redis,
        subredditName: subreddit.name,
        subredditId: subreddit.id,
      }),
    );
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
        await runPhase("update_queue", () => queueUpdates(redis, trackedPosts!));
      }

      let flairId: string | undefined;
      await runPhase("flair_ensure", async () => {
        flairId = (await ensureSubscriberGoalPostFlair(reddit, subreddit.name)).id;
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
      await runPhase("sticky_reconciliation", () =>
        reconcileSubscriberGoalStickies(reddit, {
          knownPostIds: candidatePostIds!,
          subreddit,
        }),
      );
    } else {
      failures.push("migration_discovery: incomplete");
    }

    if (failures.length === 0) {
      await redis.hSet(appRepairStateKey, {
        ...state,
        status: "complete",
        completedAt: String(nowMs),
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
