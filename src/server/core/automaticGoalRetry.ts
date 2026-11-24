import { logDiagnostic } from "../../shared/diagnostics";
import { translate } from "../../shared/i18n/catalog";
import { getJobBackoffDelay } from "../jobs/backoff";
import type { RedditClient, RedisClient } from "../types";

export const automaticGoalPrerequisiteRetriesKey =
  "automatic_goal_prerequisite_retries_v1";

export const automaticGoalPrerequisiteMaxAgeMs = 48 * 60 * 60 * 1000;
export const automaticGoalRetryGenerationsKey =
  "automatic_goal_retry_generations_v1";
const prerequisiteBackoff = { baseMs: 5 * 60_000, maxMs: 60 * 60_000 };

// Uncertain prerequisites have capped backoff, separate from submission attempts.
export async function nextAutomaticGoalPrerequisiteRetry(
  redis: RedisClient,
  operationId: string,
  nowMs: number,
  scheduledAt?: number,
): Promise<{ attempts: number; retryAt: number | null }> {
  const firstField = operationId + ":firstDeferredAt";
  const previous = Number(
    await redis.hGet(automaticGoalPrerequisiteRetriesKey, operationId),
  );
  const rawFirst = await redis.hGet(
    automaticGoalPrerequisiteRetriesKey,
    firstField,
  );
  const previousFirst =
    rawFirst !== undefined && Number.isFinite(Number(rawFirst))
      ? Number(rawFirst)
      : nowMs;
  // Error retries never schedule past their deadline. An older queued wait
  // can still have a failure window left over from before waits cleared it.
  const followedWait =
    scheduledAt !== undefined &&
    scheduledAt > previousFirst + automaticGoalPrerequisiteMaxAgeMs;
  const first = followedWait ? nowMs : previousFirst;
  const attempts =
    (followedWait || !Number.isFinite(previous) ? 0 : Math.max(0, previous)) +
    1;
  await redis.hSet(automaticGoalPrerequisiteRetriesKey, {
    [operationId]: String(attempts),
    [firstField]: String(first),
  });
  const deadline = first + automaticGoalPrerequisiteMaxAgeMs;
  return {
    attempts,
    retryAt:
      nowMs >= deadline
        ? null
        : Math.min(
            deadline,
            nowMs + getJobBackoffDelay(prerequisiteBackoff, attempts),
          ),
  };
}

export async function resetAutomaticGoalPrerequisiteRetry(
  redis: RedisClient,
  operationId: string,
): Promise<void> {
  await redis.hDel(automaticGoalPrerequisiteRetriesKey, [
    operationId,
    operationId + ":firstDeferredAt",
  ]);
}

// Called only for an actual lifecycle re-arm while the community lease is held.
export async function beginAutomaticGoalRetryGeneration(
  redis: RedisClient,
  operationId: string,
): Promise<void> {
  const generation =
    Number(await redis.hGet(automaticGoalRetryGenerationsKey, operationId)) ||
    0;
  await redis.hSet(automaticGoalRetryGenerationsKey, {
    [operationId]: String(generation + 1),
  });
  await resetAutomaticGoalPrerequisiteRetry(redis, operationId);
}

export function isAutomaticGoalPrerequisiteError(error: unknown): boolean {
  return (
    error instanceof Error &&
    [
      "AutomaticGoalPrerequisiteError",
      "SubscriberGoalPermissionVerificationError",
      "SubscriberGoalModeratorPermissionError",
      "SubscriberGoalCreationInProgressError",
    ].includes(error.name)
  );
}

export class AutomaticGoalPrerequisiteError extends Error {
  constructor(cause: unknown) {
    super("Automatic goal prerequisites could not be verified.", { cause });
    this.name = "AutomaticGoalPrerequisiteError";
  }
}

// Lifecycle callers hold the community mutation lease, just like creation.
// Only restart lookup; the ambiguous status and original marker stay intact.
export async function rearmAutomaticGoalReconciliation(
  redis: RedisClient,
  operationId: string,
  nowMs: number,
  restartPrerequisites = false,
): Promise<boolean> {
  const key = `subscriber_goal_creation_v1:${operationId}`;
  const raw = await redis.hGetAll(key);
  if (
    (raw.status !== "submitting" && raw.status !== "submission_unknown") ||
    !raw.submissionMarker ||
    !raw.subredditId ||
    !raw.subredditName
  )
    return false;
  if (raw.reconciliationStatus !== "exhausted" && !restartPrerequisites)
    return true;
  await beginAutomaticGoalRetryGeneration(redis, operationId);
  await redis.hSet(key, {
    reconciliationStatus: "pending",
    reconciliationAttempts: "0",
    reconciliationNextAt: String(nowMs),
    reconciliationCompletedAt: "",
  });
  return true;
}

// Reserve delivery before Modmail: a lost response must not send a second
// notice when an upgrade re-arms the same operation.
export async function notifyAutomaticGoalExhausted({
  reddit,
  redis,
  operationId,
  unresolved,
  language,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  operationId: string;
  unresolved: boolean;
  language?: unknown;
}): Promise<void> {
  try {
    const generation = await redis.hGet(
      automaticGoalRetryGenerationsKey,
      operationId,
    );
    // Generation zero keeps compatibility with reservations written before generations.
    const key =
      `automatic_goal_exhaustion_notices_v1:${operationId}` +
      (generation ? `:${generation}` : "");
    const subreddit = await reddit.getCurrentSubreddit();
    const token = crypto.randomUUID();
    await redis.set(key, token, { nx: true });
    if ((await redis.get(key)) !== token) return;
    await reddit.modMail.createModNotification({
      subredditId: subreddit.id,
      subject: translate(
        language ?? subreddit.language,
        "outbound.automaticGoal.exhaustedSubject",
      ),
      bodyMarkdown: translate(
        language ?? subreddit.language,
        unresolved
          ? "outbound.automaticGoal.unresolvedBody"
          : "outbound.automaticGoal.exhaustedBody",
        { operationId },
      ),
    });
  } catch (error) {
    logDiagnostic(
      "warn",
      "automatic_goal_exhaustion_notification_failed",
      {
        workflow: "automatic_goal_creation",
        phase: "exhaustion_notification",
        operationId,
      },
      error,
    );
  }
}
