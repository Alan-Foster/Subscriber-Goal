import {
  createDefaultAfterSubscribeAction,
  getDefaultAfterSubscribePreset,
} from "../../shared/afterSubscribeAction";
import {
  getSubGoalPostMessages,
  resolveSubGoalLanguage,
} from "../../shared/subGoalPostI18n";
import { logDiagnostic } from "../../shared/diagnostics";
import {
  ctaOnlyPostKind,
  subscriberGoalPostKind,
  subscribeOnlyPostKind,
} from "../../shared/postKind";
import type { ServerAppSettings } from "../settings";
import {
  isLinkId,
  type LinkId,
  type RedditClient,
  type RedisClient,
} from "../types";
import { getDefaultSubscriberGoal } from "../utils/numberUtils";
import {
  clearHighlightFailureIncident,
  getPostUrl,
  notifyHighlightFailureIncident,
  type HighlightNotificationOutcome,
} from "../utils/highlightFailureNotifications";
import {
  cancelUpdates,
  getQueuedUpdates,
  getTrackedPosts,
  untrackPost,
} from "../data/updaterData";
import {
  checkCompletionStatus,
  getSubGoalData,
  postGoalSuffix,
  postHeightSuffix,
  postKindSuffix,
  subscriberGoalsKey,
} from "../data/subGoalData";
import {
  getRegisteredSubscriberGoalPosts,
  registerSubscriberGoalPost,
  removeSubscriberGoalPost,
} from "../data/subscriberGoalPostRegistry";
import {
  getTerminalRemovedByCategory,
  isMissingPostError,
} from "../utils/postStatus";
import { createSubscriberGoal } from "./createSubscriberGoal";
import {
  createFailedHighlightResult,
  highlightAndVerifyPost,
  highlightVerificationIntervalMs,
  highlightVerificationMaxWaitMs,
  type HighlightResult,
} from "../utils/communityHighlights";
import { getPersistedSubscriberGoalPostIds } from "../data/subscriberGoalCandidates";
import { checkAppAccountHealth } from "./appAccountHealth";
import {
  reconcileCompletedGoal,
  type CompletedGoalReconciliationOutcome,
} from "./completedGoalReconciliation";
import {
  getAutomaticGoalEligibility,
  type AutomaticGoalIneligibilityReason,
} from "./automaticGoalEligibility";
import {
  onboardingGoalBaseDelayMs,
  onboardingGoalStaggerMaxMinutes,
  onboardingGoalStaggerMinMinutes,
  onboardingMinimumSubscriberCount,
} from "./onboardingConfig";

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
export const onboardingRecentPostWindowMs = 25 * 60 * 60 * 1000;
export const onboardingRecentPostScanLimit = 1_000;
export const onboardingRecentPostPageSize = 100;
export const onboardingAuthorSearchLimit = 100;
export const onboardingSubscriberGoalLockTtlMs = 15 * 60 * 1000;
export const onboardingSubscriberGoalInitializationLockTtlMs = 60 * 1000;
export const onboardingMaxAttempts = 3;

type OnboardingStatus =
  | "awaiting_warning"
  | "pending"
  | "processing"
  | "complete";

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
  | "completed_no_recovery";

export type OnboardingLifecycleSource =
  | "install"
  | "upgrade"
  | "recovery"
  | "unknown";
export type OnboardingIneligibilityReason =
  | "subscriber_count"
  | AutomaticGoalIneligibilityReason;
export type OnboardingEligibility = {
  eligible: boolean;
  subscriberCount: number;
  subredditType: string;
  isSfw: boolean;
  safetyStatus: "sfw" | "nsfw" | "unknown";
  reason?: OnboardingIneligibilityReason;
};
export type OnboardingExistingSource =
  | "registered"
  | "tracked"
  | "queued"
  | "persisted"
  | "highlighted"
  | "search"
  | "recent";
export type OnboardingGoalDetectionMode =
  | "highlighted"
  | "active_or_recent"
  | "all";
export type OnboardingGoalClassification =
  | "classic"
  | "tiny"
  | "cta"
  | "ambiguous";

