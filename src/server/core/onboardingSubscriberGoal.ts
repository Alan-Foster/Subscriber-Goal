import {
  nextAutomaticGoalPrerequisiteRetry,
  resetAutomaticGoalPrerequisiteRetry,
  isAutomaticGoalPrerequisiteError,
  notifyAutomaticGoalExhausted,
} from "./automaticGoalRetry";
import {
  createDefaultAfterSubscribeAction,
  defaultAfterSubscribeColorTheme,
  getDefaultAfterSubscribePreset,
} from "../../shared/afterSubscribeAction";
import {
  getAfterSubscribePresetMessages,
  getSubGoalPostMessages,
  resolveSubGoalLanguage,
} from "../../shared/subGoalPostI18n";
import { logDiagnostic } from "../../shared/diagnostics";
import type { ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import { getDefaultSubscriberGoal } from "../utils/numberUtils";
import { isCrosspostEligible, isNsfwOrUnknown } from "../utils/subredditSafety";
import {
  clearHighlightFailureIncident,
  getPostUrl,
  notifyHighlightFailureIncident,
} from "../utils/highlightFailureNotifications";
import {
  autoCreateNextGoalSuccessorsKey,
  cancelAutoCreateNextGoal,
} from "../data/subGoalData";
import {
  PostTemporarilyUnavailableError,
  temporarilyRemovedPostRecheckDelayMs,
} from "../utils/postStatus";
import {
  createSubscriberGoal,
  SubscriberGoalCreationOutcomeUnknownError,
} from "./createSubscriberGoal";
import { checkAppAccountHealth } from "./appAccountHealth";
import {
  reconcileCompletedGoal,
  type CompletedGoalReconciliationOutcome,
} from "./completedGoalReconciliation";
import {
  getAutomaticGoalEligibility,
  isAutomaticGoalEligibilityUncertain,
  type AutomaticGoalIneligibilityReason,
} from "./automaticGoalEligibility";
import {
  onboardingGoalBaseDelayMs,
  onboardingGoalStaggerMaxMinutes,
  onboardingGoalStaggerMinMinutes,
  onboardingMinimumSubscriberCount,
} from "./onboardingConfig";
import {
  CommunityGoalMutationInProgressError,
  withCommunityGoalMutationLease,
  type CommunityGoalMutationLease,
} from "./communityGoalMutation";
import { acquireRedisLock, releaseRedisLock } from "../utils/redisOwnedLock";
import {
  type OnboardingLifecycleSource,
  type OnboardingExistingSource,
  emptySummary,
  formatDetectionDiagnostics,
  getDetectionDiagnosticsFromError,
} from "./goalDiscovery";
import {
  emptyHighlightEnsuranceResult,
  ensureExistingSubscriberGoalHighlighted,
} from "./highlightReconciliation";

export {
  onboardingGoalBaseDelayMs,
  onboardingGoalStaggerMaxMinutes,
  onboardingGoalStaggerMinMinutes,
  onboardingMinimumSubscriberCount,
} from "./onboardingConfig";

export const onboardingSubscriberGoalStateKey =
  "onboarding_subscriber_goal_v4_state";

export const onboardingSubscriberGoalLockKey =
  "onboarding_subscriber_goal_v4_lock";

export const onboardingSubscriberGoalInitializationLockKey =
  "onboarding_subscriber_goal_v4_init_lock";

export const onboardingSubscriberGoalVersion = "onboarding_subscriber_goal_v4";

/** Checked at every onboarding side-effect boundary so a hotfix can pause armed work. */
export const AUTOMATIC_ONBOARDING_ENABLED = true;

export const onboardingUpgradeWaveEnabled = AUTOMATIC_ONBOARDING_ENABLED;

export const onboardingTinySubscriberThreshold = 1_000_000;

export const onboardingSubscriberGoalLockTtlMs = 15 * 60 * 1000;

export const onboardingSubscriberGoalInitializationLockTtlMs = 60 * 1000;

export const onboardingMaxAttempts = 3;

type OnboardingStatus =
  "awaiting_warning" | "pending" | "processing" | "complete";

type OnboardingResultStatus = "created" | "existing" | "ineligible" | "failed";

const onboardingRetryBaseMs = 5 * 60 * 1000;

const onboardingRetryMaxMs = 60 * 60 * 1000;

type ExtendedOnboardingResultStatus =
  | OnboardingResultStatus
  | "cancelled_permission"
  | "delivery_unknown"
  | "retry_exhausted"
  | "created_not_highlighted"
  | "existing_not_highlighted"
  | "replacement_scheduled"
  | "replacement_created"
  | "replacement_retrying"
  | "replacement_exhausted"
  | "completed_auto_disabled"
  | "completed_no_recovery"
  | "submission_reconciliation_pending"
  | "submission_reconciliation_exhausted";

export type OnboardingIneligibilityReason =
  "subscriber_count" | "subreddit_not_sfw" | AutomaticGoalIneligibilityReason;

export type OnboardingEligibility = {
  eligible: boolean;
  subscriberCount: number;
  subredditType: string;
  isSfw: boolean;
  safetyStatus: "sfw" | "nsfw" | "unknown";
  reason?: OnboardingIneligibilityReason;
};

export type OnboardingSubscriberGoalState = {
  version: typeof onboardingSubscriberGoalVersion;
  status: OnboardingStatus;
  nextRunAt?: number;
  armedAt: number;
  lifecycleSource: OnboardingLifecycleSource;
  creationStaggerMinutes: number;
  reminderSentAt?: number;
  operationId: string;
  migratedFromVersion?: string;
  legacyAttempts?: number;
  eligibilitySubscriberCount?: number;
  ineligibilityReason?: OnboardingIneligibilityReason;
  startedAt?: number;
  completedAt?: number;
  postId?: string;
  existingSource?: OnboardingExistingSource;
  resultStatus?: ExtendedOnboardingResultStatus;
  errorMessage?: string;
  attempts?: number;
  pausedAt?: number;
  intent?: "missing_goal" | "orphaned_completed_goal";
  replacementSourcePostId?: string;
  pausedForAccountRecovery?: boolean;
};

export type OnboardingSubscriberGoalSummary = {
  status:
    | "not_due"
    | "created"
    | "existing"
    | "ineligible"
    | "cancelled"
    | "paused"
    | "failed"
    | "complete";
  registeredInspected: number;
  trackedInspected: number;
  queuedInspected: number;
  persistedInspected: number;
  highlightedInspected: number;
  searchInspected: number;
  recentInspected: number;
  validated: number;
  stalePruned: number;
  failed: number;
  postId?: string;
  existingSource?: OnboardingExistingSource;
  lifecycleSource?: OnboardingLifecycleSource;
  creationStaggerMinutes?: number;
  eligibilitySubscriberCount?: number;
  errorMessage?: string;
};

export function isExpectedCompletedReplacement(
  state: OnboardingSubscriberGoalState | undefined,
  postId: string | undefined,
): boolean {
  return Boolean(
    state &&
    state.intent === "orphaned_completed_goal" &&
    state.replacementSourcePostId &&
    state.replacementSourcePostId === postId,
  );
}

export function getOnboardingEligibility(subreddit: {
  numberOfSubscribers: number;
  type?: unknown;
  nsfw?: unknown;
}): OnboardingEligibility {
  const automaticEligibility = getAutomaticGoalEligibility(subreddit);
  if (!(subreddit.numberOfSubscribers >= onboardingMinimumSubscriberCount)) {
    return {
      eligible: false,
      subscriberCount: subreddit.numberOfSubscribers,
      subredditType: automaticEligibility.subredditType,
      isSfw: automaticEligibility.isSfw,
      safetyStatus: automaticEligibility.safetyStatus,
      reason: "subscriber_count",
    };
  }
  if (!automaticEligibility.eligible) {
    return {
      eligible: false,
      subscriberCount: subreddit.numberOfSubscribers,
      subredditType: automaticEligibility.subredditType,
      isSfw: automaticEligibility.isSfw,
      safetyStatus: automaticEligibility.safetyStatus,
      reason: automaticEligibility.reason,
    };
  }
  return {
    eligible: true,
    subscriberCount: subreddit.numberOfSubscribers,
    subredditType: automaticEligibility.subredditType,
    isSfw: automaticEligibility.isSfw,
    safetyStatus: automaticEligibility.safetyStatus,
  };
}

export async function initializeOnboardingSubscriberGoal(
  redis: RedisClient,
  {
    lifecycleSource = "unknown",
    nowMs = Date.now(),
    migrationOnly = false,
    automationEnabled = AUTOMATIC_ONBOARDING_ENABLED,
  }: {
    lifecycleSource?: OnboardingLifecycleSource;
    nowMs?: number;
    migrationOnly?: boolean;
    automationEnabled?: boolean;
  },
): Promise<void> {
  if (!automationEnabled) {
    logGoalInitializationSkipped("automation_disabled", lifecycleSource);
    return;
  }
  const lockToken = await acquireRedisLock(
    redis,
    onboardingSubscriberGoalInitializationLockKey,
    onboardingSubscriberGoalInitializationLockTtlMs,
    { nowMs },
  );
  if (!lockToken) {
    logGoalInitializationSkipped("initialization_lock_busy", lifecycleSource);
    return;
  }
  try {
    const rawState = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    const existing = parseOnboardingState(rawState);
    if (existing) {
      logGoalInitializationSkipped(
        "existing_state_preserved",
        lifecycleSource,
        existing,
      );
      return;
    }
    // A non-empty state that cannot be parsed may represent partially written
    // legacy work. Fail closed instead of arming a second workflow over it.
    if (Object.keys(rawState).length > 0) {
      logDiagnostic("warn", "onboarding_goal_initialization_skipped", {
        workflow: "onboarding_subscriber_goal",
        phase: "initialize",
        lifecycleSource,
        reason: "unparseable_nonempty_state",
        rawFieldCount: Object.keys(rawState).length,
      });
      return;
    }
    const migration = await findPendingLegacyOnboardingWork(redis);
    if (migrationOnly && !migration) {
      logGoalInitializationSkipped(
        "migration_only_without_pending_work",
        lifecycleSource,
      );
      return;
    }
    const creationStaggerMinutes = selectOnboardingGoalStaggerMinutes();
    const armedAt = migration?.armedAt ?? nowMs;
    const state: OnboardingSubscriberGoalState = {
      version: onboardingSubscriberGoalVersion,
      status: migration?.reminderSentAt ? "pending" : "awaiting_warning",
      armedAt,
      lifecycleSource: migration?.lifecycleSource ?? lifecycleSource,
      creationStaggerMinutes,
      operationId:
        migration?.operationId ??
        `onboarding:${onboardingSubscriberGoalVersion}:${armedAt}`,
      ...(migration
        ? {
            migratedFromVersion: migration.version,
            legacyAttempts: migration.attempts,
          }
        : {}),
      ...(migration?.reminderSentAt
        ? {
            reminderSentAt: migration.reminderSentAt,
            nextRunAt:
              Math.max(
                nowMs,
                migration.reminderSentAt + onboardingGoalBaseDelayMs,
              ) +
              creationStaggerMinutes * 60 * 1000,
          }
        : {}),
      ...(migration?.deliveryUnknown
        ? {
            status: "complete" as const,
            completedAt: nowMs,
            resultStatus: "delivery_unknown" as const,
          }
        : {}),
    };
    await saveOnboardingState(redis, state);
    logDiagnostic("info", "onboarding_goal_initialized", {
      workflow: "onboarding_subscriber_goal",
      phase: "initialize",
      lifecycleSource: state.lifecycleSource,
      stateStatus: state.status,
      creationStaggerMinutes: state.creationStaggerMinutes,
      operationId: state.operationId,
      migratedFromVersion: state.migratedFromVersion ?? "none",
      version: state.version,
    });
  } finally {
    await releaseRedisLock(
      redis,
      onboardingSubscriberGoalInitializationLockKey,
      lockToken,
    );
  }
}

function logGoalInitializationSkipped(
  reason: string,
  lifecycleSource: OnboardingLifecycleSource,
  state?: OnboardingSubscriberGoalState,
): void {
  logDiagnostic("info", "onboarding_goal_initialization_skipped", {
    workflow: "onboarding_subscriber_goal",
    phase: "initialize",
    lifecycleSource,
    reason,
    goalState: state?.status ?? "none",
    goalResult: state?.resultStatus ?? "none",
    operationId: state?.operationId ?? "none",
    nextRunAt: state?.nextRunAt ?? "none",
    nextRunAtIso:
      state?.nextRunAt === undefined
        ? "none"
        : new Date(state.nextRunAt).toISOString(),
  });
}

export function selectOnboardingGoalStaggerMinutes(
  randomValue = Math.random(),
): number {
  const normalized = Math.min(Math.max(randomValue, 0), 1 - Number.EPSILON);
  return (
    Math.floor(
      normalized *
        (onboardingGoalStaggerMaxMinutes - onboardingGoalStaggerMinMinutes + 1),
    ) + onboardingGoalStaggerMinMinutes
  );
}

export async function getOnboardingSubscriberGoalState(
  redis: RedisClient,
): Promise<OnboardingSubscriberGoalState | undefined> {
  return parseOnboardingState(
    await redis.hGetAll(onboardingSubscriberGoalStateKey),
  );
}

export async function scheduleOnboardingSubscriberGoalAfterWarning(
  redis: RedisClient,
  sentAt: number,
): Promise<void> {
  let scheduledState: OnboardingSubscriberGoalState | undefined;
  await mutateGoalTerminalOrSchedule(redis, sentAt, (state) => {
    if (state.status !== "awaiting_warning") return state;
    const {
      startedAt: _startedAt,
      errorMessage: _errorMessage,
      ...rest
    } = state;
    scheduledState = {
      ...rest,
      status: "pending",
      reminderSentAt: sentAt,
      nextRunAt:
        sentAt +
        onboardingGoalBaseDelayMs +
        state.creationStaggerMinutes * 60 * 1000,
    };
    return scheduledState;
  });
  if (scheduledState) {
    logDiagnostic("info", "onboarding_goal_scheduled", {
      workflow: "onboarding_subscriber_goal",
      phase: "schedule_after_modmail",
      lifecycleSource: scheduledState.lifecycleSource,
      operationId: scheduledState.operationId,
      reminderSentAt: sentAt,
      baseDelayMs: onboardingGoalBaseDelayMs,
      creationStaggerMinutes: scheduledState.creationStaggerMinutes,
      nextRunAt: scheduledState.nextRunAt,
      nextRunAtIso: new Date(scheduledState.nextRunAt!).toISOString(),
    });
  }
}

export async function markOnboardingSubscriberGoalExisting(
  redis: RedisClient,
  postId: string,
  existingSource: OnboardingExistingSource,
  nowMs = Date.now(),
): Promise<void> {
  await mutateGoalTerminalOrSchedule(redis, nowMs, (state) => ({
    ...state,
    status: "complete",
    completedAt: nowMs,
    postId,
    existingSource,
    resultStatus: "existing",
  }));
}

export async function markOnboardingSubscriberGoalExistingNotHighlighted(
  redis: RedisClient,
  postId: string,
  existingSource: OnboardingExistingSource,
  nowMs = Date.now(),
  errorMessage?: string,
): Promise<void> {
  await mutateGoalTerminalOrSchedule(redis, nowMs, (state) => ({
    ...state,
    status: "complete",
    completedAt: nowMs,
    postId,
    existingSource,
    resultStatus: "existing_not_highlighted",
    ...(errorMessage ? { errorMessage } : {}),
  }));
}

export async function markOnboardingSubscriberGoalCompleted(
  redis: RedisClient,
  postId: string,
  existingSource: OnboardingExistingSource,
  resultStatus: CompletedGoalReconciliationOutcome,
  nowMs = Date.now(),
): Promise<void> {
  await mutateGoalTerminalOrSchedule(redis, nowMs, (state) => ({
    ...state,
    status: "complete",
    completedAt: nowMs,
    postId,
    existingSource,
    resultStatus,
  }));
}

export async function markOnboardingSubscriberGoalIneligible(
  redis: RedisClient,
  subscriberCount: number,
  nowMs = Date.now(),
  reason?: OnboardingIneligibilityReason,
): Promise<void> {
  let completedState: OnboardingSubscriberGoalState | undefined;
  await mutateGoalTerminalOrSchedule(redis, nowMs, (state) => {
    completedState = state;
    return {
      ...state,
      status: "complete",
      completedAt: nowMs,
      resultStatus: "ineligible",
      eligibilitySubscriberCount: subscriberCount,
      ...(reason ? { ineligibilityReason: reason } : {}),
    };
  });
  if (!completedState) return;
  console.info(
    `[onboardingSubscriberGoal] complete: status=ineligible subscriberCount=${subscriberCount} minimumSubscriberCount=${onboardingMinimumSubscriberCount} source=${completedState.lifecycleSource} creationStaggerMinutes=${completedState.creationStaggerMinutes}`,
  );
}

export async function markOnboardingSubscriberGoalCancelled(
  redis: RedisClient,
  resultStatus: "cancelled_permission" | "delivery_unknown",
  nowMs = Date.now(),
  errorMessage?: string,
): Promise<void> {
  await mutateGoalTerminalOrSchedule(redis, nowMs, (state) => ({
    ...state,
    status: "complete",
    completedAt: nowMs,
    resultStatus,
    ...(errorMessage ? { errorMessage } : {}),
  }));
}

export async function processDueOnboardingSubscriberGoal({
  reddit,
  redis,
  appSettings,
  nowMs = Date.now(),
  automationEnabled = AUTOMATIC_ONBOARDING_ENABLED,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  nowMs?: number;
  automationEnabled?: boolean;
}): Promise<OnboardingSubscriberGoalSummary> {
  try {
    return await withCommunityGoalMutationLease(redis, (mutationLease) =>
      processDueOnboardingSubscriberGoalUnderLease({
        reddit,
        redis,
        appSettings,
        nowMs,
        automationEnabled,
        mutationLease,
      }),
    );
  } catch (error) {
    if (error instanceof CommunityGoalMutationInProgressError) {
      return { status: "not_due", ...emptySummary() };
    }
    throw error;
  }
}

async function processDueOnboardingSubscriberGoalUnderLease({
  reddit,
  redis,
  appSettings,
  nowMs = Date.now(),
  automationEnabled = AUTOMATIC_ONBOARDING_ENABLED,
  mutationLease,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  nowMs?: number;
  automationEnabled?: boolean;
  mutationLease: CommunityGoalMutationLease;
}): Promise<OnboardingSubscriberGoalSummary> {
  const base = emptySummary();
  let inspected = base;
  await initializeOnboardingSubscriberGoal(redis, {
    nowMs,
    lifecycleSource: "recovery",
    automationEnabled,
  });
  let state = await getOnboardingSubscriberGoalState(redis);
  if (!state) {
    return { status: "not_due", ...base };
  }
  if (state.status === "complete") {
    return {
      status: "complete",
      ...base,
      ...(state.postId ? { postId: state.postId } : {}),
      lifecycleSource: state.lifecycleSource,
      ...(state.existingSource ? { existingSource: state.existingSource } : {}),
      ...(state.errorMessage ? { errorMessage: state.errorMessage } : {}),
      creationStaggerMinutes: state.creationStaggerMinutes,
      ...(state.eligibilitySubscriberCount !== undefined
        ? { eligibilitySubscriberCount: state.eligibilitySubscriberCount }
        : {}),
    };
  }
  if (!automationEnabled) {
    await saveOnboardingState(redis, {
      ...state,
      pausedAt: state.pausedAt ?? nowMs,
    });
    return { status: "paused", ...base };
  }
  if (state.pausedAt !== undefined) {
    const resumeAt = nowMs + selectOnboardingGoalStaggerMinutes() * 60 * 1000;
    const { pausedAt: _pausedAt, ...unpausedState } = state;
    state = {
      ...unpausedState,
      ...(state.status === "pending" || state.status === "processing"
        ? {
            status: "pending" as const,
            nextRunAt: Math.max(state.nextRunAt ?? 0, resumeAt),
          }
        : {}),
    };
    await saveOnboardingState(redis, state);
    return { status: "not_due", ...base };
  }
  if (
    state.status === "awaiting_warning" ||
    state.nextRunAt === undefined ||
    nowMs < state.nextRunAt
  ) {
    return { status: "not_due", ...base };
  }

  const lockToken = await acquireRedisLock(
    redis,
    onboardingSubscriberGoalLockKey,
    onboardingSubscriberGoalLockTtlMs,
    { nowMs },
  );
  if (!lockToken) {
    return { status: "not_due", ...base };
  }

  let creationAttempted = false;
  let creationFinished = false;
  let activeState = state;
  let notificationLanguage: unknown;
  const deferPrerequisite = async (errorMessage?: string): Promise<boolean> => {
    const retry = await nextAutomaticGoalPrerequisiteRetry(
      redis,
      activeState.operationId,
      nowMs,
    );
    await saveOnboardingState(redis, {
      ...activeState,
      status: retry.retryAt === null ? "complete" : "pending",
      ...(retry.retryAt === null
        ? { completedAt: nowMs, resultStatus: "retry_exhausted" as const }
        : { nextRunAt: retry.retryAt }),
      ...(errorMessage ? { errorMessage } : {}),
    });
    if (retry.retryAt === null)
      await notifyAutomaticGoalExhausted({
        reddit,
        redis,
        operationId: activeState.operationId,
        unresolved: false,
        language: notificationLanguage,
      });
    return retry.retryAt === null;
  };
  try {
    const reloaded = parseOnboardingState(
      await redis.hGetAll(onboardingSubscriberGoalStateKey),
    );
    if (!reloaded || reloaded.status === "complete") {
      return { status: "complete", ...base };
    }
    if (
      reloaded.status === "awaiting_warning" ||
      reloaded.nextRunAt === undefined ||
      nowMs < reloaded.nextRunAt
    ) {
      return { status: "not_due", ...base };
    }
    activeState = reloaded;
    const reconcilingSubmission =
      reloaded.resultStatus === "submission_reconciliation_pending";
    console.info(
      `[onboardingSubscriberGoal] starting check: source=${reloaded.lifecycleSource} nextRunAt=${reloaded.nextRunAt} creationStaggerMinutes=${reloaded.creationStaggerMinutes} operationId=${reloaded.operationId} status=${reloaded.status}`,
    );
    await saveOnboardingState(redis, {
      ...reloaded,
      status: "processing",
      startedAt: nowMs,
    });

    if (!automationEnabled) {
      await saveOnboardingState(redis, {
        ...reloaded,
        status: "pending",
        pausedAt: nowMs,
      });
      return { status: "paused", ...base };
    }

    let subreddit = await reddit.getCurrentSubreddit();
    notificationLanguage = subreddit.language;
    const eligibility = getOnboardingEligibility(subreddit);
    logDiagnostic("info", "onboarding_eligibility_checked", {
      workflow: "onboarding_subscriber_goal",
      phase: "eligibility",
      lifecycleSource: reloaded.lifecycleSource,
      operationId: reloaded.operationId,
      subscriberCount: eligibility.subscriberCount,
      minimumSubscriberCount: onboardingMinimumSubscriberCount,
      subredditType: eligibility.subredditType,
      isSfw: eligibility.isSfw,
      safetyStatus: eligibility.safetyStatus,
      eligible: eligibility.eligible,
      reason: eligibility.reason ?? "none",
    });
    if (!eligibility.eligible) {
      if (
        eligibility.reason !== "subscriber_count" &&
        isAutomaticGoalEligibilityUncertain(eligibility)
      ) {
        const exhausted = await deferPrerequisite();
        return { status: exhausted ? "complete" : "failed", ...inspected };
      }
      await saveOnboardingState(redis, {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        resultStatus: "ineligible",
        eligibilitySubscriberCount: eligibility.subscriberCount,
        ...(eligibility.reason
          ? { ineligibilityReason: eligibility.reason }
          : {}),
      });
      return {
        status: "ineligible",
        lifecycleSource: reloaded.lifecycleSource,
        creationStaggerMinutes: reloaded.creationStaggerMinutes,
        eligibilitySubscriberCount: eligibility.subscriberCount,
        ...inspected,
      };
    }

    const health = await checkAppAccountHealth({
      reddit,
      redis,
      subredditName: subreddit.name,
      subredditId: subreddit.id,
      language: subreddit.language,
      notify: false,
      scheduleUnknownRetry: false,
      nowMs,
    });
    if (!health.healthy || health.status !== "healthy") {
      const exhausted = await deferPrerequisite(
        "Subscriber Goal lacks verified Manage Posts permission.",
      );
      return { status: exhausted ? "complete" : "failed", ...inspected };
    }

    const existing = reconcilingSubmission
      ? emptyHighlightEnsuranceResult()
      : await ensureExistingSubscriberGoalHighlighted({
          reddit,
          redis,
          nowMs,
          notifyOnFailure: true,
          mutationLease,
          reconciliationContext: "onboarding",
        });
    inspected = {
      registeredInspected: existing.registeredInspected,
      trackedInspected: existing.trackedInspected,
      queuedInspected: existing.queuedInspected,
      persistedInspected: existing.persistedInspected,
      highlightedInspected: existing.highlightedInspected,
      searchInspected: existing.searchInspected,
      recentInspected: existing.recentInspected,
      validated: existing.validated,
      stalePruned: existing.stalePruned,
      failed: existing.failed,
    };
    if (
      existing.status === "completed" &&
      existing.postId &&
      existing.source &&
      reloaded.intent === "orphaned_completed_goal" &&
      !isExpectedCompletedReplacement(reloaded, existing.postId)
    ) {
      await saveOnboardingState(redis, {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        postId: existing.postId,
        existingSource: existing.source,
        resultStatus: "completed_no_recovery",
      });
      return {
        status: "existing",
        postId: existing.postId,
        existingSource: existing.source,
        lifecycleSource: reloaded.lifecycleSource,
        ...inspected,
      };
    }
    if (
      existing.status === "completed" &&
      existing.postId &&
      existing.source &&
      existing.completedTime &&
      !isExpectedCompletedReplacement(reloaded, existing.postId)
    ) {
      const completed = await reconcileCompletedGoal({
        reddit,
        redis,
        appSettings,
        lifecycleSource: reloaded.lifecycleSource,
        sourcePostId: existing.postId,
        completedTime: existing.completedTime,
        autoCreateNextGoal: existing.autoCreateNextGoal ?? false,
        nowMs,
        mutationLease,
      });
      const terminalPostId = completed.successorPostId ?? existing.postId;
      await saveOnboardingState(redis, {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        postId: terminalPostId,
        existingSource: existing.source,
        resultStatus: completed.outcome,
      });
      return {
        status: "existing",
        postId: terminalPostId,
        existingSource: existing.source,
        lifecycleSource: reloaded.lifecycleSource,
        ...inspected,
      };
    }
    if (
      existing.status !== "missing" &&
      existing.postId &&
      !isExpectedCompletedReplacement(reloaded, existing.postId)
    ) {
      await saveOnboardingState(redis, {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        postId: existing.postId,
        existingSource: existing.source!,
        resultStatus:
          existing.status === "existing"
            ? "existing"
            : "existing_not_highlighted",
        ...(existing.errorMessage
          ? { errorMessage: existing.errorMessage }
          : {}),
      });
      console.info(
        `[onboardingSubscriberGoal] complete: status=${existing.status} existingSource=${existing.source} postId=${existing.postId} source=${reloaded.lifecycleSource} creationStaggerMinutes=${reloaded.creationStaggerMinutes} ${formatDetectionDiagnostics(inspected)}`,
      );
      return {
        status: "existing",
        postId: existing.postId,
        existingSource: existing.source!,
        lifecycleSource: reloaded.lifecycleSource,
        ...inspected,
      };
    }

    if (!automationEnabled) {
      await saveOnboardingState(redis, {
        ...reloaded,
        status: "pending",
        pausedAt: nowMs,
      });
      return { status: "paused", ...inspected };
    }

    subreddit = await reddit.getCurrentSubreddit();
    const creationEligibility = getOnboardingEligibility(subreddit);
    if (!creationEligibility.eligible) {
      if (
        creationEligibility.reason !== "subscriber_count" &&
        isAutomaticGoalEligibilityUncertain(creationEligibility)
      ) {
        const exhausted = await deferPrerequisite();
        return { status: exhausted ? "complete" : "failed", ...inspected };
      }
      await saveOnboardingState(redis, {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        resultStatus: "ineligible",
        eligibilitySubscriberCount: creationEligibility.subscriberCount,
        ...(creationEligibility.reason
          ? { ineligibilityReason: creationEligibility.reason }
          : {}),
      });
      logDiagnostic("info", "onboarding_eligibility_checked", {
        workflow: "onboarding_subscriber_goal",
        phase: "pre_create_eligibility",
        lifecycleSource: reloaded.lifecycleSource,
        operationId: reloaded.operationId,
        subscriberCount: creationEligibility.subscriberCount,
        minimumSubscriberCount: onboardingMinimumSubscriberCount,
        subredditType: creationEligibility.subredditType,
        isSfw: creationEligibility.isSfw,
        safetyStatus: creationEligibility.safetyStatus,
        eligible: false,
        reason: creationEligibility.reason ?? "none",
      });
      return {
        status: "ineligible",
        lifecycleSource: reloaded.lifecycleSource,
        creationStaggerMinutes: reloaded.creationStaggerMinutes,
        eligibilitySubscriberCount: creationEligibility.subscriberCount,
        ...inspected,
      };
    }

    const finalExisting = reconcilingSubmission
      ? emptyHighlightEnsuranceResult()
      : await ensureExistingSubscriberGoalHighlighted({
          reddit,
          redis,
          nowMs,
          notifyOnFailure: true,
          mutationLease,
          reconciliationContext: "onboarding",
        });
    inspected = {
      registeredInspected: finalExisting.registeredInspected,
      trackedInspected: finalExisting.trackedInspected,
      queuedInspected: finalExisting.queuedInspected,
      persistedInspected: finalExisting.persistedInspected,
      highlightedInspected: finalExisting.highlightedInspected,
      searchInspected: finalExisting.searchInspected,
      recentInspected: finalExisting.recentInspected,
      validated: finalExisting.validated,
      stalePruned: finalExisting.stalePruned,
      failed: finalExisting.failed,
    };
    if (
      finalExisting.status === "completed" &&
      finalExisting.postId &&
      finalExisting.source &&
      reloaded.intent === "orphaned_completed_goal" &&
      !isExpectedCompletedReplacement(reloaded, finalExisting.postId)
    ) {
      await saveOnboardingState(redis, {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        postId: finalExisting.postId,
        existingSource: finalExisting.source,
        resultStatus: "completed_no_recovery",
      });
      return {
        status: "existing",
        postId: finalExisting.postId,
        existingSource: finalExisting.source,
        lifecycleSource: reloaded.lifecycleSource,
        ...inspected,
      };
    }
    if (
      finalExisting.status === "completed" &&
      finalExisting.postId &&
      finalExisting.source &&
      finalExisting.completedTime &&
      !isExpectedCompletedReplacement(reloaded, finalExisting.postId)
    ) {
      const completed = await reconcileCompletedGoal({
        reddit,
        redis,
        appSettings,
        lifecycleSource: reloaded.lifecycleSource,
        sourcePostId: finalExisting.postId,
        completedTime: finalExisting.completedTime,
        autoCreateNextGoal: finalExisting.autoCreateNextGoal ?? false,
        nowMs,
        mutationLease,
      });
      const terminalPostId = completed.successorPostId ?? finalExisting.postId;
      await saveOnboardingState(redis, {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        postId: terminalPostId,
        existingSource: finalExisting.source,
        resultStatus: completed.outcome,
      });
      return {
        status: "existing",
        postId: terminalPostId,
        existingSource: finalExisting.source,
        lifecycleSource: reloaded.lifecycleSource,
        ...inspected,
      };
    }
    if (
      finalExisting.status !== "missing" &&
      finalExisting.postId &&
      !isExpectedCompletedReplacement(reloaded, finalExisting.postId)
    ) {
      await saveOnboardingState(redis, {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        postId: finalExisting.postId,
        existingSource: finalExisting.source!,
        resultStatus:
          finalExisting.status === "existing"
            ? "existing"
            : "existing_not_highlighted",
        ...(finalExisting.errorMessage
          ? { errorMessage: finalExisting.errorMessage }
          : {}),
      });
      logDiagnostic("info", "onboarding_goal_creation_suppressed", {
        workflow: "onboarding_subscriber_goal",
        phase: "pre_create_duplicate_check",
        lifecycleSource: reloaded.lifecycleSource,
        operationId: reloaded.operationId,
        postId: finalExisting.postId,
        existingSource: finalExisting.source!,
        isHighlighted: finalExisting.selectedWasAlreadyHighlighted ?? false,
      });
      return {
        status: "existing",
        postId: finalExisting.postId,
        existingSource: finalExisting.source!,
        lifecycleSource: reloaded.lifecycleSource,
        ...inspected,
      };
    }

    const crosspost = isCrosspostEligible(subreddit, appSettings.promoSubreddit);
    const useTinyPost =
      subreddit.numberOfSubscribers > onboardingTinySubscriberThreshold;
    const language = resolveSubGoalLanguage(subreddit.language);
    const messages = getSubGoalPostMessages(language);
    const afterSubscribePreset = getDefaultAfterSubscribePreset(
      subreddit.type,
      isNsfwOrUnknown(subreddit.nsfw),
    );
    logDiagnostic("info", "onboarding_goal_creation_started", {
      workflow: "onboarding_subscriber_goal",
      phase: "post_creation",
      lifecycleSource: reloaded.lifecycleSource,
      operationId: reloaded.operationId,
      scheduledRunAt: reloaded.nextRunAt,
      startedAt: nowMs,
      startedAtIso: new Date(nowMs).toISOString(),
    });
    creationAttempted = true;
    const creation = await createSubscriberGoal({
      reddit,
      redis,
      appSettings,
      options: {
        title: messages.defaultPostTitle({ subredditName: subreddit.name }),
        ...(useTinyPost
          ? {}
          : { goal: getDefaultSubscriberGoal(subreddit.numberOfSubscribers) }),
        subredditDisplayName: subreddit.name,
        crosspost,
        colorTheme: "red",
        postHeight: useTinyPost ? "tiny" : "regular",
        autoCreateNextGoal: !useTinyPost,
        language,
        afterSubscribeAction:
          afterSubscribePreset === "newest-post"
            ? {
                type: "newest-post",
                buttonText: getAfterSubscribePresetMessages(language)
                  .viewMostRecentPostToday,
                colorTheme: defaultAfterSubscribeColorTheme,
              }
            : createDefaultAfterSubscribeAction({
                language,
                subredditName: subreddit.name,
                subredditType: subreddit.type,
              }),
        afterSubscribePreset,
        operationId: reloaded.operationId,
        automaticPermissionCheck: true,
        reconciliationContext: "onboarding",
        mutationLease,
        reconciliationNowMs: nowMs,
      },
    });
    creationFinished = true;
    await resetAutomaticGoalPrerequisiteRetry(redis, reloaded.operationId);
    if (creation.outcome === "superseded" || creation.outcome === "retired") {
      const resolvedPostId = creation.supersedingPostId ?? creation.post.id;
      await saveOnboardingState(redis, {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        postId: resolvedPostId,
        resultStatus: "existing",
      });
      logDiagnostic("info", "onboarding_goal_recovery_stopped", {
        workflow: "onboarding_subscriber_goal",
        phase: "creation_recovery",
        operationId: reloaded.operationId,
        postId: creation.post.id,
        outcome: creation.outcome,
        supersedingPostId: creation.supersedingPostId ?? "none",
      });
      return {
        status: "complete",
        postId: resolvedPostId,
        lifecycleSource: reloaded.lifecycleSource,
        ...inspected,
      };
    }
    const { post, highlightResult } = creation;
    if (reloaded.replacementSourcePostId) {
      await redis.hSet(autoCreateNextGoalSuccessorsKey, {
        [reloaded.replacementSourcePostId]: post.id,
      });
      await cancelAutoCreateNextGoal(redis, reloaded.replacementSourcePostId);
    }
    if (highlightResult.issues.length > 0) {
      try {
        await notifyHighlightFailureIncident({
          reddit,
          redis,
          postId: post.id,
          result: highlightResult,
          subredditId: subreddit.id,
          subredditName: subreddit.name,
          postTitle: post.title,
          postUrl: getPostUrl(post),
          errorMessage: highlightResult.errorMessage,
          highlightResult,
          language,
        });
      } catch (notificationError) {
        logDiagnostic(
          "warn",
          "onboarding_goal_notification_failed",
          {
            workflow: "onboarding_subscriber_goal",
            phase: "highlight_notification",
            postId: post.id,
          },
          notificationError,
        );
      }
    } else {
      await clearHighlightFailureIncident(redis, post.id);
    }
    await saveOnboardingState(redis, {
      ...reloaded,
      status: "complete",
      completedAt: nowMs,
      postId: post.id,
      resultStatus:
        highlightResult.status === "highlighted"
          ? "created"
          : "created_not_highlighted",
    });
    logDiagnostic("info", "onboarding_goal_created", {
      workflow: "onboarding_subscriber_goal",
      phase: "complete",
      lifecycleSource: reloaded.lifecycleSource,
      operationId: reloaded.operationId,
      postId: post.id,
      highlightStatus: highlightResult.status,
      completedAt: nowMs,
      completedAtIso: new Date(nowMs).toISOString(),
    });
    console.info(
      `[onboardingSubscriberGoal] complete: status=created postId=${post.id} source=${reloaded.lifecycleSource} creationStaggerMinutes=${reloaded.creationStaggerMinutes} ${formatDetectionDiagnostics(inspected)}`,
    );
    return {
      status: "created",
      postId: post.id,
      lifecycleSource: activeState.lifecycleSource,
      ...inspected,
    };
  } catch (error) {
    inspected = getDetectionDiagnosticsFromError(error) ?? inspected;
    const errorMessage = String(error);
    if (error instanceof PostTemporarilyUnavailableError) {
      await saveOnboardingState(redis, {
        ...activeState,
        status: "pending",
        nextRunAt: nowMs + temporarilyRemovedPostRecheckDelayMs,
        errorMessage,
      });
      logDiagnostic("info", "onboarding_goal_post_paused", {
        workflow: "onboarding_subscriber_goal",
        phase: "post_availability",
        operationId: activeState.operationId,
        postId: error.postId,
        category: error.category ?? "unknown",
      });
      return { status: "failed", errorMessage, ...inspected };
    }
    if (error instanceof SubscriberGoalCreationOutcomeUnknownError) {
      const pending =
        error.reconciliationStatus === "pending" &&
        error.reconciliationNextAt !== undefined;
      await saveOnboardingState(redis, {
        ...activeState,
        status: pending ? "pending" : "complete",
        ...(pending
          ? { nextRunAt: error.reconciliationNextAt }
          : { completedAt: nowMs }),
        resultStatus: pending
          ? "submission_reconciliation_pending"
          : "submission_reconciliation_exhausted",
        errorMessage,
      });
      if (!pending)
        await notifyAutomaticGoalExhausted({
          reddit,
          redis,
          operationId: activeState.operationId,
          unresolved: true,
          language: notificationLanguage,
        });
      logDiagnostic(
        pending ? "warn" : "error",
        "onboarding_goal_submission_unresolved",
        {
          workflow: "onboarding_subscriber_goal",
          phase: "submission_reconciliation",
          lifecycleSource: activeState.lifecycleSource,
          operationId: activeState.operationId,
          reconciliationStatus: error.reconciliationStatus,
          reconciliationAttempts: error.reconciliationAttempts,
          reconciliationNextAt: error.reconciliationNextAt ?? "none",
        },
        error,
      );
      return {
        status: pending ? "failed" : "complete",
        errorMessage,
        lifecycleSource: activeState.lifecycleSource,
        ...inspected,
      };
    }
    try {
      if (
        !creationAttempted ||
        creationFinished ||
        isAutomaticGoalPrerequisiteError(error)
      ) {
        const exhausted = await deferPrerequisite(errorMessage);
        logDiagnostic(
          exhausted ? "error" : "warn",
          exhausted
            ? "onboarding_goal_prerequisites_exhausted"
            : "onboarding_prerequisite_retry_scheduled",
          {
            workflow: "onboarding_subscriber_goal",
            phase: "prerequisite",
            operationId: activeState.operationId,
          },
          error,
        );
        return {
          status: exhausted ? "complete" : "failed",
          errorMessage,
          ...inspected,
        };
      }
      const attempts = (activeState.attempts ?? 0) + 1;
      const terminal =
        attempts >= onboardingMaxAttempts || isPermanentOnboardingError(error);
      const retryDelayMs = selectOnboardingRetryDelayMs(attempts);
      await saveOnboardingState(redis, {
        ...activeState,
        status: terminal ? "complete" : "pending",
        ...(terminal
          ? { completedAt: nowMs }
          : { nextRunAt: nowMs + retryDelayMs }),
        attempts,
        resultStatus: terminal ? "retry_exhausted" : "failed",
        errorMessage,
      });
      if (terminal)
        await notifyAutomaticGoalExhausted({
          reddit,
          redis,
          operationId: activeState.operationId,
          unresolved: false,
          language: notificationLanguage,
        });
      if (!terminal)
        logDiagnostic(
          "warn",
          "onboarding_goal_retry_scheduled",
          {
            workflow: "onboarding_subscriber_goal",
            phase: "retry",
            lifecycleSource: activeState.lifecycleSource,
            creationStaggerMinutes: activeState.creationStaggerMinutes,
            attempts,
            nextRunAt: nowMs + retryDelayMs,
          },
          error,
        );
    } catch (stateError) {
      logDiagnostic(
        "error",
        "onboarding_goal_failed",
        {
          workflow: "onboarding_subscriber_goal",
          phase: "failure_persistence",
        },
        stateError,
      );
    }
    logDiagnostic(
      "error",
      "onboarding_goal_failed",
      {
        workflow: "onboarding_subscriber_goal",
        phase: "execution",
        lifecycleSource: activeState.lifecycleSource,
        creationStaggerMinutes: activeState.creationStaggerMinutes,
      },
      error,
    );
    return {
      status: "failed",
      errorMessage,
      lifecycleSource: activeState.lifecycleSource,
      ...inspected,
    };
  } finally {
    await releaseRedisLock(redis, onboardingSubscriberGoalLockKey, lockToken);
  }
}

function parseOnboardingState(
  raw: Record<string, string>,
): OnboardingSubscriberGoalState | undefined {
  const status = raw.status;
  const lifecycleSource = raw.lifecycleSource;
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
    lifecycleSource:
      lifecycleSource === "install" ||
      lifecycleSource === "upgrade" ||
      lifecycleSource === "recovery"
        ? lifecycleSource
        : "unknown",
  };
  if (nextRunAt !== undefined) state.nextRunAt = nextRunAt;
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
  if (
    raw.existingSource === "registered" ||
    raw.existingSource === "tracked" ||
    raw.existingSource === "queued" ||
    raw.existingSource === "persisted" ||
    raw.existingSource === "highlighted" ||
    raw.existingSource === "search" ||
    raw.existingSource === "recent"
  ) {
    state.existingSource = raw.existingSource;
  } else if (raw.existingSource === "pinned") {
    state.existingSource = "highlighted";
  }
  return state;
}

function parseStateNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function serializeOnboardingState(
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

export async function saveOnboardingState(
  redis: RedisClient,
  state: OnboardingSubscriberGoalState,
): Promise<void> {
  await redis.hSet(
    onboardingSubscriberGoalStateKey,
    serializeOnboardingState(state),
  );
  if (state.status === "complete")
    await resetAutomaticGoalPrerequisiteRetry(redis, state.operationId);
}

function isOnboardingIneligibilityReason(
  value: string | undefined,
): value is OnboardingIneligibilityReason {
  return (
    value === "subscriber_count" ||
    value === "subreddit_not_public" ||
    value === "subreddit_not_sfw"
  );
}

type LegacyMigration = {
  version: string;
  armedAt: number;
  lifecycleSource: OnboardingLifecycleSource;
  attempts: number;
  operationId?: string;
  reminderSentAt?: number;
  deliveryUnknown?: boolean;
};

async function findPendingLegacyOnboardingWork(
  redis: RedisClient,
): Promise<LegacyMigration | undefined> {
  let hasTerminalLegacyGoal = false;
  for (const candidate of [
    {
      key: "onboarding_subscriber_goal_v3_state",
      version: "onboarding_subscriber_goal_v3",
      operationId: (armedAt: number) =>
        `onboarding:onboarding_subscriber_goal_v3:${armedAt}`,
    },
    {
      key: "onboarding_subscriber_goal_v2_state",
      version: "onboarding_subscriber_goal_v2",
      operationId: (armedAt: number) => `onboarding:${armedAt}`,
    },
  ]) {
    const raw = await redis.hGetAll(candidate.key);
    if (raw.status === "complete") hasTerminalLegacyGoal = true;
    if (raw.status !== "pending" && raw.status !== "processing") continue;
    const armedAt = parseStateNumber(raw.armedAt);
    if (armedAt === undefined) continue;
    const reminder = await findLegacyReminderDisposition(redis);
    return {
      version: candidate.version,
      armedAt,
      lifecycleSource: parseLifecycleSource(raw.lifecycleSource),
      attempts: parseStateNumber(raw.attempts) ?? 0,
      operationId: candidate.operationId(armedAt),
      ...(reminder.sentAt ? { reminderSentAt: reminder.sentAt } : {}),
      ...(raw.status === "processing" || reminder.deliveryUnknown
        ? { deliveryUnknown: true }
        : {}),
    };
  }

  const legacyV1 = await redis.get("onboarding_subscriber_goal_v1");
  if (legacyV1) {
    try {
      const raw = JSON.parse(legacyV1) as Record<string, unknown>;
      if (raw.status === "pending" || raw.status === "processing") {
        const armedAt = Number(raw.armedAt);
        if (Number.isFinite(armedAt)) {
          const reminder = await findLegacyReminderDisposition(redis);
          return {
            version: "onboarding_subscriber_goal_v1",
            armedAt,
            lifecycleSource: parseLifecycleSource(raw.lifecycleSource),
            attempts: Number.isFinite(Number(raw.attempts))
              ? Number(raw.attempts)
              : 0,
            operationId: `onboarding:onboarding_subscriber_goal_v1:${armedAt}`,
            ...(reminder.sentAt ? { reminderSentAt: reminder.sentAt } : {}),
            ...(raw.status === "processing" || reminder.deliveryUnknown
              ? { deliveryUnknown: true }
              : {}),
          };
        }
      }
      if (
        raw.status === "created" ||
        raw.status === "existing" ||
        raw.status === "failed"
      ) {
        hasTerminalLegacyGoal = true;
      }
    } catch (error) {
      logDiagnostic(
        "warn",
        "onboarding_legacy_state_invalid",
        {
          workflow: "onboarding_subscriber_goal",
          phase: "legacy_v1_parse",
        },
        error,
      );
    }
  }

  if (hasTerminalLegacyGoal) return undefined;

  for (const candidate of [
    ["onboarding_reminder_v2_state", "onboarding_reminder_v2"],
    ["onboarding_reminder_v1_state", "onboarding_reminder_v1"],
  ] as const) {
    const raw = await redis.hGetAll(candidate[0]);
    if (raw.status !== "pending" && raw.status !== "processing") continue;
    const armedAt = parseStateNumber(raw.armedAt);
    if (armedAt === undefined) continue;
    return {
      version: candidate[1],
      armedAt,
      lifecycleSource: parseLifecycleSource(raw.lifecycleSource),
      attempts: parseStateNumber(raw.attempts) ?? 0,
      ...(raw.status === "processing" ? { deliveryUnknown: true } : {}),
    };
  }
  return undefined;
}

function parseLifecycleSource(value: unknown): OnboardingLifecycleSource {
  return value === "install" || value === "upgrade" || value === "recovery"
    ? value
    : "unknown";
}

async function findLegacyReminderDisposition(redis: RedisClient): Promise<{
  sentAt?: number;
  deliveryUnknown?: boolean;
}> {
  for (const key of [
    "onboarding_reminder_v2_state",
    "onboarding_reminder_v1_state",
  ]) {
    const raw = await redis.hGetAll(key);
    if (raw.status === "complete" && raw.result === "sent") {
      const sentAt =
        parseStateNumber(raw.sentAt) ??
        parseStateNumber(raw.completedAt) ??
        parseStateNumber(raw.armedAt);
      return sentAt === undefined ? {} : { sentAt };
    }
    if (
      raw.status === "processing" ||
      (raw.status === "complete" && raw.result === "failed")
    ) {
      return { deliveryUnknown: true };
    }
  }
  return {};
}

export function selectOnboardingRetryDelayMs(
  attempts: number,
  randomValue = Math.random(),
): number {
  const cap = Math.min(
    onboardingRetryMaxMs,
    onboardingRetryBaseMs * 2 ** Math.max(0, attempts - 1),
  );
  const normalized = Math.min(Math.max(randomValue, 0), 1 - Number.EPSILON);
  return Math.floor(
    onboardingRetryBaseMs + normalized * (cap - onboardingRetryBaseMs + 1),
  );
}

function isPermanentOnboardingError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "ProhibitedSubredditError";
}

async function mutateGoalTerminalOrSchedule(
  redis: RedisClient,
  nowMs: number,
  mutate: (
    state: OnboardingSubscriberGoalState,
  ) => OnboardingSubscriberGoalState,
): Promise<void> {
  const lockToken = await acquireRedisLock(
    redis,
    onboardingSubscriberGoalLockKey,
    onboardingSubscriberGoalLockTtlMs,
    { nowMs },
  );
  if (!lockToken) {
    throw new Error("Onboarding goal state is currently locked");
  }
  try {
    const state = await getOnboardingSubscriberGoalState(redis);
    if (!state || state.status === "complete") return;
    await saveOnboardingState(redis, mutate(state));
  } finally {
    await releaseRedisLock(redis, onboardingSubscriberGoalLockKey, lockToken);
  }
}
