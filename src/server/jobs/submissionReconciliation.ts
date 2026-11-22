import { logDiagnostic } from "../../shared/diagnostics";
import type { SubGoalLanguage } from "../../shared/subGoalPostI18n";
import {
  SubscriberGoalCreationOutcomeUnknownError,
  submissionReconciliationDelayMs,
  type GoalPost,
} from "../core/subscriberGoalCreationModel";
import type { RedditClient } from "../types";
import { getJobRetry } from "./backoff";

const submissionReconciliationListingLimit = 100;
type PersistOperation = (fields: Record<string, string>) => Promise<void>;

// Invoked by the parent workflow while it holds the creation operation lock.
export async function reconcileAmbiguousSubmissionUnderLock({
  reddit,
  persist,
  canStart,
  raw,
  language,
  nowMs,
}: {
  reddit: RedditClient;
  persist: PersistOperation;
  canStart: (() => boolean) | undefined;
  raw: Record<string, string>;
  language: SubGoalLanguage;
  nowMs: number;
}): Promise<{
  post: GoalPost;
  reservation: SubmissionReconciliationReservation;
}> {
  const marker = raw.submissionMarker;
  const expectedSubredditName = raw.subredditName;
  const expectedSubredditId = raw.subredditId;
  const attempts = Math.max(0, Number(raw.reconciliationAttempts) || 0);
  const throwUnknown = (
    status: "pending" | "exhausted",
    nextAt?: number,
  ): never => {
    throw new SubscriberGoalCreationOutcomeUnknownError(language, {
      status,
      attempts,
      ...(nextAt === undefined ? {} : { nextAt }),
    });
  };
  if (!marker || !expectedSubredditName || !expectedSubredditId) {
    await exhaustUnverifiableSubmission(persist, attempts, nowMs);
    return throwUnknown("exhausted");
  }
  if (raw.reconciliationStatus === "exhausted") {
    return throwUnknown("exhausted");
  }
  const nextAt = await getSubmissionReconciliationDueAt(
    persist,
    raw,
    attempts,
    nowMs,
  );
  if (nowMs < nextAt || (canStart && !canStart())) {
    return throwUnknown("pending", nextAt);
  }
  const reservation = await reserveSubmissionReconciliation(
    persist,
    language,
    attempts,
    nowMs,
  );
  let match: GoalPost | undefined;
  try {
    match = await findSubmissionMarkerMatch({
      reddit,
      marker,
      expectedSubredditName,
      expectedSubredditId,
    });
  } catch (error) {
    logDiagnostic(
      "warn",
      "goal_creation_submission_reconciliation_failed",
      {
        workflow: "create_subscriber_goal",
        phase: "submission_reconciliation",
        subredditName: expectedSubredditName,
      },
      error,
    );
  }
  if (match) return { post: match, reservation };

  throw new SubscriberGoalCreationOutcomeUnknownError(language, {
    status: reservation.status,
    attempts: reservation.attempts,
    ...(reservation.nextAt === undefined ? {} : { nextAt: reservation.nextAt }),
  });
}

async function exhaustUnverifiableSubmission(
  persist: PersistOperation,
  attempts: number,
  nowMs: number,
): Promise<void> {
  try {
    await persist({
      reconciliationStatus: "exhausted",
      reconciliationAttempts: String(attempts),
      reconciliationNextAt: "",
      reconciliationCompletedAt: String(nowMs),
      updatedAt: String(Date.now()),
    });
  } catch (error) {
    logDiagnostic(
      "warn",
      "goal_creation_legacy_reconciliation_persistence_failed",
      {
        workflow: "create_subscriber_goal",
        phase: "legacy_submission_reconciliation",
      },
      error,
    );
  }
}

