import { logDiagnostic } from "../../shared/diagnostics";
import { translate } from "../../shared/i18n/catalog";
import type { RedditClient, RedisClient } from "../types";

export const automaticGoalPrerequisiteRetriesKey =
  "automatic_goal_prerequisite_retries_v1";

// Uncertain prerequisites have capped backoff, separate from submission attempts.
export async function nextAutomaticGoalPrerequisiteRetry(
  redis: RedisClient,
  operationId: string,
  nowMs: number,
): Promise<number> {
  const previous =
    Number(
      await redis.hGet(automaticGoalPrerequisiteRetriesKey, operationId),
    ) || 0;
  const attempts = Math.min(5, Math.max(0, previous) + 1);
  await redis.hSet(automaticGoalPrerequisiteRetriesKey, {
    [operationId]: String(attempts),
  });
  return nowMs + Math.min(60 * 60 * 1000, 5 * 60 * 1000 * 2 ** (attempts - 1));
}

export async function resetAutomaticGoalPrerequisiteRetry(
  redis: RedisClient,
  operationId: string,
): Promise<void> {
  await redis.hSet(automaticGoalPrerequisiteRetriesKey, { [operationId]: "0" });
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
  if (raw.reconciliationStatus !== "exhausted") return true;
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
  const key = `automatic_goal_exhaustion_notices_v1:${operationId}`;
  try {
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
