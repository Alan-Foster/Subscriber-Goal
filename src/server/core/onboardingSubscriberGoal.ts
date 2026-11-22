import {
  getOnboardingEligibility,
  type OnboardingEligibility,
  type OnboardingIneligibilityReason,
} from "./onboardingEligibility";
export {
  getOnboardingEligibility,
  type OnboardingEligibility,
  type OnboardingIneligibilityReason,
} from "./onboardingEligibility";
import {
  parseOnboardingState,
  serializeOnboardingState,
} from "./onboardingGoalState";
import {
  findPendingLegacyOnboardingWork,
  parseStateNumber,
  type LegacyMigration,
} from "./onboardingLegacyState";
import {
  hasOnboardingGoalFields,
  migrateOnboardingWarning,
  onboardingWarningFields,
  onboardingSubscriberGoalStateKey,
  onboardingSubscriberGoalVersion,
  onboardingSubscriberGoalLockKey,
  onboardingSubscriberGoalLockTtlMs,
  readOnboardingWarningFields,
} from "./onboardingState";
export {
  onboardingSubscriberGoalVersion,
  onboardingSubscriberGoalStateKey,
  onboardingSubscriberGoalLockKey,
  onboardingSubscriberGoalLockTtlMs,
} from "./onboardingState";
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
import { isAutomaticGoalEligibilityUncertain } from "./automaticGoalEligibility";
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
  type OnboardingDetectionDiagnostics,
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

/** Checked at every onboarding side-effect boundary so a hotfix can pause armed work. */
export const AUTOMATIC_ONBOARDING_ENABLED = true;

export const onboardingUpgradeWaveEnabled = AUTOMATIC_ONBOARDING_ENABLED;

export const onboardingTinySubscriberThreshold = 1_000_000;

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

export async function initializeOnboardingSubscriberGoal(
  redis: RedisClient,
  {
    lifecycleSource = "unknown",
    nowMs = Date.now(),
    migrationOnly = false,
    automationEnabled = AUTOMATIC_ONBOARDING_ENABLED,
    workflowLockHeld = false,
  }: {
    lifecycleSource?: OnboardingLifecycleSource;
    nowMs?: number;
    migrationOnly?: boolean;
    automationEnabled?: boolean;
    workflowLockHeld?: boolean;
  },
): Promise<void> {
  if (!automationEnabled) {
    logGoalInitializationSkipped("automation_disabled", lifecycleSource);
    return;
  }
  const lockToken = workflowLockHeld
    ? undefined
    : await acquireRedisLock(
        redis,
        onboardingSubscriberGoalLockKey,
        onboardingSubscriberGoalLockTtlMs,
        { nowMs },
      );
  if (!workflowLockHeld && !lockToken) {
    logGoalInitializationSkipped("initialization_lock_busy", lifecycleSource);
    return;
  }
  try {
    if (!(await migrateOnboardingWarning(redis, nowMs))) return;
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
    if (hasOnboardingGoalFields(rawState)) {
      logDiagnostic("warn", "onboarding_goal_initialization_skipped", {
        workflow: "onboarding_subscriber_goal",
        phase: "initialize",
        lifecycleSource,
        reason: "unparseable_nonempty_state",
        rawFieldCount: Object.keys(rawState).length,
      });
      return;
    }
    const warning = await readOnboardingWarningFields(redis, rawState);
    const migration = await findPendingLegacyOnboardingWork(redis);
    const warningArmedAt = parseStateNumber(warning.armedAt);
    if (migrationOnly && !migration && warningArmedAt === undefined) {
      logGoalInitializationSkipped(
        "migration_only_without_pending_work",
        lifecycleSource,
      );
      return;
    }
    const state = buildInitialOnboardingGoal(
      lifecycleSource,
      nowMs,
      migration,
      warning,
    );
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
    if (lockToken)
      await releaseRedisLock(redis, onboardingSubscriberGoalLockKey, lockToken);
  }
}

