import type { ServerAppSettings } from "../settings";
import type { LinkId, RedditClient, RedisClient, SubredditId } from "../types";
import { dispatchPostAction } from "../data/crosspostData";
import {
  getSourcePostDeletionIntent,
  listDueSourcePostDeletionIntents,
  saveSourcePostDeletionIntent,
  sourcePostDeletionIntentId,
  type SourcePostDeletionIntent,
} from "../data/sourcePostDeletion";
import { classifyPostLookupError } from "./postRetirement";
import {
  CommunityGoalMutationInProgressError,
  withCommunityGoalMutationLease,
} from "./communityGoalMutation";
import { logDiagnostic } from "../../shared/diagnostics";

const retryBaseMs = 60_000;
const retryMaxMs = 30 * 60_000;
const maxAttempts = 20;

function nextDelay(attemptCount: number): number {
  return Math.min(retryBaseMs * 2 ** Math.max(0, attemptCount), retryMaxMs);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function prepareSourcePostDeletionIntent(
  redis: RedisClient,
  input: {
    postId: LinkId;
    subredditId: SubredditId;
    subredditName: string;
    nowMs?: number;
  },
): Promise<SourcePostDeletionIntent> {
  const nowMs = input.nowMs ?? Date.now();
  const id = sourcePostDeletionIntentId(input.subredditId, input.postId);
  const existing = await getSourcePostDeletionIntent(redis, id);
  if (existing) return existing;
  return saveSourcePostDeletionIntent(redis, {
    id,
    postId: input.postId,
    subredditId: input.subredditId,
    subredditName: input.subredditName,
    status: "ready_to_delete",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    nextAttemptMs: nowMs,
    attemptCount: 0,
    deleteAttemptCount: 0,
    lastError: null,
  });
}

export async function recordSourceDeleteAttempt(
  redis: RedisClient,
  intent: SourcePostDeletionIntent,
  nowMs = Date.now(),
): Promise<SourcePostDeletionIntent> {
  return saveSourcePostDeletionIntent(redis, {
    ...intent,
    status: "verify_source",
    updatedAtMs: nowMs,
    nextAttemptMs: nowMs + retryBaseMs,
    deleteAttemptCount: intent.deleteAttemptCount + 1,
    lastError: null,
  });
}

export async function recordSourceDeletionConfirmed(
  redis: RedisClient,
  intent: SourcePostDeletionIntent,
  nowMs = Date.now(),
): Promise<SourcePostDeletionIntent> {
  return saveSourcePostDeletionIntent(redis, {
    ...intent,
    status: "dispatch_pending",
    updatedAtMs: nowMs,
    nextAttemptMs: nowMs,
    lastError: null,
  });
}

export async function dispatchConfirmedSourceDeletion(
  reddit: RedditClient,
  redis: RedisClient,
  appSettings: ServerAppSettings,
  intent: SourcePostDeletionIntent,
  nowMs = Date.now(),
): Promise<SourcePostDeletionIntent> {
  if (intent.status === "dispatched") return intent;
  if (
    intent.subredditName.toLowerCase() !==
    appSettings.promoSubreddit.toLowerCase()
  ) {
    await dispatchPostAction(reddit, appSettings, intent.postId, "delete");
  }
  return saveSourcePostDeletionIntent(redis, {
    ...intent,
    status: "dispatched",
    updatedAtMs: nowMs,
    nextAttemptMs: nowMs,
    lastError: null,
    dispatchedAtMs: nowMs,
  });
}

export async function queueConfirmedSourceDeletionCleanup(
  reddit: RedditClient,
  redis: RedisClient,
  appSettings: ServerAppSettings,
  input: {
    postId: LinkId;
    subredditId: SubredditId;
    subredditName: string;
    nowMs?: number;
  },
): Promise<"queued" | "dispatched"> {
  return withCommunityGoalMutationLease(redis, async () => {
    const nowMs = input.nowMs ?? Date.now();
    let intent = await prepareSourcePostDeletionIntent(redis, {
      ...input,
      nowMs,
    });
    if (intent.status === "dispatched") return "dispatched";
    if (intent.status !== "dispatch_pending") {
      intent = await recordSourceDeletionConfirmed(redis, intent, nowMs);
    }
    try {
      await dispatchConfirmedSourceDeletion(
        reddit,
        redis,
        appSettings,
        intent,
        nowMs,
      );
      return "dispatched";
    } catch (error) {
      // dispatch_pending is already durable. The normal due worker owns retry.
      logDiagnostic(
        "warn",
        "source_post_deletion_dispatch_pending",
        { workflow: "source_post_deletion", postId: input.postId },
        error,
      );
      return "queued";
    }
  });
}

async function reschedule(
  redis: RedisClient,
  intent: SourcePostDeletionIntent,
  error: unknown,
  nowMs: number,
): Promise<void> {
  const attemptCount = intent.attemptCount + 1;
  await saveSourcePostDeletionIntent(redis, {
    ...intent,
    status: attemptCount >= maxAttempts ? "terminal_failed" : intent.status,
    updatedAtMs: nowMs,
    nextAttemptMs: nowMs + nextDelay(intent.attemptCount),
    attemptCount,
    lastError: toErrorMessage(error),
  });
}

async function processOneDueIntent(
  reddit: RedditClient,
  redis: RedisClient,
  appSettings: ServerAppSettings,
  dueIntent: SourcePostDeletionIntent,
  nowMs: number,
): Promise<void> {
  await withCommunityGoalMutationLease(redis, async () => {
    const intent = await getSourcePostDeletionIntent(redis, dueIntent.id);
    if (!intent || intent.nextAttemptMs > nowMs) {
      return;
    }
    if (intent.status === "dispatched" || intent.status === "terminal_failed") {
      return;
    }
    if (intent.status === "dispatch_pending") {
      try {
        await dispatchConfirmedSourceDeletion(
          reddit,
          redis,
          appSettings,
          intent,
          nowMs,
        );
      } catch (error) {
        logDiagnostic(
          "warn",
          "source_post_deletion_dispatch_retry_scheduled",
          { workflow: "source_post_deletion", postId: intent.postId },
          error,
        );
        await reschedule(redis, intent, error, nowMs);
      }
      return;
    }

    try {
      // Recovery is verification-only. A scheduler tick never repeats the
      // destructive Reddit call after a response may have been lost.
      const post = await reddit.getPostById(intent.postId);
      if (
        (post as { removedByCategory?: unknown }).removedByCategory !==
        "deleted"
      ) {
        await reschedule(redis, intent, "source_still_live", nowMs);
        return;
      }
    } catch (error) {
      // diagnostic-allow-silent: lookup failures are classified into expected missing evidence or durable retry state.
      const outcome = classifyPostLookupError(error, intent.postId);
      if (outcome.status !== "missing") {
        await reschedule(
          redis,
          intent,
          outcome.status === "retryable"
            ? outcome.reason
            : "source_lookup_inconclusive",
          nowMs,
        );
        return;
      }
    }

    const confirmed = await recordSourceDeletionConfirmed(redis, intent, nowMs);
    try {
      await dispatchConfirmedSourceDeletion(
        reddit,
        redis,
        appSettings,
        confirmed,
        nowMs,
      );
    } catch (error) {
      logDiagnostic(
        "warn",
        "source_post_deletion_dispatch_retry_scheduled",
        { workflow: "source_post_deletion", postId: confirmed.postId },
        error,
      );
      await reschedule(redis, confirmed, error, nowMs);
    }
  });
}

export async function processDueSourcePostDeletions(
  reddit: RedditClient,
  redis: RedisClient,
  appSettings: ServerAppSettings,
  options: { nowMs?: number; limit?: number } = {},
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const due = await listDueSourcePostDeletionIntents(redis, {
    nowMs,
    limit: options.limit ?? 10,
  });
  for (const intent of due) {
    try {
      await processOneDueIntent(reddit, redis, appSettings, intent, nowMs);
    } catch (error) {
      if (!(error instanceof CommunityGoalMutationInProgressError)) {
        logDiagnostic(
          "error",
          "source_post_deletion_recovery_failed",
          { workflow: "source_post_deletion", postId: intent.postId },
          error,
        );
      }
    }
  }
}
