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
  getPostUrl,
  notifyStickyFailure,
} from "../utils/stickyFailureNotifications";
import {
  cancelUpdates,
  getQueuedUpdates,
  getTrackedPosts,
  untrackPost,
} from "../data/updaterData";
import {
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
import {
  createSubscriberGoal,
  stickyAndVerifyPost,
  STICKY_VERIFICATION_INTERVAL_MS,
  STICKY_VERIFICATION_MAX_WAIT_MS,
} from "./createSubscriberGoal";
import { getPersistedSubscriberGoalPostIds } from "../data/subscriberGoalCandidates";
import { checkAppAccountHealth } from "./appAccountHealth";
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
export const onboardingPinnedPostScanLimit = 100;
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
  | "created_not_pinned"
  | "existing_not_pinned";

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
  | "pinned"
  | "search"
  | "recent";
export type OnboardingGoalDetectionMode =
  | "pinned"
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
  pinnedInspected: number;
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
  pinnedInspected: number;
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
  stickied?: boolean;
  createdAt?: Date | string | number;
  postData?: unknown;
  customPostData?: unknown;
  removedByCategory?: string;
  isStickied?: () => boolean | Promise<boolean>;
  sticky?: () => Promise<void>;
  unsticky?: () => Promise<void>;
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
  isPinned: boolean;
  postKind?: string;
  postHeight?: string;
  classification: OnboardingGoalClassification;
  discoveryOrder: number;
};

export type OnboardingPinEnsuranceResult = OnboardingDetectionDiagnostics & {
  status: "missing" | "existing" | "existing_not_pinned";
  postId?: string;
  source?: OnboardingExistingSource;
  classification?: OnboardingGoalClassification;
  selectedWasAlreadyPinned?: boolean;
  candidateCount: number;
  pinnedClassicCount: number;
  pinnedProtectedCount: number;
  pinnedAmbiguousCount: number;
  classicPostsUnpinned: string[];
  protectedPinsPreserved: string[];
  verificationResult?: "pinned" | "not_pinned";
  notificationOutcome?: "sent" | "failed" | "not_requested";
  errorMessage?: string;
};