function buildInitialOnboardingGoal(
  lifecycleSource: OnboardingLifecycleSource,
  nowMs: number,
  migration: LegacyMigration | undefined,
  warning: Record<string, string>,
): OnboardingSubscriberGoalState {
  const warningArmedAt = parseStateNumber(warning.armedAt);
  const warningSentAt =
    warning.result === "sent" ? parseStateNumber(warning.sentAt) : undefined;
  const creationStaggerMinutes = selectOnboardingGoalStaggerMinutes();
  const armedAt = migration?.armedAt ?? warningArmedAt ?? nowMs;
  const reminderSentAt = migration?.reminderSentAt ?? warningSentAt;
  return {
    version: onboardingSubscriberGoalVersion,
    status: reminderSentAt ? "pending" : "awaiting_warning",
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
    ...(reminderSentAt
      ? {
          reminderSentAt: reminderSentAt,
          nextRunAt:
            Math.max(nowMs, reminderSentAt + onboardingGoalBaseDelayMs) +
            creationStaggerMinutes * 60 * 1000,
        }
      : {}),
    ...(migration?.deliveryUnknown ||
    warning.status === "dispatching" ||
    warning.result === "delivery_unknown"
      ? {
          status: "complete" as const,
          completedAt: nowMs,
          resultStatus: "delivery_unknown" as const,
        }
      : {}),
  };
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
  workflowLockHeld = false,
  warning?: Record<string, string>,
): Promise<OnboardingSubscriberGoalState | undefined> {
  let scheduledState: OnboardingSubscriberGoalState | undefined;
  await mutateGoalTerminalOrSchedule(
    redis,
    sentAt,
    (state) => {
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
    },
    workflowLockHeld,
    warning,
  );
  if (scheduledState && !warning)
    logOnboardingGoalScheduled(scheduledState, sentAt);
  return scheduledState;
}

export function logOnboardingGoalScheduled(
  scheduledState: OnboardingSubscriberGoalState,
  sentAt: number,
): void {
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

export async function markOnboardingSubscriberGoalExisting(
  redis: RedisClient,
  postId: string,
  existingSource: OnboardingExistingSource,
  nowMs = Date.now(),
  workflowLockHeld = false,
  warning?: Record<string, string>,
): Promise<void> {
  await mutateGoalTerminalOrSchedule(
    redis,
    nowMs,
    (state) => ({
      ...state,
      status: "complete",
      completedAt: nowMs,
      postId,
      existingSource,
      resultStatus: "existing",
    }),
    workflowLockHeld,
    warning,
  );
}

export async function markOnboardingSubscriberGoalExistingNotHighlighted(
  redis: RedisClient,
  postId: string,
  existingSource: OnboardingExistingSource,
  nowMs = Date.now(),
  errorMessage?: string,
  workflowLockHeld = false,
  warning?: Record<string, string>,
): Promise<void> {
  await mutateGoalTerminalOrSchedule(
    redis,
    nowMs,
    (state) => ({
      ...state,
      status: "complete",
      completedAt: nowMs,
      postId,
      existingSource,
      resultStatus: "existing_not_highlighted",
      ...(errorMessage ? { errorMessage } : {}),
    }),
    workflowLockHeld,
    warning,
  );
}

export async function markOnboardingSubscriberGoalCompleted(
  redis: RedisClient,
  postId: string,
  existingSource: OnboardingExistingSource,
  resultStatus: CompletedGoalReconciliationOutcome,
  nowMs = Date.now(),
  workflowLockHeld = false,
  warning?: Record<string, string>,
): Promise<void> {
  await mutateGoalTerminalOrSchedule(
    redis,
    nowMs,
    (state) => ({
      ...state,
      status: "complete",
      completedAt: nowMs,
      postId,
      existingSource,
      resultStatus,
    }),
    workflowLockHeld,
    warning,
  );
}

export async function markOnboardingSubscriberGoalIneligible(
  redis: RedisClient,
  subscriberCount: number,
  nowMs = Date.now(),
  reason?: OnboardingIneligibilityReason,
  workflowLockHeld = false,
  warning?: Record<string, string>,
): Promise<void> {
  let completedState: OnboardingSubscriberGoalState | undefined;
  await mutateGoalTerminalOrSchedule(
    redis,
    nowMs,
    (state) => {
      completedState = state;
      return {
        ...state,
        status: "complete",
        completedAt: nowMs,
        resultStatus: "ineligible",
        eligibilitySubscriberCount: subscriberCount,
        ...(reason ? { ineligibilityReason: reason } : {}),
      };
    },
    workflowLockHeld,
    warning,
  );
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
  workflowLockHeld = false,
  warning?: Record<string, string>,
): Promise<void> {
  await mutateGoalTerminalOrSchedule(
    redis,
    nowMs,
    (state) => ({
      ...state,
      status: "complete",
      completedAt: nowMs,
      resultStatus,
      ...(errorMessage ? { errorMessage } : {}),
    }),
    workflowLockHeld,
    warning,
  );
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
    return await withCommunityGoalMutationLease(
      redis,
      async (mutationLease) => {
        const lockToken = await acquireRedisLock(
          redis,
          onboardingSubscriberGoalLockKey,
          onboardingSubscriberGoalLockTtlMs,
          { nowMs },
        );
        if (!lockToken) return { status: "not_due", ...emptySummary() };
        try {
          return await processDueOnboardingSubscriberGoalUnderLease({
            reddit,
            redis,
            appSettings,
            nowMs,
            automationEnabled,
            mutationLease,
          });
        } finally {
          await releaseRedisLock(
            redis,
            onboardingSubscriberGoalLockKey,
            lockToken,
          );
        }
      },
    );
  } catch (error) {
    if (error instanceof CommunityGoalMutationInProgressError) {
      return { status: "not_due", ...emptySummary() };
    }
    throw error;
  }
}

