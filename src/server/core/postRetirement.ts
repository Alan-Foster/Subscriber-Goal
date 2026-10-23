import { logDiagnostic } from "../../shared/diagnostics";
import {
  autoCreateNextGoalExhaustedKey,
  autoCreateNextGoalQueueKey,
  autoCreateNextGoalRetryAttemptsKey,
  autoCreateNextGoalSuccessorsKey,
  subscriberGoalPostFieldSuffixes,
  subscriberGoalsKey,
} from "../data/subGoalData";
import { removeSubscriberGoalPost } from "../data/subscriberGoalPostRegistry";
import { cancelUpdates, untrackPost } from "../data/updaterData";
import {
  clearHighlightManagementBaselineForPost,
  getHighlightManagementBaseline,
} from "../data/highlightManagement";
import { scheduleHighlightRepair } from "../data/highlightRepair";
import { clearHighlightFailureIncident } from "../utils/highlightFailureNotifications";
import { clearHighlightContradictionIncident } from "../data/highlightContradiction";
import { clearPostOperationalState } from "../data/postOperationalState";
import type { LinkId, RedisClient } from "../types";

export const retiredSubscriberGoalKeyPrefix = "retired_subscriber_goal_v1";
export const retiredSubscriberGoalTtlSeconds = 30 * 24 * 60 * 60;

export type PostLookupOutcome =
  | { status: "found" }
  | { status: "missing"; reason: string }
  | { status: "retryable"; reason: string };

export function classifyPostLookupError(
  error: unknown,
  postId?: string,
): PostLookupOutcome {
  const record = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const status = Number(record?.status ?? record?.statusCode);
  const code =
    typeof record?.code === "string" ? record.code.toUpperCase() : "";
  const message =
    error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : String(error);
  if (
    status === 404 ||
    status === 410 ||
    code === "NOT_FOUND" ||
    code === "GONE"
  ) {
    return { status: "missing", reason: message };
  }
  const escapedPostId = postId?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    escapedPostId &&
    new RegExp(
      `(?:no post\\s+${escapedPostId}|${escapedPostId}\\s+(?:does not exist|was deleted))`,
      "i",
    ).test(message)
  ) {
    return { status: "missing", reason: message };
  }
  return { status: "retryable", reason: message };
}

export async function isSubscriberGoalPostRetired(
  redis: RedisClient,
  postId: string,
): Promise<boolean> {
  return (
    (await redis.get(`${retiredSubscriberGoalKeyPrefix}:${postId}`)) !==
    undefined
  );
}

export async function retireSubscriberGoalPost(
  redis: RedisClient,
  postId: LinkId,
  reason: string,
  nowMs = Date.now(),
): Promise<void> {
  const wasCanonical =
    (await getHighlightManagementBaseline(redis))?.canonicalPostId === postId;
  const failures: string[] = [];
  const attempt = async (phase: string, operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(phase);
      logDiagnostic(
        "warn",
        "subscriber_goal_retirement_phase_failed",
        { workflow: "post_retirement", phase, postId },
        error,
      );
    }
  };

  await redis.set(
    `${retiredSubscriberGoalKeyPrefix}:${postId}`,
    JSON.stringify({ reason, retiredAt: nowMs }),
    { expiration: new Date(nowMs + retiredSubscriberGoalTtlSeconds * 1000) },
  );
  await attempt("registry", () => removeSubscriberGoalPost(redis, postId));
  await attempt("updates", () => cancelUpdates(redis, postId));
  await attempt("tracking", () => untrackPost(redis, postId));
  await attempt("successor_queue", () =>
    redis.zRem(autoCreateNextGoalQueueKey, [postId]),
  );
  await attempt("successor_retry", () =>
    redis.hDel(autoCreateNextGoalRetryAttemptsKey, [postId]),
  );
  await attempt("successor_exhausted", () =>
    redis.hDel(autoCreateNextGoalExhaustedKey, [postId]),
  );
  await attempt("successor_source", () =>
    redis.hDel(autoCreateNextGoalSuccessorsKey, [postId]),
  );
  await attempt("successor_reverse", async () => {
    let cursor = 0;
    do {
      const page = await redis.hScan(
        autoCreateNextGoalSuccessorsKey,
        cursor,
        undefined,
        500,
      );
      cursor = page.cursor;
      const reverseFields = page.fieldValues
        .filter(({ value }) => value === postId)
        .map(({ field }) => field);
      if (reverseFields.length > 0) {
        await redis.hDel(autoCreateNextGoalSuccessorsKey, reverseFields);
      }
    } while (cursor !== 0);
  });
  await attempt("goal_data", () =>
    redis.hDel(
      subscriberGoalsKey,
      subscriberGoalPostFieldSuffixes.map((suffix) => `${postId}${suffix}`),
    ),
  );
  await attempt("highlight_incident", () =>
    clearHighlightFailureIncident(redis, postId),
  );
  await attempt("highlight_contradiction", () =>
    clearHighlightContradictionIncident(redis, postId),
  );
  await attempt("post_operational_state", () =>
    clearPostOperationalState(redis, postId),
  );
  await attempt("highlight_baseline", () =>
    clearHighlightManagementBaselineForPost(redis, postId),
  );
  if (wasCanonical) {
    await attempt("highlight_reconciliation", () =>
      scheduleHighlightRepair(redis, {
        nowMs,
        delayMs: 5 * 60 * 1000,
        force: true,
        reason: "canonical_post_retired",
      }),
    );
  }
  if (failures.length > 0) {
    throw new Error(`Post retirement incomplete: ${failures.join(", ")}`);
  }
}