export type OnboardingDetectionDiagnostics = {
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

type CandidatePost = {
  id?: string;
  authorName?: string;
  subredditId?: string;
  subredditName?: string;
  createdAt?: Date | string | number;
  postData?: unknown;
  customPostData?: unknown;
  removedByCategory?: string;
  isHighlighted?: () => Promise<boolean>;
  highlight?: () => Promise<void>;
  unhighlight?: () => Promise<void>;
  title?: string;
  permalink?: string;
  url?: string;
  postHeight?: unknown;
};

export type OnboardingGoalCandidate = {
  postId: LinkId;
  post: CandidatePost;
  source: OnboardingExistingSource;
  createdAtMs?: number;
  isHighlighted: boolean;
  postKind?: string;
  postHeight?: string;
  classification: OnboardingGoalClassification;
  goal?: number;
  completedTime?: number;
  autoCreateNextGoal?: boolean;
  discoveryOrder: number;
};

export type OnboardingHighlightEnsuranceResult =
  OnboardingDetectionDiagnostics & {
    status: "missing" | "existing" | "existing_not_highlighted" | "completed";
    postId?: string;
    source?: OnboardingExistingSource;
    classification?: OnboardingGoalClassification;
    selectedWasAlreadyHighlighted?: boolean;
    candidateCount: number;
    highlightedClassicCount: number;
    highlightedProtectedCount: number;
    highlightedAmbiguousCount: number;
    classicPostsUnhighlighted: string[];
    protectedHighlightsPreserved: string[];
    verificationResult?: "highlighted" | "not_highlighted";
    reconciliationOutcome?: "complete" | "degraded" | "failed";
    failureCategories?: HighlightResult["issues"][number]["category"][];
    capacityOutcome?: HighlightResult["capacityOutcome"];
    cleanupOutcome?: HighlightResult["cleanupOutcome"];
    rollbackOutcome?: HighlightResult["rollbackOutcome"];
    reorderOutcome?: HighlightResult["reorderOutcome"];
    notificationOutcome?: HighlightNotificationOutcome;
    goal?: number;
    completedTime?: number;
    autoCreateNextGoal?: boolean;
    errorMessage?: string;
  };

const emptySummary = (): Omit<OnboardingSubscriberGoalSummary, "status"> => ({
  registeredInspected: 0,
  trackedInspected: 0,
  queuedInspected: 0,
  persistedInspected: 0,
  highlightedInspected: 0,
  searchInspected: 0,
  recentInspected: 0,
  validated: 0,
  stalePruned: 0,
  failed: 0,
});

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
  const lockToken = createLockToken(nowMs);
  await redis.set(onboardingSubscriberGoalInitializationLockKey, lockToken, {
    nx: true,
    expiration: new Date(
      nowMs + onboardingSubscriberGoalInitializationLockTtlMs,
    ),
  });
  if (
    (await redis.get(onboardingSubscriberGoalInitializationLockKey)) !==
    lockToken
  ) {
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
    await releaseOwnedLock(
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

  const lockToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(onboardingSubscriberGoalLockKey, lockToken, {
    nx: true,
    expiration: new Date(nowMs + onboardingSubscriberGoalLockTtlMs),
  });
  if ((await redis.get(onboardingSubscriberGoalLockKey)) !== lockToken) {
    return { status: "not_due", ...base };
  }

  let activeState = state;
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

    const existing = await ensureExistingSubscriberGoalHighlighted({
      reddit,
      redis,
      nowMs,
      notifyOnFailure: true,
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
      existing.completedTime
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
    if (existing.status !== "missing" && existing.postId) {
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

    const health = await checkAppAccountHealth({
      reddit,
      redis,
      subredditName: subreddit.name,
      subredditId: subreddit.id,
      notify: false,
      scheduleUnknownRetry: false,
      nowMs,
    });
    if (!health.healthy || health.status !== "healthy") {
      const errorMessage =
        "Subscriber Goal lacks verified Manage Posts permission.";
      await saveOnboardingState(redis, {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        resultStatus: "cancelled_permission",
        errorMessage,
      });
      logDiagnostic("warn", "onboarding_goal_cancelled", {
        workflow: "onboarding_subscriber_goal",
        phase: "permission_check",
        lifecycleSource: reloaded.lifecycleSource,
        operationId: reloaded.operationId,
        reason: "manage_posts_permission",
      });
      return {
        status: "cancelled",
        lifecycleSource: reloaded.lifecycleSource,
        creationStaggerMinutes: reloaded.creationStaggerMinutes,
        errorMessage,
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

    const finalExisting = await ensureExistingSubscriberGoalHighlighted({
      reddit,
      redis,
      nowMs,
      notifyOnFailure: true,
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
      finalExisting.completedTime
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
    if (finalExisting.status !== "missing" && finalExisting.postId) {
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

    const crosspost =
      subreddit.name.toLowerCase() !== appSettings.promoSubreddit.toLowerCase();
    const useTinyPost =
      subreddit.numberOfSubscribers > onboardingTinySubscriberThreshold;
    const language = resolveSubGoalLanguage(subreddit.language);
    const messages = getSubGoalPostMessages(language);
    const afterSubscribePreset = getDefaultAfterSubscribePreset(subreddit.type);
    logDiagnostic("info", "onboarding_goal_creation_started", {
      workflow: "onboarding_subscriber_goal",
      phase: "post_creation",
      lifecycleSource: reloaded.lifecycleSource,
      operationId: reloaded.operationId,
      scheduledRunAt: reloaded.nextRunAt,
      startedAt: nowMs,
      startedAtIso: new Date(nowMs).toISOString(),
    });
    const { post, highlightResult } = await createSubscriberGoal({
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
        afterSubscribeAction: createDefaultAfterSubscribeAction({
          language,
          subredditName: subreddit.name,
          subredditType: subreddit.type,
        }),
        afterSubscribePreset,
        operationId: reloaded.operationId,
        automaticPermissionCheck: true,
      },
    });
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
    try {
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
    if ((await redis.get(onboardingSubscriberGoalLockKey)) === lockToken) {
      await redis.del(onboardingSubscriberGoalLockKey);
    }
  }
}

/**
 * Compatibility selector backed by the consolidated discovery pipeline.
 * Production reconciliation consumes findValidSubscriberGoals directly.
 */
export async function findExistingSubscriberGoal(
  reddit: RedditClient,
  redis: RedisClient,
  nowMs: number,
  mode: OnboardingGoalDetectionMode = "active_or_recent",
): Promise<
  OnboardingDetectionDiagnostics & {
    postId?: string;
    source?: OnboardingExistingSource;
    isHighlighted?: boolean;
  }
> {
  const discovery = await findValidSubscriberGoals(reddit, redis, nowMs, true);
  const recentCutoff = nowMs - onboardingRecentPostWindowMs;
  const eligible = discovery.candidates.filter((candidate) => {
    if (candidate.isHighlighted) return true;
    if (mode === "highlighted") return false;
    return (
      candidate.source === "tracked" ||
      candidate.source === "queued" ||
      (candidate.createdAtMs !== undefined &&
        candidate.createdAtMs >= recentCutoff)
    );
  });
  const selected = eligible[0];
  const { candidates: _candidates, ...diagnostics } = discovery;
  return selected
    ? {
        ...diagnostics,
        postId: selected.postId,
        source: selected.source,
        isHighlighted: selected.isHighlighted,
      }
    : diagnostics;
}

/**
 * Discovers every valid app-owned goal needed by highlight reconciliation.
 * Unlike duplicate prevention, this intentionally includes old unhighlighted goals so an
 * install/upgrade can restore the newest one instead of creating a duplicate.
 */
export async function findValidSubscriberGoals(
  reddit: RedditClient,
  redis: RedisClient,
  nowMs = Date.now(),
  includeRecovery = true,
): Promise<
  OnboardingDetectionDiagnostics & { candidates: OnboardingGoalCandidate[] }
> {
  const diagnostics: OnboardingDetectionDiagnostics = {
    registeredInspected: 0,
    trackedInspected: 0,
    queuedInspected: 0,
    persistedInspected: 0,
    highlightedInspected: 0,
    searchInspected: 0,
    recentInspected: 0,
    validated: 0,
    stalePruned: 0,
    failed: 0,
  };
  const [registered, tracked, queued, persisted, subreddit, appUser] =
    await Promise.all([
      getRegisteredSubscriberGoalPosts(redis),
      getTrackedPosts(redis),
      getQueuedUpdates(redis),
      getPersistedSubscriberGoalPostIds(redis),
      reddit.getCurrentSubreddit(),
      reddit.getAppUser(),
    ]);
  if (!appUser?.username) {
    throw new Error(
      "Could not resolve app user while checking onboarding posts.",
    );
  }
  const highlightedPosts = await subreddit.getHighlightedPosts();
  const highlightedPostIds = new Set<string>(
    highlightedPosts.map(({ postId }) => postId),
  );
  diagnostics.highlightedInspected = highlightedPosts.length;

  const candidates: OnboardingGoalCandidate[] = [];
  const seen = new Set<string>();
  let discoveryOrder = 0;
  const inspect = async (
    post: CandidatePost,
    source: OnboardingExistingSource,
    pruneInvalid: boolean,
  ): Promise<void> => {
    const postId = post.id;
    if (!postId || seen.has(postId) || !isLinkId(postId)) return;
    seen.add(postId);
    if (
      !(await isSubscriberGoalCandidate(
        redis,
        post,
        subreddit,
        appUser.username,
      ))
    ) {
      if (pruneInvalid) {
        await pruneStaleCandidate(redis, postId);
        diagnostics.stalePruned += 1;
      }
      return;
    }
    const metadata = await getGoalCandidateMetadata(redis, post);
    const isHighlighted = highlightedPostIds.has(postId);
    diagnostics.validated += 1;
    await registerSubscriberGoalPost(
      redis,
      postId,
      getCreatedAtMs(post.createdAt) ?? nowMs,
    );
    const createdAtMs = getCreatedAtMs(post.createdAt);
    candidates.push({
      postId,
      post,
      source,
      ...(createdAtMs === undefined ? {} : { createdAtMs }),
      isHighlighted,
      ...metadata,
      discoveryOrder: discoveryOrder++,
    });
  };

  const knownSources: [OnboardingExistingSource, string[]][] = [
    ["registered", registered],
    ["tracked", tracked],
    ["queued", queued],
    ["persisted", persisted],
  ];
  for (const [source, postIds] of knownSources) {
    for (const postId of postIds) {
      if (seen.has(postId) || !isLinkId(postId)) continue;
      incrementInspected(diagnostics, source);
      try {
        const fetched = (await reddit.getPostById(postId)) as
          | CandidatePost
          | undefined;
        // Some test doubles and transient API adapters can yield no value
        // without throwing. Leave the ID discoverable through listings.
        if (!fetched) continue;
        await inspect(fetched, source, true);
      } catch (error) {
        if (isMissingPostError(error)) {
          seen.add(postId);
          await pruneStaleCandidate(redis, postId);
          diagnostics.stalePruned += 1;
          continue;
        }
        diagnostics.failed += 1;
        attachDetectionDiagnostics(error, diagnostics);
        throw error;
      }
    }
  }

  for (const { postId } of highlightedPosts) {
    if (seen.has(postId)) continue;
    try {
      await inspect(
        (await reddit.getPostById(postId)) as CandidatePost,
        "highlighted",
        false,
      );
    } catch (error) {
      if (!isMissingPostError(error)) {
        diagnostics.failed += 1;
        attachDetectionDiagnostics(error, diagnostics);
        throw error;
      }
    }
  }

  if (includeRecovery && candidates.length === 0) {
    const searchedPosts = (await reddit
      .searchPosts({
        query: `author:${appUser.username}`,
        subredditName: subreddit.name,
        sort: "new",
        timeframe: "all",
        limit: onboardingAuthorSearchLimit,
        pageSize: onboardingAuthorSearchLimit,
      })
      .all()) as CandidatePost[];
    diagnostics.searchInspected = searchedPosts.length;
    for (const post of searchedPosts) await inspect(post, "search", false);

    if (candidates.length === 0) {
      const recentPosts = (await reddit
        .getNewPosts({
          subredditName: subreddit.name,
          limit: onboardingRecentPostScanLimit,
          pageSize: onboardingRecentPostPageSize,
        })
        .all()) as CandidatePost[];
      diagnostics.recentInspected = recentPosts.length;
      for (const post of recentPosts) await inspect(post, "recent", false);
    }
  }

  return { ...diagnostics, candidates };
}

export async function ensureExistingSubscriberGoalHighlighted({
  reddit,
  redis,
  nowMs = Date.now(),
  notifyOnFailure = false,
  highlightVerification,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  nowMs?: number;
  notifyOnFailure?: boolean;
  highlightVerification?: Partial<{
    maxWaitMs: number;
    intervalMs: number;
  }>;
}): Promise<OnboardingHighlightEnsuranceResult> {
  const discovery = await findValidSubscriberGoals(reddit, redis, nowMs);
  const { candidates, ...diagnostics } = discovery;
  {
    let subscriberCount: number | undefined;
    for (const candidate of candidates) {
      if (
        candidate.classification === "tiny" ||
        candidate.classification === "cta"
      ) {
        continue;
      }
      const goalData = await getSubGoalData(
        redis,
        candidate.postId,
        candidate.post.postData ?? candidate.post.customPostData,
      );
      if (goalData.goal <= 0) continue;
      candidate.goal = goalData.goal;
      candidate.completedTime = goalData.completedTime;
      candidate.autoCreateNextGoal = goalData.autoCreateNextGoal;
      if (!candidate.completedTime && subscriberCount === undefined) {
        subscriberCount = (await reddit.getCurrentSubreddit())
          .numberOfSubscribers;
      }
      if (
        !candidate.completedTime &&
        subscriberCount !== undefined &&
        subscriberCount >= candidate.goal
      ) {
        candidate.completedTime = await checkCompletionStatus(
          reddit,
          redis,
          candidate.postId,
          { now: () => nowMs, scheduleAutomaticSuccessor: false },
        );
      }
    }
  }
  const highlighted = candidates.filter((candidate) => candidate.isHighlighted);
  const highlightedClassic = highlighted.filter(
    (candidate) => candidate.classification === "classic",
  );
  const protectedHighlighted = highlighted.filter(
    (candidate) =>
      candidate.classification === "tiny" || candidate.classification === "cta",
  );
  const ambiguousHighlighted = highlighted.filter(
    (candidate) => candidate.classification === "ambiguous",
  );
  const base = {
    ...diagnostics,
    candidateCount: candidates.length,
    highlightedClassicCount: highlightedClassic.length,
    highlightedProtectedCount: protectedHighlighted.length,
    highlightedAmbiguousCount: ambiguousHighlighted.length,
    classicPostsUnhighlighted: [] as string[],
    protectedHighlightsPreserved: protectedHighlighted.map(
      (candidate) => candidate.postId,
    ),
  };
  if (candidates.length === 0) {
    logHighlightEnsurance("missing", base);
    return { status: "missing", ...base };
  }

  {
    const targetGoals = candidates.filter(
      (candidate) => candidate.goal !== undefined && candidate.goal > 0,
    );
    const activeGoals = candidates.filter(
      (candidate) =>
        candidate.classification !== "tiny" &&
        candidate.classification !== "cta" &&
        !candidate.completedTime,
    );
    const completedGoals = targetGoals.filter((candidate) =>
      Boolean(candidate.completedTime),
    );
    if (completedGoals.length > 0 && activeGoals.length > 0) {
      const highlightedActiveGoals = activeGoals.filter(
        (candidate) => candidate.isHighlighted,
      );
      const selected = newestGoalCandidate(
        highlightedActiveGoals.length > 0
          ? highlightedActiveGoals
          : activeGoals,
      );
      const selectedWasAlreadyHighlighted = selected.isHighlighted;
      const reconciliation = await highlightExistingGoal({
        reddit,
        redis,
        selected,
        notifyOnFailure,
        removableManagedPostIds: highlightedClassic
          .filter((candidate) => candidate.postId !== selected.postId)
          .map((candidate) => candidate.postId),
        ...(highlightVerification ? { highlightVerification } : {}),
      });
      base.classicPostsUnhighlighted.push(
        ...reconciliation.highlightResult.removedManagedHighlightIds,
      );
      if (reconciliation.highlightResult.status === "not_highlighted") {
        const result: OnboardingHighlightEnsuranceResult = {
          status: "existing_not_highlighted",
          ...base,
          postId: selected.postId,
          source: selected.source,
          classification: selected.classification,
          selectedWasAlreadyHighlighted,
          ...reconciliationDetails(reconciliation.highlightResult),
          notificationOutcome: reconciliation.notificationOutcome,
        };
        logHighlightEnsurance(result.status, result);
        return result;
      }
      const result: OnboardingHighlightEnsuranceResult = {
        status: "existing",
        ...base,
        postId: selected.postId,
        source: selected.source,
        classification: selected.classification,
        selectedWasAlreadyHighlighted,
        ...reconciliationDetails(reconciliation.highlightResult),
        notificationOutcome: reconciliation.notificationOutcome,
      };
      logHighlightEnsurance(result.status, result);
      return result;
    }

    if (completedGoals.length > 0) {
      const autoReplaceableGoals = completedGoals.filter(
        (candidate) => candidate.autoCreateNextGoal,
      );
      const selected = newestGoalCandidate(
        autoReplaceableGoals.length > 0 ? autoReplaceableGoals : completedGoals,
      );
      const result: OnboardingHighlightEnsuranceResult = {
        status: "completed",
        ...base,
        postId: selected.postId,
        source: selected.source,
        classification: selected.classification,
        selectedWasAlreadyHighlighted: selected.isHighlighted,
        ...(selected.isHighlighted
          ? { verificationResult: "highlighted" as const }
          : {}),
        notificationOutcome: "not_requested",
        ...(selected.goal === undefined ? {} : { goal: selected.goal }),
        ...(selected.completedTime === undefined
          ? {}
          : { completedTime: selected.completedTime }),
        ...(selected.autoCreateNextGoal === undefined
          ? {}
          : { autoCreateNextGoal: selected.autoCreateNextGoal }),
      };
      logHighlightEnsurance(result.status, result);
      return result;
    }
  }

  const selected = newestGoalCandidate(
    highlighted.length === 0 ? candidates : highlighted,
  );
  const selectedWasAlreadyHighlighted = selected.isHighlighted;
  const keepClassic =
    selected.classification === "classic"
      ? selected
      : highlightedClassic.length > 0
        ? newestGoalCandidate(highlightedClassic)
        : undefined;
  const removableManagedPostIds = highlightedClassic
    .filter(
      (candidate) =>
        highlightedClassic.length > 1 &&
        candidate.postId !== keepClassic?.postId,
    )
    .map((candidate) => candidate.postId);
  const reconciliation = await highlightExistingGoal({
    reddit,
    redis,
    selected,
    notifyOnFailure,
    removableManagedPostIds,
    ...(highlightVerification ? { highlightVerification } : {}),
  });
  base.classicPostsUnhighlighted.push(
    ...reconciliation.highlightResult.removedManagedHighlightIds,
  );
  const result: OnboardingHighlightEnsuranceResult = {
    status:
      reconciliation.highlightResult.status === "highlighted"
        ? "existing"
        : "existing_not_highlighted",
    ...base,
    postId: selected.postId,
    source: selected.source,
    classification: selected.classification,
    selectedWasAlreadyHighlighted,
    ...reconciliationDetails(reconciliation.highlightResult),
    notificationOutcome: reconciliation.notificationOutcome,
  };
  logHighlightEnsurance(result.status, result);
  return result;
}

async function highlightExistingGoal({
  reddit,
  redis,
  selected,
  notifyOnFailure,
  highlightVerification,
  removableManagedPostIds,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  selected: OnboardingGoalCandidate;
  notifyOnFailure: boolean;
  highlightVerification?: Partial<{ maxWaitMs: number; intervalMs: number }>;
  removableManagedPostIds?: LinkId[];
}): Promise<{
  highlightResult: HighlightResult;
  notificationOutcome: HighlightNotificationOutcome;
}> {
  const highlightResult =
    typeof selected.post.highlight !== "function"
      ? createFailedHighlightResult(
          selected.postId,
          "write",
          "Unable to highlight the existing goal because post.highlight is unavailable.",
        )
      : await highlightAndVerifyPost(
          reddit,
          await reddit.getCurrentSubreddit(),
          {
            id: selected.postId,
            highlight: () => selected.post.highlight!(),
            ...(selected.post.unhighlight
              ? { unhighlight: () => selected.post.unhighlight!() }
              : {}),
            ...(selected.post.isHighlighted
              ? { isHighlighted: () => selected.post.isHighlighted!() }
              : {}),
          },
          {
            maxWaitMs:
              highlightVerification?.maxWaitMs ??
              highlightVerificationMaxWaitMs,
            intervalMs:
              highlightVerification?.intervalMs ??
              highlightVerificationIntervalMs,
            ...(removableManagedPostIds ? { removableManagedPostIds } : {}),
          },
        );
  if (highlightResult.issues.length === 0) {
    await clearHighlightFailureIncident(redis, selected.postId);
    return { highlightResult, notificationOutcome: "not_requested" };
  }

  let notificationOutcome: HighlightNotificationOutcome = "not_requested";
  if (notifyOnFailure) {
    try {
      const subreddit = await reddit.getCurrentSubreddit();
      notificationOutcome = await notifyHighlightFailureIncident({
        reddit,
        redis,
        postId: selected.postId,
        result: highlightResult,
        subredditId: subreddit.id,
        subredditName: subreddit.name,
        postTitle: selected.post.title ?? "Subscriber Goal",
        postUrl: getPostUrl(selected.post),
        errorMessage: highlightResult.errorMessage,
        postOrigin: "existing",
      });
    } catch (error) {
      notificationOutcome = "failed";
      logDiagnostic(
        "warn",
        "onboarding_existing_goal_notification_failed",
        {
          workflow: "onboarding_highlight_ensurance",
          phase: "highlight_notification",
          postId: selected.postId,
        },
        error,
      );
    }
  }
  return {
    highlightResult,
    notificationOutcome,
  };
}

function reconciliationDetails(
  highlightResult: HighlightResult,
): Pick<
  OnboardingHighlightEnsuranceResult,
  | "verificationResult"
  | "reconciliationOutcome"
  | "failureCategories"
  | "capacityOutcome"
  | "cleanupOutcome"
  | "rollbackOutcome"
  | "reorderOutcome"
  | "errorMessage"
> {
  return {
    verificationResult:
      highlightResult.status === "highlighted"
        ? "highlighted"
        : "not_highlighted",
    reconciliationOutcome:
      highlightResult.status === "not_highlighted"
        ? "failed"
        : highlightResult.issues.length > 0
          ? "degraded"
          : "complete",
    failureCategories: highlightResult.issues.map(({ category }) => category),
    capacityOutcome: highlightResult.capacityOutcome,
    cleanupOutcome: highlightResult.cleanupOutcome,
    rollbackOutcome: highlightResult.rollbackOutcome,
    reorderOutcome: highlightResult.reorderOutcome,
    ...(highlightResult.errorMessage
      ? { errorMessage: highlightResult.errorMessage }
      : {}),
  };
}

async function getGoalCandidateMetadata(
  redis: RedisClient,
  post: CandidatePost,
): Promise<{
  postKind?: string;
  postHeight?: string;
  classification: OnboardingGoalClassification;
}> {
  const data = post.postData ?? post.customPostData;
  const inline =
    data && typeof data === "object"
      ? (data as { postKind?: unknown; postHeight?: unknown })
      : undefined;
  const [persistedKind, persistedHeight] = await redis.hMGet(
    subscriberGoalsKey,
    [`${post.id}${postKindSuffix}`, `${post.id}${postHeightSuffix}`],
  );
  const postKind =
    typeof inline?.postKind === "string" ? inline.postKind : persistedKind;
  const inlineHeight = inline?.postHeight ?? post.postHeight;
  const postHeight =
    typeof inlineHeight === "string" ? inlineHeight : persistedHeight;
  let classification: OnboardingGoalClassification = "ambiguous";
  if (
    postKind === subscriberGoalPostKind &&
    (postHeight === "regular" || postHeight === "short")
  ) {
    classification = "classic";
  } else if (postKind === subscribeOnlyPostKind || postHeight === "tiny") {
    classification = "tiny";
  } else if (postKind === ctaOnlyPostKind || postHeight === "cta") {
    classification = "cta";
  }
  return {
    ...(postKind ? { postKind } : {}),
    ...(postHeight ? { postHeight } : {}),
    classification,
  };
}

function newestGoalCandidate(
  candidates: OnboardingGoalCandidate[],
): OnboardingGoalCandidate {
  return [...candidates].sort(
    (a, b) =>
      (b.createdAtMs ?? Number.NEGATIVE_INFINITY) -
        (a.createdAtMs ?? Number.NEGATIVE_INFINITY) ||
      a.discoveryOrder - b.discoveryOrder,
  )[0]!;
}

function logHighlightEnsurance(
  status: OnboardingHighlightEnsuranceResult["status"],
  result:
    | Omit<OnboardingHighlightEnsuranceResult, "status">
    | OnboardingHighlightEnsuranceResult,
): void {
  logDiagnostic("info", "onboarding_goal_highlight_ensurance_completed", {
    workflow: "onboarding_highlight_ensurance",
    phase: "reconcile",
    outcome: status,
    candidateCount: result.candidateCount,
    selectedPostId: result.postId ?? "none",
    selectedType: result.classification ?? "none",
    highlightedClassicCount: result.highlightedClassicCount,
    highlightedProtectedCount: result.highlightedProtectedCount,
    highlightedAmbiguousCount: result.highlightedAmbiguousCount,
    classicPostsUnhighlighted:
      result.classicPostsUnhighlighted.join(",") || "none",
    protectedHighlightsPreserved:
      result.protectedHighlightsPreserved.join(",") || "none",
    verificationResult: result.verificationResult ?? "not_attempted",
    reconciliationOutcome: result.reconciliationOutcome ?? "not_attempted",
    failureCategories: result.failureCategories?.join(",") || "none",
    capacityOutcome: result.capacityOutcome ?? "not_attempted",
    cleanupOutcome: result.cleanupOutcome ?? "not_attempted",
    rollbackOutcome: result.rollbackOutcome ?? "not_attempted",
    reorderOutcome: result.reorderOutcome ?? "not_attempted",
    notificationOutcome: result.notificationOutcome ?? "not_requested",
  });
}

async function isSubscriberGoalCandidate(
  redis: RedisClient,
  post: CandidatePost,
  subreddit: { id: string; name: string },
  appUsername: string,
): Promise<boolean> {
  if (
    !post.id ||
    post.authorName?.toLowerCase() !== appUsername.toLowerCase() ||
    getTerminalRemovedByCategory(post) !== undefined
  ) {
    return false;
  }
  if (
    post.subredditId !== subreddit.id &&
    post.subredditName?.toLowerCase() !== subreddit.name.toLowerCase()
  ) {
    return false;
  }
  const data = post.postData ?? post.customPostData;
  const postKind =
    data && typeof data === "object"
      ? (data as { postKind?: unknown }).postKind
      : undefined;
  if (
    postKind === subscriberGoalPostKind ||
    postKind === subscribeOnlyPostKind ||
    postKind === ctaOnlyPostKind
  ) {
    return true;
  }
  return await hasCompatiblePersistedPostData(redis, post.id);
}

async function hasCompatiblePersistedPostData(
  redis: RedisClient,
  postId: string,
): Promise<boolean> {
  const [postKind, goal, height] = await redis.hMGet(subscriberGoalsKey, [
    `${postId}${postKindSuffix}`,
    `${postId}${postGoalSuffix}`,
    `${postId}${postHeightSuffix}`,
  ]);
  return (
    postKind === subscriberGoalPostKind ||
    postKind === subscribeOnlyPostKind ||
    postKind === ctaOnlyPostKind ||
    (Number.isFinite(Number(goal)) && Number(goal) > 0) ||
    height === "tiny" ||
    height === "cta"
  );
}

function incrementInspected(
  diagnostics: OnboardingDetectionDiagnostics,
  source: OnboardingExistingSource,
): void {
  if (source === "registered") diagnostics.registeredInspected += 1;
  else if (source === "tracked") diagnostics.trackedInspected += 1;
  else if (source === "queued") diagnostics.queuedInspected += 1;
  else if (source === "persisted") diagnostics.persistedInspected += 1;
}

function formatDetectionDiagnostics(
  diagnostics: OnboardingDetectionDiagnostics,
): string {
  return `registeredInspected=${diagnostics.registeredInspected} trackedInspected=${diagnostics.trackedInspected} queuedInspected=${diagnostics.queuedInspected} persistedInspected=${diagnostics.persistedInspected} highlightedInspected=${diagnostics.highlightedInspected} searchInspected=${diagnostics.searchInspected} recentInspected=${diagnostics.recentInspected} validated=${diagnostics.validated} stalePruned=${diagnostics.stalePruned} failed=${diagnostics.failed}`;
}

function attachDetectionDiagnostics(
  error: unknown,
  diagnostics: OnboardingDetectionDiagnostics,
): void {
  if (error && typeof error === "object") {
    Object.assign(error, {
      onboardingDetectionDiagnostics: { ...diagnostics },
    });
  }
}

export function getDetectionDiagnosticsFromError(
  error: unknown,
): OnboardingDetectionDiagnostics | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return (error as { onboardingDetectionDiagnostics?: unknown })
    .onboardingDetectionDiagnostics as OnboardingDetectionDiagnostics;
}

async function pruneStaleCandidate(
  redis: RedisClient,
  postId: string,
): Promise<void> {
  await Promise.all([
    removeSubscriberGoalPost(redis, postId),
    cancelUpdates(redis, postId),
    untrackPost(redis, postId),
  ]);
}

function getCreatedAtMs(value: CandidatePost["createdAt"]): number | undefined {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
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
    raw.resultStatus === "completed_no_recovery"
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
  return (
    name === "ProhibitedSubredditError" ||
    name === "SubscriberGoalModeratorPermissionError" ||
    name === "SubscriberGoalPermissionVerificationError"
  );
}

async function mutateGoalTerminalOrSchedule(
  redis: RedisClient,
  nowMs: number,
  mutate: (
    state: OnboardingSubscriberGoalState,
  ) => OnboardingSubscriberGoalState,
): Promise<void> {
  const lockToken = createLockToken(nowMs);
  await redis.set(onboardingSubscriberGoalLockKey, lockToken, {
    nx: true,
    expiration: new Date(nowMs + onboardingSubscriberGoalLockTtlMs),
  });
  if ((await redis.get(onboardingSubscriberGoalLockKey)) !== lockToken) {
    throw new Error("Onboarding goal state is currently locked");
  }
  try {
    const state = await getOnboardingSubscriberGoalState(redis);
    if (!state || state.status === "complete") return;
    await saveOnboardingState(redis, mutate(state));
  } finally {
    await releaseOwnedLock(redis, onboardingSubscriberGoalLockKey, lockToken);
  }
}

function createLockToken(nowMs: number): string {
  return `${nowMs}:${Math.random().toString(36).slice(2)}`;
}

async function releaseOwnedLock(
  redis: RedisClient,
  key: string,
  token: string,
): Promise<void> {
  if ((await redis.get(key)) === token) await redis.del(key);
}