type OnboardingCreationWork = {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  nowMs: number;
  automationEnabled: boolean;
  mutationLease: CommunityGoalMutationLease;
};
type OnboardingCreationProgress = {
  inspected: OnboardingDetectionDiagnostics;
  activeState: OnboardingSubscriberGoalState;
  creationAttempted: boolean;
  creationFinished: boolean;
  notificationLanguage: unknown;
};
type OnboardingCreationSubreddit = Awaited<
  ReturnType<RedditClient["getCurrentSubreddit"]>
>;

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
  if (!(await migrateOnboardingWarning(redis, nowMs)))
    return { status: "not_due", ...base };
  await initializeOnboardingSubscriberGoal(redis, {
    nowMs,
    lifecycleSource: "recovery",
    automationEnabled,
    workflowLockHeld: true,
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

  const work = {
    reddit,
    redis,
    appSettings,
    nowMs,
    automationEnabled,
    mutationLease,
  };
  const progress: OnboardingCreationProgress = {
    inspected: base,
    activeState: state,
    creationAttempted: false,
    creationFinished: false,
    notificationLanguage: undefined,
  };
  try {
    return await runOnboardingCreation(work, progress);
  } catch (error) {
    // diagnostic-allow-silent: the failure handler logs the replay or retry outcome.
    return handleOnboardingCreationFailure(work, progress, error);
  }
}

async function runOnboardingCreation(
  work: OnboardingCreationWork,
  progress: OnboardingCreationProgress,
): Promise<OnboardingSubscriberGoalSummary> {
  const { reddit, redis, nowMs, automationEnabled } = work;
  const base = progress.inspected;
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
  progress.activeState = reloaded;
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
  progress.notificationLanguage = subreddit.language;
  const eligibility = await checkOnboardingCreationEligibility(
    work,
    progress,
    subreddit,
    "eligibility",
  );
  if (eligibility) return eligibility;
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
    const exhausted = await deferOnboardingCreationPrerequisite(
      work,
      progress,
      "Subscriber Goal lacks verified Manage Posts permission.",
    );
    return { status: exhausted ? "complete" : "failed", ...progress.inspected };
  }

  const existing = await checkOnboardingCreationHighlights(
    work,
    progress,
    false,
  );
  if (existing) return existing;
  if (!automationEnabled) {
    await saveOnboardingState(redis, {
      ...reloaded,
      status: "pending",
      pausedAt: nowMs,
    });
    return { status: "paused", ...progress.inspected };
  }
  subreddit = await reddit.getCurrentSubreddit();
  const creationEligibility = await checkOnboardingCreationEligibility(
    work,
    progress,
    subreddit,
    "pre_create_eligibility",
  );
  if (creationEligibility) return creationEligibility;
  const finalExisting = await checkOnboardingCreationHighlights(
    work,
    progress,
    true,
  );
  if (finalExisting) return finalExisting;
  return createOnboardingGoal(work, progress, subreddit);
}

