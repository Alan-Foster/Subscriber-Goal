import { isOnboardingIneligibilityReason } from "./onboardingEligibility";
import type { OnboardingSubscriberGoalState } from "./onboardingSubscriberGoal";
import { onboardingSubscriberGoalVersion } from "./onboardingState";
import {
  parseLifecycleSource,
  parseStateNumber,
} from "./onboardingLegacyState";

export function parseOnboardingState(
  raw: Record<string, string>,
): OnboardingSubscriberGoalState | undefined {
  const status = raw.status;
  const nextRunAt = raw.nextRunAt ? parseStateNumber(raw.nextRunAt) : undefined;
  const armedAt = parseStateNumber(raw.armedAt);
  const creationStaggerMinutes = parseStateNumber(raw.creationStaggerMinutes);
  if (
    raw.version !== onboardingSubscriberGoalVersion ||
    (status !== "awaiting_warning" &&
      status !== "pending" &&
      status !== "processing" &&
      status !== "complete") ||
    armedAt === undefined ||
    creationStaggerMinutes === undefined ||
    !Number.isInteger(creationStaggerMinutes) ||
    creationStaggerMinutes < 0 ||
    !raw.operationId ||
    ((status === "pending" || status === "processing") &&
      nextRunAt === undefined)
  ) {
    return undefined;
  }
  const state: OnboardingSubscriberGoalState = {
    version: onboardingSubscriberGoalVersion,
    status,
    armedAt,
    creationStaggerMinutes,
    operationId: raw.operationId,
    lifecycleSource: parseLifecycleSource(raw.lifecycleSource),
  };
  if (nextRunAt !== undefined) state.nextRunAt = nextRunAt;
  parseOnboardingGoalMetadata(state, raw);
  parseOnboardingGoalResult(state, raw);
  return state;
}

function parseOnboardingGoalMetadata(
  state: OnboardingSubscriberGoalState,
  raw: Record<string, string>,
): void {
  const reminderSentAt = parseStateNumber(raw.reminderSentAt);
  if (reminderSentAt !== undefined) state.reminderSentAt = reminderSentAt;
  if (raw.migratedFromVersion) {
    state.migratedFromVersion = raw.migratedFromVersion;
  }
  const legacyAttempts = parseStateNumber(raw.legacyAttempts);
  if (legacyAttempts !== undefined) state.legacyAttempts = legacyAttempts;
  const eligibilitySubscriberCount = raw.eligibilitySubscriberCount
    ? parseStateNumber(raw.eligibilitySubscriberCount)
    : undefined;
  if (eligibilitySubscriberCount !== undefined) {
    state.eligibilitySubscriberCount = eligibilitySubscriberCount;
  }
  if (isOnboardingIneligibilityReason(raw.ineligibilityReason)) {
    state.ineligibilityReason = raw.ineligibilityReason;
  }
  const startedAt = parseStateNumber(raw.startedAt);
  const completedAt = parseStateNumber(raw.completedAt);
  if (startedAt !== undefined) state.startedAt = startedAt;
  if (completedAt !== undefined) state.completedAt = completedAt;
  if (raw.postId) state.postId = raw.postId;
  if (raw.errorMessage) state.errorMessage = raw.errorMessage;
  const attempts = parseStateNumber(raw.attempts);
  if (attempts !== undefined) state.attempts = attempts;
  const pausedAt = parseStateNumber(raw.pausedAt);
  if (pausedAt !== undefined) state.pausedAt = pausedAt;
  if (
    raw.intent === "missing_goal" ||
    raw.intent === "orphaned_completed_goal"
  ) {
    state.intent = raw.intent;
  }
  if (raw.replacementSourcePostId) {
    state.replacementSourcePostId = raw.replacementSourcePostId;
  }
  if (raw.pausedForAccountRecovery === "true") {
    state.pausedForAccountRecovery = true;
  }
}

function parseOnboardingGoalResult(
  state: OnboardingSubscriberGoalState,
  raw: Record<string, string>,
): void {
  if (
    raw.resultStatus === "created" ||
    raw.resultStatus === "existing" ||
    raw.resultStatus === "ineligible" ||
    raw.resultStatus === "failed" ||
    raw.resultStatus === "cancelled_permission" ||
    raw.resultStatus === "delivery_unknown" ||
    raw.resultStatus === "retry_exhausted" ||
    raw.resultStatus === "created_not_highlighted" ||
    raw.resultStatus === "existing_not_highlighted" ||
    raw.resultStatus === "replacement_scheduled" ||
    raw.resultStatus === "replacement_created" ||
    raw.resultStatus === "replacement_retrying" ||
    raw.resultStatus === "replacement_exhausted" ||
    raw.resultStatus === "completed_auto_disabled" ||
    raw.resultStatus === "completed_no_recovery" ||
    raw.resultStatus === "submission_reconciliation_pending" ||
    raw.resultStatus === "submission_reconciliation_exhausted"
  ) {
    state.resultStatus = raw.resultStatus;
  } else if (raw.resultStatus === "created_not_pinned") {
    state.resultStatus = "created_not_highlighted";
  } else if (raw.resultStatus === "existing_not_pinned") {
    state.resultStatus = "existing_not_highlighted";
  }
  parseOnboardingExistingSource(state, raw.existingSource);
}

function parseOnboardingExistingSource(
  state: OnboardingSubscriberGoalState,
  source: string | undefined,
): void {
  if (
    source === "registered" ||
    source === "tracked" ||
    source === "queued" ||
    source === "persisted" ||
    source === "highlighted" ||
    source === "search" ||
    source === "recent"
  ) {
    state.existingSource = source;
  } else if (source === "pinned") {
    state.existingSource = "highlighted";
  }
}

export function serializeOnboardingState(
  state: OnboardingSubscriberGoalState,
): Record<string, string> {
  return {
    version: state.version,
    status: state.status,
    nextRunAt: String(state.nextRunAt ?? ""),
    armedAt: String(state.armedAt),
    lifecycleSource: state.lifecycleSource,
    creationStaggerMinutes: String(state.creationStaggerMinutes),
    reminderSentAt: String(state.reminderSentAt ?? ""),
    operationId: state.operationId,
    migratedFromVersion: state.migratedFromVersion ?? "",
    legacyAttempts: String(state.legacyAttempts ?? ""),
    eligibilitySubscriberCount: String(state.eligibilitySubscriberCount ?? ""),
    ineligibilityReason: state.ineligibilityReason ?? "",
    startedAt: String(state.startedAt ?? 0),
    completedAt: String(state.completedAt ?? 0),
    postId: state.postId ?? "",
    existingSource: state.existingSource ?? "",
    resultStatus: state.resultStatus ?? "",
    errorMessage: state.errorMessage ?? "",
    intent: state.intent ?? "",
    replacementSourcePostId: state.replacementSourcePostId ?? "",
    pausedForAccountRecovery: String(state.pausedForAccountRecovery ?? false),
    attempts: String(state.attempts ?? 0),
    pausedAt: String(state.pausedAt ?? ""),
  };
}