const emptySummary = (): Omit<OnboardingSubscriberGoalSummary, "status"> => ({
  registeredInspected: 0,
  trackedInspected: 0,
  queuedInspected: 0,
  persistedInspected: 0,
  pinnedInspected: 0,
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

export async function markOnboardingSubscriberGoalExistingNotPinned(
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
    resultStatus: "existing_not_pinned",
    ...(errorMessage ? { errorMessage } : {}),
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

    const existing = await ensureExistingSubscriberGoalPinned({
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
      pinnedInspected: existing.pinnedInspected,
      searchInspected: existing.searchInspected,
      recentInspected: existing.recentInspected,
      validated: existing.validated,
      stalePruned: existing.stalePruned,
      failed: existing.failed,
    };
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
            : "existing_not_pinned",
        ...(existing.errorMessage ? { errorMessage: existing.errorMessage } : {}),
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

    const finalExisting = await ensureExistingSubscriberGoalPinned({
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
      pinnedInspected: finalExisting.pinnedInspected,
      searchInspected: finalExisting.searchInspected,
      recentInspected: finalExisting.recentInspected,
      validated: finalExisting.validated,
      stalePruned: finalExisting.stalePruned,
      failed: finalExisting.failed,
    };
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
            : "existing_not_pinned",
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
        isPinned: finalExisting.selectedWasAlreadyPinned ?? false,
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
    const { post, stickyResult } = await createSubscriberGoal({
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
    if (stickyResult.status === "not_pinned") {
      try {
        await notifyStickyFailure({
          reddit,
          subredditId: subreddit.id,
          subredditName: subreddit.name,
          postTitle: post.title,
          postUrl: getPostUrl(post),
          errorMessage: stickyResult.errorMessage,
        });
      } catch (notificationError) {
        logDiagnostic(
          "warn",
          "onboarding_goal_notification_failed",
          {
            workflow: "onboarding_subscriber_goal",
            phase: "sticky_notification",
            postId: post.id,
          },
          notificationError,
        );
      }
    }
    await saveOnboardingState(redis, {
      ...reloaded,
      status: "complete",
      completedAt: nowMs,
      postId: post.id,
      resultStatus:
        stickyResult.status === "pinned" ? "created" : "created_not_pinned",
    });
    logDiagnostic("info", "onboarding_goal_created", {
      workflow: "onboarding_subscriber_goal",
      phase: "complete",
      lifecycleSource: reloaded.lifecycleSource,
      operationId: reloaded.operationId,
      postId: post.id,
      pinStatus: stickyResult.status,
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

export async function findExistingSubscriberGoal(
  reddit: RedditClient,
  redis: RedisClient,
  nowMs: number,
  mode: OnboardingGoalDetectionMode = "active_or_recent",
): Promise<
  OnboardingDetectionDiagnostics & {
    postId?: string;
    source?: OnboardingExistingSource;
    isPinned?: boolean;
  }
> {
  const diagnostics: OnboardingDetectionDiagnostics = {
    registeredInspected: 0,
    trackedInspected: 0,
    queuedInspected: 0,
    persistedInspected: 0,
    pinnedInspected: 0,
    searchInspected: 0,
    recentInspected: 0,
    validated: 0,
    stalePruned: 0,
    failed: 0,
  };
  const [registered, tracked, queued, persisted] = await Promise.all([
    getRegisteredSubscriberGoalPosts(redis),
    getTrackedPosts(redis),
    getQueuedUpdates(redis),
    getPersistedSubscriberGoalPostIds(redis),
  ]);
  const [subreddit, appUser] = await Promise.all([
    reddit.getCurrentSubreddit(),
    reddit.getAppUser(),
  ]);
  if (!appUser?.username) {
    throw new Error(
      "Could not resolve app user while checking onboarding posts.",
    );
  }

  const candidateSources: [OnboardingExistingSource, string[]][] = [
    ["registered", registered],
    ["tracked", tracked],
    ["queued", queued],
    ["persisted", persisted],
  ];
  const activePostIds = new Set([...tracked, ...queued]);
  const recentCutoff = nowMs - onboardingRecentPostWindowMs;
  const seen = new Set<string>();
  for (const [source, postIds] of candidateSources) {
    for (const postId of postIds) {
      if (seen.has(postId) || !isLinkId(postId)) {
        continue;
      }
      seen.add(postId);
      incrementInspected(diagnostics, source);
      let post: CandidatePost | undefined;
      try {
        post = (await reddit.getPostById(postId)) as CandidatePost;
      } catch (error) {
        if (!isMissingPostError(error)) {
          diagnostics.failed += 1;
          attachDetectionDiagnostics(error, diagnostics);
          throw error;
        }
        await pruneStaleCandidate(redis, postId);
        diagnostics.stalePruned += 1;
        continue;
      }
      if (
        !post ||
        !(await isSubscriberGoalCandidate(
          redis,
          post,
          subreddit,
          appUser.username,
        ))
      ) {
        await pruneStaleCandidate(redis, postId);
        diagnostics.stalePruned += 1;
        continue;
      }
      const pinned = await isStickied(post);
      const createdAt = getCreatedAtMs(post.createdAt);
      const activeKnownSource = activePostIds.has(postId);
      if (
        !isDetectedGoal({
          mode,
          pinned,
          activeKnownSource,
          createdAt,
          recentCutoff,
        })
      ) {
        continue;
      }
      diagnostics.validated += 1;
      await registerSubscriberGoalPost(
        redis,
        postId,
        getCreatedAtMs(post.createdAt) ?? nowMs,
      );
      return { postId, source, isPinned: pinned, ...diagnostics };
    }
  }

  const hotPosts = (await reddit
    .getHotPosts({
      subredditName: subreddit.name,
      limit: onboardingPinnedPostScanLimit,
    })
    .get(onboardingPinnedPostScanLimit)) as CandidatePost[];
  diagnostics.pinnedInspected = hotPosts.length;
  for (const post of hotPosts) {
    const pinned = await isStickied(post);
    const createdAt = getCreatedAtMs(post.createdAt);
    if (
      isDetectedGoal({
        mode,
        pinned,
        activeKnownSource: false,
        createdAt,
        recentCutoff,
      }) &&
      (await isSubscriberGoalCandidate(
        redis,
        post,
        subreddit,
        appUser.username,
      ))
    ) {
      diagnostics.validated += 1;
      const postId = post.id!;
      await registerSubscriberGoalPost(
        redis,
        postId,
        getCreatedAtMs(post.createdAt) ?? nowMs,
      );
      return {
        postId,
        source: pinned ? "pinned" : "recent",
        isPinned: pinned,
        ...diagnostics,
      };
    }
  }

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
  for (const post of searchedPosts) {
    const pinned = await isStickied(post);
    const createdAt = getCreatedAtMs(post.createdAt);
    if (
      isDetectedGoal({
        mode,
        pinned,
        activeKnownSource: false,
        createdAt,
        recentCutoff,
      }) &&
      (await isSubscriberGoalCandidate(
        redis,
        post,
        subreddit,
        appUser.username,
      ))
    ) {
      diagnostics.validated += 1;
      const postId = post.id!;
      await registerSubscriberGoalPost(
        redis,
        postId,
        getCreatedAtMs(post.createdAt) ?? nowMs,
      );
      return {
        postId,
        source: "search",
        isPinned: pinned,
        ...diagnostics,
      };
    }
  }

  const recentPosts = (await reddit
    .getNewPosts({
      subredditName: subreddit.name,
      limit: onboardingRecentPostScanLimit,
      pageSize: onboardingRecentPostPageSize,
    })
    .all()) as CandidatePost[];
  diagnostics.recentInspected = recentPosts.length;
  for (const post of recentPosts) {
    const createdAt = getCreatedAtMs(post.createdAt);
    if (createdAt === undefined || createdAt < recentCutoff) {
      continue;
    }
    const pinned = await isStickied(post);
    if (
      isDetectedGoal({
        mode,
        pinned,
        activeKnownSource: false,
        createdAt,
        recentCutoff,
      }) &&
      (await isSubscriberGoalCandidate(
        redis,
        post,
        subreddit,
        appUser.username,
      ))
    ) {
      diagnostics.validated += 1;
      const postId = post.id!;
      await registerSubscriberGoalPost(redis, postId, createdAt ?? nowMs);
      return {
        postId,
        source: "recent",
        isPinned: pinned,
        ...diagnostics,
      };
    }
  }
  return diagnostics;
}

/**
 * Discovers every valid app-owned goal needed by pin reconciliation. Unlike
 * duplicate prevention, this intentionally includes old unpinned goals so an
 * install/upgrade can restore the newest one instead of creating a duplicate.
 */
export async function findValidSubscriberGoals(
  reddit: RedditClient,
  redis: RedisClient,
  nowMs = Date.now(),
): Promise<OnboardingDetectionDiagnostics & { candidates: OnboardingGoalCandidate[] }> {
  const diagnostics: OnboardingDetectionDiagnostics = {
    registeredInspected: 0,
    trackedInspected: 0,
    queuedInspected: 0,
    persistedInspected: 0,
    pinnedInspected: 0,
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
    throw new Error("Could not resolve app user while checking onboarding posts.");
  }

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
    if (!(await isSubscriberGoalCandidate(redis, post, subreddit, appUser.username))) {
      if (pruneInvalid) {
        await pruneStaleCandidate(redis, postId);
        diagnostics.stalePruned += 1;
      }
      return;
    }
    const metadata = await getGoalCandidateMetadata(redis, post);
    const isPinned = await isStickied(post);
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
      isPinned,
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

  const hotPosts = (await reddit
    .getHotPosts({
      subredditName: subreddit.name,
      limit: onboardingPinnedPostScanLimit,
    })
    .get(onboardingPinnedPostScanLimit)) as CandidatePost[];
  diagnostics.pinnedInspected = hotPosts.length;
  for (const post of hotPosts) {
    await inspect(post, (await isStickied(post)) ? "pinned" : "recent", false);
  }

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

  const recentPosts = (await reddit
    .getNewPosts({
      subredditName: subreddit.name,
      limit: onboardingRecentPostScanLimit,
      pageSize: onboardingRecentPostPageSize,
    })
    .all()) as CandidatePost[];
  diagnostics.recentInspected = recentPosts.length;
  for (const post of recentPosts) await inspect(post, "recent", false);

  return { ...diagnostics, candidates };
}

export async function ensureExistingSubscriberGoalPinned({
  reddit,
  redis,
  nowMs = Date.now(),
  notifyOnFailure = false,
  stickyVerification,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  nowMs?: number;
  notifyOnFailure?: boolean;
  stickyVerification?: Partial<{
    maxWaitMs: number;
    intervalMs: number;
  }>;
}): Promise<OnboardingPinEnsuranceResult> {
  const discovery = await findValidSubscriberGoals(reddit, redis, nowMs);
  const { candidates, ...diagnostics } = discovery;
  const pinned = candidates.filter((candidate) => candidate.isPinned);
  const pinnedClassic = pinned.filter(
    (candidate) => candidate.classification === "classic",
  );
  const protectedPinned = pinned.filter(
    (candidate) =>
      candidate.classification === "tiny" ||
      candidate.classification === "cta",
  );
  const ambiguousPinned = pinned.filter(
    (candidate) => candidate.classification === "ambiguous",
  );
  const base = {
    ...diagnostics,
    candidateCount: candidates.length,
    pinnedClassicCount: pinnedClassic.length,
    pinnedProtectedCount: protectedPinned.length,
    pinnedAmbiguousCount: ambiguousPinned.length,
    classicPostsUnpinned: [] as string[],
    protectedPinsPreserved: protectedPinned.map((candidate) => candidate.postId),
  };
  if (candidates.length === 0) {
    logPinEnsurance("missing", base);
    return { status: "missing", ...base };
  }

  let selected: OnboardingGoalCandidate;
  let selectedWasAlreadyPinned = true;
  if (pinned.length === 0) {
    selected = newestGoalCandidate(candidates);
    selectedWasAlreadyPinned = false;
    let stickyResult: Awaited<ReturnType<typeof stickyAndVerifyPost>>;
    if (typeof selected.post.sticky !== "function") {
      stickyResult = {
        status: "not_pinned",
        verifiedStickied: false,
        errorMessage: "Unable to pin the existing goal because post.sticky is unavailable.",
      };
    } else {
      stickyResult = await stickyAndVerifyPost(
        reddit,
        {
          id: selected.postId,
          sticky: selected.post.sticky,
          ...(selected.post.isStickied
            ? { isStickied: selected.post.isStickied }
            : {}),
        },
        (await reddit.getCurrentSubreddit()).name,
        {
          maxWaitMs:
            stickyVerification?.maxWaitMs ?? STICKY_VERIFICATION_MAX_WAIT_MS,
          intervalMs:
            stickyVerification?.intervalMs ??
            STICKY_VERIFICATION_INTERVAL_MS,
        },
      );
    }
    if (stickyResult.status === "not_pinned") {
      let notificationOutcome: OnboardingPinEnsuranceResult["notificationOutcome"] =
        "not_requested";
      if (notifyOnFailure) {
        try {
          const subreddit = await reddit.getCurrentSubreddit();
          notificationOutcome = await notifyStickyFailure({
            reddit,
            subredditId: subreddit.id,
            subredditName: subreddit.name,
            postTitle: selected.post.title ?? "Subscriber Goal",
            postUrl: getPostUrl(selected.post),
            errorMessage: stickyResult.errorMessage,
            postOrigin: "existing",
          });
        } catch (error) {
          notificationOutcome = "failed";
          logDiagnostic(
            "warn",
            "onboarding_existing_goal_notification_failed",
            {
              workflow: "onboarding_pin_ensurance",
              phase: "sticky_notification",
              postId: selected.postId,
            },
            error,
          );
        }
      }
      const result: OnboardingPinEnsuranceResult = {
        status: "existing_not_pinned",
        ...base,
        postId: selected.postId,
        source: selected.source,
        classification: selected.classification,
        selectedWasAlreadyPinned,
        verificationResult: "not_pinned",
        notificationOutcome,
        ...(stickyResult.errorMessage
          ? { errorMessage: stickyResult.errorMessage }
          : {}),
      };
      logPinEnsurance(result.status, result);
      return result;
    }
  } else {
    selected = newestGoalCandidate(pinned);
  }

  if (pinned.length > 1 && pinnedClassic.length > 1) {
    const keepClassic = newestGoalCandidate(pinnedClassic);
    for (const candidate of pinnedClassic) {
      if (candidate.postId === keepClassic.postId) continue;
      if (await safelyUnstickyCandidate(reddit, candidate)) {
        base.classicPostsUnpinned.push(candidate.postId);
      }
    }
  }
  const result: OnboardingPinEnsuranceResult = {
    status: "existing",
    ...base,
    postId: selected.postId,
    source: selected.source,
    classification: selected.classification,
    selectedWasAlreadyPinned,
    verificationResult: "pinned",
    notificationOutcome: "not_requested",
  };
  logPinEnsurance(result.status, result);
  return result;
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

async function safelyUnstickyCandidate(
  reddit: RedditClient,
  candidate: OnboardingGoalCandidate,
): Promise<boolean> {
  if (
    candidate.classification !== "classic" ||
    typeof candidate.post.unsticky !== "function"
  ) {
    return false;
  }
  try {
    await candidate.post.unsticky();
    const refreshed = (await reddit.getPostById(candidate.postId)) as CandidatePost;
    return !(await isStickied(refreshed));
  } catch (error) {
    if (isMissingPostError(error)) return true;
    logDiagnostic(
      "warn",
      "sticky_operation_failed",
      {
        workflow: "onboarding_pin_ensurance",
        phase: "classic_unsticky",
        postId: candidate.postId,
      },
      error,
    );
    return false;
  }
}

function logPinEnsurance(
  status: OnboardingPinEnsuranceResult["status"],
  result: Omit<OnboardingPinEnsuranceResult, "status"> | OnboardingPinEnsuranceResult,
): void {
  logDiagnostic("info", "onboarding_goal_pin_ensurance_completed", {
    workflow: "onboarding_pin_ensurance",
    phase: "reconcile",
    outcome: status,
    candidateCount: result.candidateCount,
    selectedPostId: result.postId ?? "none",
    selectedType: result.classification ?? "none",
    pinnedClassicCount: result.pinnedClassicCount,
    pinnedProtectedCount: result.pinnedProtectedCount,
    pinnedAmbiguousCount: result.pinnedAmbiguousCount,
    classicPostsUnpinned: result.classicPostsUnpinned.join(",") || "none",
    protectedPinsPreserved:
      result.protectedPinsPreserved.join(",") || "none",
    verificationResult: result.verificationResult ?? "not_attempted",
    notificationOutcome: result.notificationOutcome ?? "not_requested",
  });
}

function isDetectedGoal({
  mode,
  pinned,
  activeKnownSource,
  createdAt,
  recentCutoff,
}: {
  mode: OnboardingGoalDetectionMode;
  pinned: boolean;
  activeKnownSource: boolean;
  createdAt: number | undefined;
  recentCutoff: number;
}): boolean {
  if (pinned) return true;
  if (mode === "pinned") return false;
  return (
    activeKnownSource || (createdAt !== undefined && createdAt >= recentCutoff)
  );
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
  return `registeredInspected=${diagnostics.registeredInspected} trackedInspected=${diagnostics.trackedInspected} queuedInspected=${diagnostics.queuedInspected} persistedInspected=${diagnostics.persistedInspected} pinnedInspected=${diagnostics.pinnedInspected} searchInspected=${diagnostics.searchInspected} recentInspected=${diagnostics.recentInspected} validated=${diagnostics.validated} stalePruned=${diagnostics.stalePruned} failed=${diagnostics.failed}`;
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

async function isStickied(post: CandidatePost): Promise<boolean> {
  if (post.stickied) {
    return true;
  }
  return typeof post.isStickied === "function"
    ? Boolean(await post.isStickied())
    : false;
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
    raw.resultStatus === "created_not_pinned" ||
    raw.resultStatus === "existing_not_pinned"
  ) {
    state.resultStatus = raw.resultStatus;
  }
  if (
    raw.existingSource === "registered" ||
    raw.existingSource === "tracked" ||
    raw.existingSource === "queued" ||
    raw.existingSource === "persisted" ||
    raw.existingSource === "pinned" ||
    raw.existingSource === "search" ||
    raw.existingSource === "recent"
  ) {
    state.existingSource = raw.existingSource;
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