async function checkOnboardingCreationEligibility(
  work: OnboardingCreationWork,
  progress: OnboardingCreationProgress,
  subreddit: OnboardingCreationSubreddit,
  phase: "eligibility" | "pre_create_eligibility",
): Promise<OnboardingSubscriberGoalSummary | undefined> {
  const { redis, nowMs } = work;
  const reloaded = progress.activeState;
  const report = (eligibility: OnboardingEligibility) => {
    logDiagnostic("info", "onboarding_eligibility_checked", {
      workflow: "onboarding_subscriber_goal",
      phase,
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
  };
  const eligibility = getOnboardingEligibility(subreddit);
  if (phase === "eligibility") report(eligibility);
  if (!eligibility.eligible) {
    if (
      eligibility.reason !== "subscriber_count" &&
      isAutomaticGoalEligibilityUncertain(eligibility)
    ) {
      const exhausted = await deferOnboardingCreationPrerequisite(
        work,
        progress,
      );
      return {
        status: exhausted ? "complete" : "failed",
        ...progress.inspected,
      };
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
    if (phase === "pre_create_eligibility") report(eligibility);
    return {
      status: "ineligible",
      lifecycleSource: reloaded.lifecycleSource,
      creationStaggerMinutes: reloaded.creationStaggerMinutes,
      eligibilitySubscriberCount: eligibility.subscriberCount,
      ...progress.inspected,
    };
  }

  return undefined;
}

async function checkOnboardingCreationHighlights(
  { reddit, redis, appSettings, nowMs, mutationLease }: OnboardingCreationWork,
  progress: OnboardingCreationProgress,
  finalCheck: boolean,
): Promise<OnboardingSubscriberGoalSummary | undefined> {
  const reloaded = progress.activeState;
  const reconcilingSubmission =
    reloaded.resultStatus === "submission_reconciliation_pending";
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
  progress.inspected = {
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
      ...progress.inspected,
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
      ...progress.inspected,
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
      ...(existing.errorMessage ? { errorMessage: existing.errorMessage } : {}),
    });
    if (finalCheck) {
      logDiagnostic("info", "onboarding_goal_creation_suppressed", {
        workflow: "onboarding_subscriber_goal",
        phase: "pre_create_duplicate_check",
        lifecycleSource: reloaded.lifecycleSource,
        operationId: reloaded.operationId,
        postId: existing.postId,
        existingSource: existing.source!,
        isHighlighted: existing.selectedWasAlreadyHighlighted ?? false,
      });
    } else {
      console.info(
        `[onboardingSubscriberGoal] complete: status=${existing.status} existingSource=${existing.source} postId=${existing.postId} source=${reloaded.lifecycleSource} creationStaggerMinutes=${reloaded.creationStaggerMinutes} ${formatDetectionDiagnostics(progress.inspected)}`,
      );
    }
    return {
      status: "existing",
      postId: existing.postId,
      existingSource: existing.source!,
      lifecycleSource: reloaded.lifecycleSource,
      ...progress.inspected,
    };
  }

  return undefined;
}

async function createOnboardingGoal(
  work: OnboardingCreationWork,
  progress: OnboardingCreationProgress,
  subreddit: OnboardingCreationSubreddit,
): Promise<OnboardingSubscriberGoalSummary> {
  const { reddit, redis, appSettings, nowMs, mutationLease } = work;
  const reloaded = progress.activeState;
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
  progress.creationAttempted = true;
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
              buttonText:
                getAfterSubscribePresetMessages(language)
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
  progress.creationFinished = true;
  return recordOnboardingCreation(
    work,
    progress,
    creation,
    subreddit,
    language,
  );
}

async function recordOnboardingCreation(
  { reddit, redis, nowMs }: OnboardingCreationWork,
  progress: OnboardingCreationProgress,
  creation: Awaited<ReturnType<typeof createSubscriberGoal>>,
  subreddit: OnboardingCreationSubreddit,
  language: ReturnType<typeof resolveSubGoalLanguage>,
): Promise<OnboardingSubscriberGoalSummary> {
  const reloaded = progress.activeState;
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
      ...progress.inspected,
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
    `[onboardingSubscriberGoal] complete: status=created postId=${post.id} source=${reloaded.lifecycleSource} creationStaggerMinutes=${reloaded.creationStaggerMinutes} ${formatDetectionDiagnostics(progress.inspected)}`,
  );
  return {
    status: "created",
    postId: post.id,
    lifecycleSource: progress.activeState.lifecycleSource,
    ...progress.inspected,
  };
}