async function getSubmissionReconciliationDueAt(
  persist: PersistOperation,
  raw: Record<string, string>,
  attempts: number,
  nowMs: number,
): Promise<number> {
  const persistedNextAt = Number(raw.reconciliationNextAt);
  if (!Number.isFinite(persistedNextAt) || persistedNextAt <= 0) {
    const submissionStartedAt = Number(raw.updatedAt);
    const nextAt =
      (Number.isFinite(submissionStartedAt) && submissionStartedAt > 0
        ? submissionStartedAt
        : nowMs) + submissionReconciliationDelayMs[0];
    if (nowMs < nextAt) {
      try {
        await persist({
          reconciliationStatus: "pending",
          reconciliationAttempts: String(attempts),
          reconciliationStartedAt:
            raw.reconciliationStartedAt || String(submissionStartedAt || nowMs),
          reconciliationNextAt: String(nextAt),
          updatedAt: String(Date.now()),
        });
      } catch (error) {
        logDiagnostic(
          "warn",
          "goal_creation_reconciliation_schedule_persistence_failed",
          {
            workflow: "create_subscriber_goal",
            phase: "submission_reconciliation_schedule",
          },
          error,
        );
      }
    }
    return nextAt;
  }
  return persistedNextAt;
}

async function reserveSubmissionReconciliation(
  persist: PersistOperation,
  language: SubGoalLanguage | undefined,
  attempts: number,
  nowMs: number,
): Promise<SubmissionReconciliationReservation> {
  const reservation = createSubmissionReconciliationReservation(
    attempts + 1,
    nowMs,
  );
  try {
    await persist({
      reconciliationStatus: reservation.status,
      reconciliationAttempts: String(reservation.attempts),
      reconciliationNextAt: String(reservation.nextAt ?? ""),
      ...(reservation.status === "exhausted"
        ? { reconciliationCompletedAt: String(nowMs) }
        : {}),
      updatedAt: String(Date.now()),
    });
  } catch (error) {
    logDiagnostic(
      "warn",
      "goal_creation_reconciliation_reservation_failed",
      {
        workflow: "create_subscriber_goal",
        phase: "submission_reconciliation_reservation",
        reconciliationAttempts: reservation.attempts,
      },
      error,
    );
    const safeNextAt =
      reservation.nextAt ?? nowMs + submissionReconciliationDelayMs[0];
    throw new SubscriberGoalCreationOutcomeUnknownError(language, {
      status: "pending",
      attempts: reservation.attempts,
      nextAt: safeNextAt,
    });
  }
  return reservation;
}

type SubmissionReconciliationReservation = {
  status: "pending" | "exhausted";
  attempts: number;
  nextAt?: number;
};

function createSubmissionReconciliationReservation(
  attempts: number,
  nowMs: number,
): SubmissionReconciliationReservation {
  // The first delay is the wait before any scan has run.
  const retry = getJobRetry(
    { delaysMs: submissionReconciliationDelayMs },
    attempts + 1,
  );
  return retry.exhausted
    ? { status: "exhausted", attempts }
    : { status: "pending", attempts, nextAt: nowMs + retry.delayMs };
}

async function findSubmissionMarkerMatch({
  reddit,
  marker,
  expectedSubredditName,
  expectedSubredditId,
}: {
  reddit: RedditClient;
  marker: string;
  expectedSubredditName: string;
  expectedSubredditId: string;
}): Promise<GoalPost | undefined> {
  const posts = await reddit
    .getNewPosts({
      subredditName: expectedSubredditName,
      limit: submissionReconciliationListingLimit,
      pageSize: submissionReconciliationListingLimit,
    })
    .all();
  const matches: typeof posts = [];
  for (const post of posts) {
    if (
      post.subredditId !== expectedSubredditId ||
      post.subredditName.toLowerCase() !== expectedSubredditName.toLowerCase()
    ) {
      continue;
    }
    const postData = await reddit.getPostData(post.id);
    if (postData?.submissionMarker === marker) matches.push(post);
  }
  return matches.length === 1 ? (matches[0] as GoalPost) : undefined;
}