async function deferOnboardingCreationPrerequisite(
  { reddit, redis, nowMs }: OnboardingCreationWork,
  progress: OnboardingCreationProgress,
  errorMessage?: string,
): Promise<boolean> {
  const retry = await nextAutomaticGoalPrerequisiteRetry(
    redis,
    progress.activeState.operationId,
    nowMs,
  );
  await saveOnboardingState(redis, {
    ...progress.activeState,
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
      operationId: progress.activeState.operationId,
      unresolved: false,
      language: progress.notificationLanguage,
    });
  return retry.retryAt === null;
}

async function handleOnboardingCreationFailure(
  work: OnboardingCreationWork,
  progress: OnboardingCreationProgress,
  error: unknown,
): Promise<OnboardingSubscriberGoalSummary> {
  const { reddit, redis, nowMs } = work;
  progress.inspected =
    getDetectionDiagnosticsFromError(error) ?? progress.inspected;
  const errorMessage = String(error);
  if (error instanceof PostTemporarilyUnavailableError) {
    await saveOnboardingState(redis, {
      ...progress.activeState,
      status: "pending",
      nextRunAt: nowMs + temporarilyRemovedPostRecheckDelayMs,
      errorMessage,
    });
    logDiagnostic("info", "onboarding_goal_post_paused", {
      workflow: "onboarding_subscriber_goal",
      phase: "post_availability",
      operationId: progress.activeState.operationId,
      postId: error.postId,
      category: error.category ?? "unknown",
    });
    return { status: "failed", errorMessage, ...progress.inspected };
  }
  if (error instanceof SubscriberGoalCreationOutcomeUnknownError)
    return recordUnknownOnboardingCreation(work, progress, error, errorMessage);
  try {
    if (
      !progress.creationAttempted ||
      progress.creationFinished ||
      isAutomaticGoalPrerequisiteError(error)
    ) {
      const exhausted = await deferOnboardingCreationPrerequisite(
        work,
        progress,
        errorMessage,
      );
      logDiagnostic(
        exhausted ? "error" : "warn",
        exhausted
          ? "onboarding_goal_prerequisites_exhausted"
          : "onboarding_prerequisite_retry_scheduled",
        {
          workflow: "onboarding_subscriber_goal",
          phase: "prerequisite",
          operationId: progress.activeState.operationId,
        },
        error,
      );
      return {
        status: exhausted ? "complete" : "failed",
        errorMessage,
        ...progress.inspected,
      };
    }
    const attempts = (progress.activeState.attempts ?? 0) + 1;
    const terminal =
      attempts >= onboardingMaxAttempts || isPermanentOnboardingError(error);
    const retryDelayMs = selectOnboardingRetryDelayMs(attempts);
    await saveOnboardingState(redis, {
      ...progress.activeState,
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
        operationId: progress.activeState.operationId,
        unresolved: false,
        language: progress.notificationLanguage,
      });
    if (!terminal)
      logDiagnostic(
        "warn",
        "onboarding_goal_retry_scheduled",
        {
          workflow: "onboarding_subscriber_goal",
          phase: "retry",
          lifecycleSource: progress.activeState.lifecycleSource,
          creationStaggerMinutes: progress.activeState.creationStaggerMinutes,
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
      lifecycleSource: progress.activeState.lifecycleSource,
      creationStaggerMinutes: progress.activeState.creationStaggerMinutes,
    },
    error,
  );
  return {
    status: "failed",
    errorMessage,
    lifecycleSource: progress.activeState.lifecycleSource,
    ...progress.inspected,
  };
}

async function recordUnknownOnboardingCreation(
  { reddit, redis, nowMs }: OnboardingCreationWork,
  progress: OnboardingCreationProgress,
  error: SubscriberGoalCreationOutcomeUnknownError,
  errorMessage: string,
): Promise<OnboardingSubscriberGoalSummary> {
  const pending =
    error.reconciliationStatus === "pending" &&
    error.reconciliationNextAt !== undefined;
  await saveOnboardingState(redis, {
    ...progress.activeState,
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
      operationId: progress.activeState.operationId,
      unresolved: true,
      language: progress.notificationLanguage,
    });
  logDiagnostic(
    pending ? "warn" : "error",
    "onboarding_goal_submission_unresolved",
    {
      workflow: "onboarding_subscriber_goal",
      phase: "submission_reconciliation",
      lifecycleSource: progress.activeState.lifecycleSource,
      operationId: progress.activeState.operationId,
      reconciliationStatus: error.reconciliationStatus,
      reconciliationAttempts: error.reconciliationAttempts,
      reconciliationNextAt: error.reconciliationNextAt ?? "none",
    },
    error,
  );
  return {
    status: pending ? "failed" : "complete",
    errorMessage,
    lifecycleSource: progress.activeState.lifecycleSource,
    ...progress.inspected,
  };
}

export async function saveOnboardingState(
  redis: RedisClient,
  state: OnboardingSubscriberGoalState,
  warning?: Record<string, string>,
): Promise<void> {
  await redis.hSet(onboardingSubscriberGoalStateKey, {
    ...serializeOnboardingState(state),
    ...(warning ? onboardingWarningFields(warning) : {}),
  });
  if (state.status === "complete")
    await resetAutomaticGoalPrerequisiteRetry(redis, state.operationId);
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
  workflowLockHeld = false,
  warning?: Record<string, string>,
): Promise<void> {
  const lockToken = workflowLockHeld
    ? undefined
    : await acquireRedisLock(
        redis,
        onboardingSubscriberGoalLockKey,
        onboardingSubscriberGoalLockTtlMs,
        { nowMs },
      );
  if (!workflowLockHeld && !lockToken) {
    throw new Error("Onboarding goal state is currently locked");
  }
  try {
    const state = await getOnboardingSubscriberGoalState(redis);
    if (!state || state.status === "complete") {
      if (warning)
        await redis.hSet(
          onboardingSubscriberGoalStateKey,
          onboardingWarningFields(warning),
        );
      return;
    }
    await saveOnboardingState(redis, mutate(state), warning);
  } finally {
    if (lockToken)
      await releaseRedisLock(redis, onboardingSubscriberGoalLockKey, lockToken);
  }
}
