import { isOnboardingIneligibilityReason } from "./onboardingEligibility";
import {
  migrateOnboardingWarning,
  onboardingWarningFields,
  onboardingWarningDeliveryUnknownMessage,
  onboardingSubscriberGoalStateKey,
  onboardingSubscriberGoalLockKey,
  onboardingSubscriberGoalLockTtlMs,
  readOnboardingWarningFields,
} from "./onboardingState";
import {
  CommunityGoalMutationInProgressError,
  withCommunityGoalMutationLease,
  type CommunityGoalMutationLease,
} from "./communityGoalMutation";
export { onboardingReminderStateKey } from "./onboardingState";
import {
  PostTemporarilyUnavailableError,
  temporarilyRemovedPostRecheckDelayMs,
} from "../utils/postStatus";
import {
  nextAutomaticGoalPrerequisiteRetry,
  resetAutomaticGoalPrerequisiteRetry,
  notifyAutomaticGoalExhausted,
} from "./automaticGoalRetry";
import { isAutomaticGoalEligibilityUncertain } from "./automaticGoalEligibility";
import type { RedditClient, RedisClient } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";
import { translate } from "../../shared/i18n/catalog";
import {
  AUTOMATIC_ONBOARDING_ENABLED,
  getOnboardingEligibility,
  isExpectedCompletedReplacement,
  logOnboardingGoalScheduled,
  getOnboardingSubscriberGoalState,
  initializeOnboardingSubscriberGoal,
  markOnboardingSubscriberGoalExisting,
  markOnboardingSubscriberGoalExistingNotHighlighted,
  markOnboardingSubscriberGoalCompleted,
  markOnboardingSubscriberGoalIneligible,
  markOnboardingSubscriberGoalCancelled,
  onboardingMaxAttempts,
  onboardingMinimumSubscriberCount,
  scheduleOnboardingSubscriberGoalAfterWarning,
  saveOnboardingState,
  selectOnboardingGoalStaggerMinutes,
  selectOnboardingRetryDelayMs,
  type OnboardingIneligibilityReason,
} from "./onboardingSubscriberGoal";
import { ensureExistingSubscriberGoalHighlighted } from "./highlightReconciliation";
import {
  getDetectionDiagnosticsFromError,
  type OnboardingDetectionDiagnostics,
  type OnboardingExistingSource,
  type OnboardingLifecycleSource,
} from "./goalDiscovery";
import {
  reconcileCompletedGoal,
  type CompletedGoalReconciliationOutcome,
} from "./completedGoalReconciliation";
import { checkAppAccountHealth } from "./appAccountHealth";
import {
  onboardingGoalBaseDelayMs,
  onboardingGoalStaggerMaxMinutes,
  onboardingReminderStaggerMaxMinutes,
  onboardingReminderStaggerMinMinutes,
} from "./onboardingConfig";
import { findLiveHighlightedSubscriberGoalCandidates } from "../data/liveSubscriberGoalHighlights";
import {
  acquireRedisLock,
  releaseRedisLock,
  withRedisLock,
} from "../utils/redisOwnedLock";

function isUpgradeOnboardingIntent(
  state:
    Awaited<ReturnType<typeof getOnboardingSubscriberGoalState>> | undefined,
): boolean {
  return Boolean(
    state?.lifecycleSource === "upgrade" &&
    (state.intent === "missing_goal" ||
      state.intent === "orphaned_completed_goal"),
  );
}

export {
  onboardingReminderStaggerMaxMinutes,
  onboardingReminderStaggerMinMinutes,
} from "./onboardingConfig";

export const onboardingReminderVersion = "onboarding_reminder_v3";
export const onboardingReminderDelayMs =
  onboardingReminderStaggerMinMinutes * 60 * 1000;

type OnboardingReminderStatus =
  "pending" | "processing" | "dispatching" | "complete";
type OnboardingReminderResult =
  | "sent"
  | "existing"
  | "existing_not_highlighted"
  | "ineligible"
  | "failed"
  | "cancelled_permission"
  | "delivery_unknown"
  | "retry_exhausted"
  | "replacement_scheduled"
  | "replacement_created"
  | "replacement_retrying"
  | "replacement_exhausted"
  | "completed_auto_disabled"
  | "completed_no_recovery";

export type OnboardingReminderState = {
  version: typeof onboardingReminderVersion;
  status: OnboardingReminderStatus;
  nextRunAt: number;
  armedAt: number;
  lifecycleSource: OnboardingLifecycleSource;
  reminderStaggerMinutes: number;
  sentAt?: number;
  migratedFromVersion?: string;
  legacyAttempts?: number;
  eligibilitySubscriberCount?: number;
  ineligibilityReason?: OnboardingIneligibilityReason;
  startedAt?: number;
  completedAt?: number;
  postId?: string;
  existingSource?: OnboardingExistingSource;
  result?: OnboardingReminderResult;
  errorMessage?: string;
  attempts?: number;
  pausedAt?: number;
  dispatchToken?: string;
};

export type OnboardingReminderSummary = OnboardingDetectionDiagnostics & {
  status:
    | "not_due"
    | "sent"
    | "existing"
    | "ineligible"
    | "cancelled"
    | "paused"
    | "failed"
    | "complete";
  postId?: string;
  existingSource?: OnboardingExistingSource;
  errorMessage?: string;
  eligibilitySubscriberCount?: number;
};

export type OnboardingReminderMessage = {
  subject: string;
  bodyMarkdown: string;
};

const emptySummary = (): Omit<OnboardingReminderSummary, "status"> => ({
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

export function buildOnboardingReminderMessage(
  subredditName: string,
  lifecycleSource: OnboardingLifecycleSource = "install",
  language?: unknown,
  intent: "missing_goal" | "orphaned_completed_goal" = "missing_goal",
): OnboardingReminderMessage {
  const isUpgrade = lifecycleSource === "upgrade";
  const automaticCreationNotice = translate(
    language,
    intent === "orphaned_completed_goal"
      ? "outbound.onboarding.orphanedAutomation"
      : "outbound.onboarding.automation",
    {
      delay: formatDelay(onboardingGoalBaseDelayMs),
      maxMinutes: onboardingGoalStaggerMaxMinutes.toLocaleString("en-US"),
    },
  );
  return {
    subject: isUpgrade
      ? translate(language, "outbound.onboarding.upgradeSubject", {
          subredditName,
        })
      : translate(language, "outbound.onboarding.installSubject", {
          subredditName,
        }),
    bodyMarkdown:
      (isUpgrade
        ? translate(language, "outbound.onboarding.upgradeIntro", {
            subredditName,
          })
        : translate(language, "outbound.onboarding.installIntro", {
            subredditName,
          })) +
      `\n\n${translate(language, "outbound.onboarding.info")}\n\n` +
      `${translate(language, "outbound.onboarding.support")}\n\n` +
      automaticCreationNotice,
  };
}

function formatDelay(delayMs: number): string {
  const minutes = delayMs / (60 * 1000);
  if (Number.isInteger(minutes / 60)) {
    const hours = minutes / 60;
    return `${hours.toLocaleString("en-US")}-hour`;
  }
  return `${minutes.toLocaleString("en-US")}-minute`;
}

/** Arms a single reminder for the current installation. */
export async function scheduleOnboardingReminder(
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
  void migrationOnly;
  if (!automationEnabled) {
    logReminderSchedulingSkipped("automation_disabled", lifecycleSource);
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
    logReminderSchedulingSkipped("initialization_lock_busy", lifecycleSource);
    return;
  }
  try {
    if (!(await migrateOnboardingWarning(redis, nowMs))) return;
    const rawState = await readOnboardingWarningFields(redis);
    const existing = parseOnboardingReminderState(rawState);
    if (existing) {
      logReminderSchedulingSkipped(
        "existing_state_preserved",
        lifecycleSource,
        existing,
      );
      return;
    }
    if (Object.keys(rawState).length > 0) {
      logDiagnostic("warn", "onboarding_reminder_scheduling_skipped", {
        workflow: "onboarding_reminder",
        phase: "schedule",
        lifecycleSource,
        reason: "unparseable_nonempty_state",
        rawFieldCount: Object.keys(rawState).length,
      });
      return;
    }
    const goalState = await getOnboardingSubscriberGoalState(redis);
    if (goalState?.status !== "awaiting_warning") {
      logDiagnostic("info", "onboarding_reminder_scheduling_skipped", {
        workflow: "onboarding_reminder",
        phase: "schedule",
        lifecycleSource,
        reason: "goal_not_awaiting_warning",
        goalState: goalState?.status ?? "missing_or_unparseable",
        goalResult: goalState?.resultStatus ?? "none",
        operationId: goalState?.operationId ?? "none",
      });
      return;
    }
    await armOnboardingWarning(redis, goalState, nowMs);
  } finally {
    if (lockToken)
      await releaseRedisLock(redis, onboardingSubscriberGoalLockKey, lockToken);
  }
}

async function armOnboardingWarning(
  redis: RedisClient,
  goalState: NonNullable<WarningGoalState>,
  nowMs: number,
): Promise<void> {
  const reminderStaggerMinutes = selectOnboardingReminderStaggerMinutes();
  const state: OnboardingReminderState = {
    version: onboardingReminderVersion,
    status: "pending",
    armedAt: goalState.armedAt,
    nextRunAt: nowMs + reminderStaggerMinutes * 60 * 1000,
    lifecycleSource: goalState.lifecycleSource,
    reminderStaggerMinutes,
    ...(goalState.migratedFromVersion
      ? {
          migratedFromVersion: goalState.migratedFromVersion,
          legacyAttempts: goalState.legacyAttempts,
        }
      : {}),
  };
  await saveOnboardingReminderState(redis, state);
  logDiagnostic("info", "onboarding_reminder_scheduled", {
    workflow: "onboarding_reminder",
    phase: "schedule",
    lifecycleSource: state.lifecycleSource,
    reminderStaggerMinutes: state.reminderStaggerMinutes,
    nextRunAt: state.nextRunAt,
    nextRunAtIso: new Date(state.nextRunAt).toISOString(),
    version: state.version,
    migratedFromVersion: state.migratedFromVersion ?? "none",
  });
}

function logReminderSchedulingSkipped(
  reason: string,
  lifecycleSource: OnboardingLifecycleSource,
  state?: OnboardingReminderState,
): void {
  logDiagnostic("info", "onboarding_reminder_scheduling_skipped", {
    workflow: "onboarding_reminder",
    phase: "schedule",
    lifecycleSource,
    reason,
    reminderState: state?.status ?? "none",
    reminderResult: state?.result ?? "none",
    nextRunAt: state?.nextRunAt ?? "none",
    nextRunAtIso:
      state?.nextRunAt === undefined
        ? "none"
        : new Date(state.nextRunAt).toISOString(),
  });
}

export async function markOnboardingReminderIneligible(
  redis: RedisClient,
  subscriberCount: number,
  nowMs = Date.now(),
  reason?: OnboardingIneligibilityReason,
  workflowLockHeld = false,
): Promise<void> {
  if (!workflowLockHeld) {
    await withRedisLock(
      redis,
      onboardingSubscriberGoalLockKey,
      onboardingSubscriberGoalLockTtlMs,
      async () => {
        if (!(await migrateOnboardingWarning(redis, nowMs, true))) return;
        await markOnboardingReminderIneligible(
          redis,
          subscriberCount,
          nowMs,
          reason,
          true,
        );
      },
      { nowMs },
    );
    return;
  }
  const state = parseOnboardingReminderState(
    await readOnboardingWarningFields(redis),
  );
  if (!state || state.status === "complete") return;
  await reconcileCompletedReminder(
    redis,
    {
      ...state,
      status: "complete",
      completedAt: nowMs,
      result: "ineligible",
      eligibilitySubscriberCount: subscriberCount,
      ...(reason ? { ineligibilityReason: reason } : {}),
    },
    nowMs,
    true,
  );
}

export async function getOnboardingReminderState(
  redis: RedisClient,
): Promise<OnboardingReminderState | undefined> {
  return parseOnboardingReminderState(await readOnboardingWarningFields(redis));
}

export function selectOnboardingReminderStaggerMinutes(
  randomValue = Math.random(),
): number {
  const normalized = Math.min(Math.max(randomValue, 0), 1 - Number.EPSILON);
  return (
    Math.floor(
      normalized *
        (onboardingReminderStaggerMaxMinutes -
          onboardingReminderStaggerMinMinutes +
          1),
    ) + onboardingReminderStaggerMinMinutes
  );
}

export async function processDueOnboardingReminder({
  reddit,
  redis,
  nowMs = Date.now(),
  automationEnabled = AUTOMATIC_ONBOARDING_ENABLED,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  nowMs?: number;
  automationEnabled?: boolean;
}): Promise<OnboardingReminderSummary> {
  const notDue = () => ({ status: "not_due" as const, ...emptySummary() });
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
        if (!lockToken) return notDue();
        try {
          if (!(await migrateOnboardingWarning(redis, nowMs))) return notDue();
          return await processOnboardingWarning({
            reddit,
            redis,
            nowMs,
            automationEnabled,
            mutationLease,
          });
        } finally {
          await releaseRedisLock(
            redis,
            onboardingSubscriberGoalLockKey,
            lockToken,
            {
              event: "onboarding_reminder_cleanup_failed",
              context: {
                workflow: "onboarding_reminder",
                phase: "lock_release",
              },
            },
          );
        }
      },
    );
  } catch (error) {
    if (error instanceof CommunityGoalMutationInProgressError) return notDue();
    throw error;
  }
}

type WarningWork = {
  reddit: RedditClient;
  redis: RedisClient;
  nowMs: number;
  automationEnabled: boolean;
  mutationLease: CommunityGoalMutationLease;
};
type WarningProgress = {
  inspected: OnboardingDetectionDiagnostics;
  dispatchStarted: boolean;
};
type WarningSubreddit = Awaited<
  ReturnType<RedditClient["getCurrentSubreddit"]>
>;
type WarningGoalState = Awaited<
  ReturnType<typeof getOnboardingSubscriberGoalState>
>;
type WarningAttempt = {
  reloaded: OnboardingReminderState;
  subreddit: WarningSubreddit;
  activeGoalState: WarningGoalState;
  operationId: string;
};

async function processOnboardingWarning(
  work: WarningWork,
): Promise<OnboardingReminderSummary> {
  const { redis, nowMs, automationEnabled } = work;
  const base = emptySummary();
  await initializeOnboardingSubscriberGoal(redis, {
    nowMs,
    lifecycleSource: "recovery",
    automationEnabled,
    workflowLockHeld: true,
  });
  await scheduleOnboardingReminder(redis, {
    nowMs,
    lifecycleSource: "recovery",
    automationEnabled,
    workflowLockHeld: true,
  });
  let state = await getOnboardingReminderState(redis);
  const goal = await getOnboardingSubscriberGoalState(redis);
  if (state?.status === "complete") {
    if (goal?.status === "awaiting_warning")
      await reconcileCompletedReminder(redis, state, nowMs);
    return { status: "complete", ...base };
  }
  if (state?.status === "dispatching") {
    await settleUnknownOnboardingWarning(
      redis,
      state,
      nowMs,
      onboardingWarningDeliveryUnknownMessage,
      goal,
    );
    logDiagnostic("warn", "onboarding_modmail_delivery_unknown", {
      workflow: "onboarding_reminder",
      phase: "dispatch_recovery",
      lifecycleSource: state.lifecycleSource,
      reason: "stale_dispatch_state",
    });
    return { status: "cancelled", ...base };
  }
  if (goal?.status !== "awaiting_warning")
    return { status: "not_due", ...base };
  if (state && !automationEnabled) {
    await saveOnboardingReminderState(redis, {
      ...state,
      pausedAt: state.pausedAt ?? nowMs,
    });
    return { status: "paused", ...base };
  }
  if (state?.pausedAt !== undefined) {
    const reminderStaggerMinutes = selectOnboardingReminderStaggerMinutes();
    const { pausedAt: _pausedAt, ...unpausedState } = state;
    state = {
      ...unpausedState,
      status: "pending",
      reminderStaggerMinutes,
      nextRunAt: Math.max(
        state.nextRunAt,
        nowMs + reminderStaggerMinutes * 60 * 1000,
      ),
    };
    await saveOnboardingReminderState(redis, state);
    return { status: "not_due", ...base };
  }
  if (!state || nowMs < state.nextRunAt) {
    return {
      status: "not_due",
      ...base,
    };
  }

  const progress: WarningProgress = { inspected: base, dispatchStarted: false };
  try {
    return await runOnboardingWarning(work, progress);
  } catch (error) {
    // diagnostic-allow-silent: the failure handler logs the dispatch or retry outcome.
    return handleOnboardingWarningFailure(work, progress, state, error);
  }
}

async function runOnboardingWarning(
  work: WarningWork,
  progress: WarningProgress,
): Promise<OnboardingReminderSummary> {
  const { reddit, redis, nowMs, automationEnabled } = work;
  const base = progress.inspected;
  const reloaded = parseOnboardingReminderState(
    await readOnboardingWarningFields(redis),
  );
  if (
    !reloaded ||
    reloaded.status === "complete" ||
    nowMs < reloaded.nextRunAt
  ) {
    if (reloaded?.status === "complete") {
      await reconcileCompletedReminder(redis, reloaded, nowMs);
    }
    return {
      status: reloaded?.status === "complete" ? "complete" : "not_due",
      ...base,
    };
  }

  console.info(
    `[onboardingReminder] starting check: source=${reloaded.lifecycleSource} nextRunAt=${reloaded.nextRunAt} status=${reloaded.status}`,
  );
  await saveOnboardingReminderState(redis, {
    ...reloaded,
    status: "processing",
    startedAt: nowMs,
  });

  const subreddit = await reddit.getCurrentSubreddit();
  const activeGoalState = await getOnboardingSubscriberGoalState(redis);
  const operationId =
    activeGoalState?.operationId ?? "onboarding-reminder:" + reloaded.armedAt;
  const attempt = { reloaded, subreddit, activeGoalState, operationId };
  const ineligible = await checkWarningEligibility(work, progress, attempt);
  if (ineligible) return ineligible;
  const upgradeOnboardingIntent = isUpgradeOnboardingIntent(activeGoalState);
  const recoveryPaused = Boolean(
    upgradeOnboardingIntent && activeGoalState?.pausedForAccountRecovery,
  );
  const accountPreflight = await checkWarningUpgradeAccount(
    work,
    attempt,
    upgradeOnboardingIntent,
  );
  if (accountPreflight === "paused") return { status: "paused", ...base };
  const existing = await reconcileWarningExistingGoal(
    work,
    progress,
    attempt,
    upgradeOnboardingIntent,
  );
  if (existing) return existing;
  if (recoveryPaused && activeGoalState)
    return resumeOnboardingWarning(work, progress, reloaded, activeGoalState);
  let accountHealthVerified = accountPreflight === "healthy";
  if (!accountHealthVerified) {
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
    if (health.healthy && health.status === "healthy") {
      accountHealthVerified = true;
    }
  }
  if (!accountHealthVerified)
    return await deferWarningPrerequisite(work, progress, attempt);

  if (!automationEnabled) {
    await saveOnboardingReminderState(redis, {
      ...reloaded,
      status: "pending",
      pausedAt: nowMs,
    });
    return { status: "paused", ...progress.inspected };
  }
  return dispatchOnboardingWarning(work, progress, attempt);
}

async function checkWarningEligibility(
  work: WarningWork,
  progress: WarningProgress,
  attempt: WarningAttempt,
): Promise<OnboardingReminderSummary | undefined> {
  const { redis, nowMs } = work;
  const { reloaded, subreddit } = attempt;
  const eligibility = getOnboardingEligibility(subreddit);
  logDiagnostic("info", "onboarding_eligibility_checked", {
    workflow: "onboarding_reminder",
    phase: "eligibility",
    lifecycleSource: reloaded.lifecycleSource,
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
    )
      return await deferWarningPrerequisite(work, progress, attempt);
    await markOnboardingReminderIneligible(
      redis,
      eligibility.subscriberCount,
      nowMs,
      eligibility.reason,
      true,
    );
    console.info(
      `[onboardingReminder] complete: status=ineligible subscriberCount=${eligibility.subscriberCount} minimumSubscriberCount=${onboardingMinimumSubscriberCount} subredditType=${eligibility.subredditType} reason=${eligibility.reason} source=${reloaded.lifecycleSource}`,
    );
    return {
      status: "ineligible",
      eligibilitySubscriberCount: eligibility.subscriberCount,
      ...progress.inspected,
    };
  }

  return undefined;
}

async function checkWarningUpgradeAccount(
  { reddit, redis, nowMs }: WarningWork,
  { activeGoalState, reloaded, subreddit }: WarningAttempt,
  upgradeOnboardingIntent: boolean,
): Promise<"paused" | "healthy" | "unchecked"> {
  if (upgradeOnboardingIntent && activeGoalState) {
    const preflightHealth = await checkAppAccountHealth({
      reddit,
      redis,
      subredditName: subreddit.name,
      subredditId: subreddit.id,
      language: subreddit.language,
      notify: false,
      scheduleUnknownRetry: false,
      nowMs,
    });
    if (!preflightHealth.healthy || preflightHealth.status !== "healthy") {
      const retryAt = nowMs + 5 * 60 * 1000;
      await saveOnboardingState(
        redis,
        {
          ...activeGoalState,
          status: "awaiting_warning",
          pausedForAccountRecovery: true,
        },
        serializeOnboardingReminderState({
          ...reloaded,
          status: "pending",
          nextRunAt: retryAt,
        }),
      );
      logDiagnostic("info", "onboarding_paused_for_account_recovery", {
        workflow: "onboarding_reminder",
        phase: "permission_preflight",
        lifecycleSource: reloaded.lifecycleSource,
        sourcePostId: activeGoalState.replacementSourcePostId ?? "none",
        nextRunAt: retryAt,
      });
      return "paused";
    }
    return "healthy";
  }

  return "unchecked";
}

async function reconcileWarningExistingGoal(
  work: WarningWork,
  progress: WarningProgress,
  attempt: WarningAttempt,
  upgradeOnboardingIntent: boolean,
): Promise<OnboardingReminderSummary | undefined> {
  const { reddit, redis, nowMs, mutationLease } = work;
  const { activeGoalState, reloaded } = attempt;
  const existing = await ensureExistingSubscriberGoalHighlighted({
    reddit,
    redis,
    nowMs,
    notifyOnFailure: true,
    mutationLease,
  });
  progress.inspected = {
    registeredInspected: existing.registeredInspected ?? 0,
    trackedInspected: existing.trackedInspected ?? 0,
    queuedInspected: existing.queuedInspected ?? 0,
    persistedInspected: existing.persistedInspected ?? 0,
    highlightedInspected: existing.highlightedInspected ?? 0,
    searchInspected: existing.searchInspected ?? 0,
    recentInspected: existing.recentInspected ?? 0,
    validated: existing.validated ?? 0,
    stalePruned: existing.stalePruned ?? 0,
    failed: existing.failed ?? 0,
  };
  const completed = await reconcileWarningCompletedGoal(
    work,
    progress,
    attempt,
    upgradeOnboardingIntent,
    existing,
  );
  if (completed) return completed;
  if (
    existing.status !== "missing" &&
    existing.postId &&
    !isExpectedCompletedReplacement(activeGoalState, existing.postId)
  ) {
    const existingSource = existing.source ?? "tracked";
    await reconcileCompletedReminder(
      redis,
      {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        result:
          existing.status === "existing"
            ? "existing"
            : "existing_not_highlighted",
        postId: existing.postId,
        existingSource,
        ...(existing.errorMessage
          ? { errorMessage: existing.errorMessage }
          : {}),
      },
      nowMs,
      true,
    );
    console.info(
      `[onboardingReminder] complete: status=${existing.status} existingSource=${existingSource} postId=${existing.postId} ${formatReminderDiagnostics(progress.inspected)}`,
    );
    return {
      status: "existing",
      postId: existing.postId,
      existingSource,
      ...progress.inspected,
    };
  }

  return undefined;
}

async function reconcileWarningCompletedGoal(
  work: WarningWork,
  progress: WarningProgress,
  attempt: WarningAttempt,
  upgradeOnboardingIntent: boolean,
  existing: Awaited<ReturnType<typeof ensureExistingSubscriberGoalHighlighted>>,
): Promise<OnboardingReminderSummary | undefined> {
  const { reddit, redis, nowMs, mutationLease } = work;
  const { activeGoalState, reloaded } = attempt;
  if (
    existing.status === "completed" &&
    existing.postId &&
    existing.source &&
    upgradeOnboardingIntent &&
    !isExpectedCompletedReplacement(activeGoalState, existing.postId)
  ) {
    await reconcileCompletedReminder(
      redis,
      {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        result: "completed_no_recovery",
        postId: existing.postId,
        existingSource: existing.source,
      },
      nowMs,
      true,
    );
    return {
      status: "existing",
      postId: existing.postId,
      existingSource: existing.source,
      ...progress.inspected,
    };
  }
  if (
    existing.status === "completed" &&
    existing.postId &&
    existing.source &&
    existing.completedTime &&
    !isExpectedCompletedReplacement(activeGoalState, existing.postId)
  ) {
    const completed = await reconcileCompletedGoal({
      reddit,
      redis,
      lifecycleSource: reloaded.lifecycleSource,
      sourcePostId: existing.postId,
      completedTime: existing.completedTime,
      autoCreateNextGoal: existing.autoCreateNextGoal ?? false,
      nowMs,
      mutationLease,
    });
    const terminalPostId = completed.successorPostId ?? existing.postId;
    await reconcileCompletedReminder(
      redis,
      {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        result: completed.outcome,
        postId: terminalPostId,
        existingSource: existing.source,
      },
      nowMs,
      true,
    );
    return {
      status: "existing",
      postId: terminalPostId,
      existingSource: existing.source,
      ...progress.inspected,
    };
  }
  return undefined;
}

async function resumeOnboardingWarning(
  { redis, nowMs }: WarningWork,
  progress: WarningProgress,
  reloaded: OnboardingReminderState,
  activeGoalState: NonNullable<WarningGoalState>,
): Promise<OnboardingReminderSummary> {
  const { pausedForAccountRecovery: _paused, ...resumed } = activeGoalState;
  const creationStaggerMinutes = selectOnboardingGoalStaggerMinutes();
  const reminderStaggerMinutes = selectOnboardingReminderStaggerMinutes();
  const nextRunAt = nowMs + reminderStaggerMinutes * 60 * 1000;
  await saveOnboardingState(
    redis,
    {
      ...resumed,
      status: "awaiting_warning",
      armedAt: nowMs,
      creationStaggerMinutes,
    },
    serializeOnboardingReminderState({
      ...reloaded,
      status: "pending",
      armedAt: nowMs,
      nextRunAt,
      reminderStaggerMinutes,
    }),
  );
  logDiagnostic("info", "onboarding_resumed_after_account_recovery", {
    workflow: "onboarding_reminder",
    phase: "post_recovery_classification",
    lifecycleSource: reloaded.lifecycleSource,
    sourcePostId: activeGoalState.replacementSourcePostId ?? "none",
    nextRunAt,
    reminderStaggerMinutes,
    creationStaggerMinutes,
  });
  return { status: "not_due", ...progress.inspected };
}

async function deferWarningPrerequisite(
  { reddit, redis, nowMs }: WarningWork,
  progress: WarningProgress,
  { reloaded, activeGoalState, subreddit, operationId }: WarningAttempt,
): Promise<OnboardingReminderSummary> {
  const retry = await nextAutomaticGoalPrerequisiteRetry(
    redis,
    operationId,
    nowMs,
  );
  const warning: OnboardingReminderState = {
    ...reloaded,
    status: retry.retryAt === null ? "complete" : "pending",
    ...(retry.retryAt === null
      ? { completedAt: nowMs, result: "retry_exhausted" as const }
      : { nextRunAt: retry.retryAt }),
  };
  if (activeGoalState && activeGoalState.status !== "complete") {
    await saveOnboardingState(
      redis,
      retry.retryAt === null
        ? {
            ...activeGoalState,
            status: "complete",
            completedAt: nowMs,
            resultStatus: "retry_exhausted",
          }
        : activeGoalState,
      serializeOnboardingReminderState(warning),
    );
  } else {
    await saveOnboardingReminderState(redis, warning);
  }
  if (retry.retryAt === null) {
    await notifyAutomaticGoalExhausted({
      reddit,
      redis,
      operationId,
      unresolved: false,
      language: subreddit.language,
    });
    await resetAutomaticGoalPrerequisiteRetry(redis, operationId);
  }
  return {
    status: retry.retryAt === null ? "complete" : "not_due",
    ...progress.inspected,
  };
}

async function dispatchOnboardingWarning(
  { reddit, redis, nowMs }: WarningWork,
  progress: WarningProgress,
  { reloaded, subreddit, activeGoalState, operationId }: WarningAttempt,
): Promise<OnboardingReminderSummary> {
  // The full reconciliation above establishes the workflow decision. Read
  // Community Highlights once more at the dispatch boundary so a goal that
  // appeared during permission/state work cannot make this warning stale.
  // Any lookup failure is handled by the existing pre-dispatch retry path.
  const finalHighlightedCandidates =
    await findLiveHighlightedSubscriberGoalCandidates({
      reddit,
      redis,
      subreddit,
      nowMs,
    });
  const expectedCompletedSourcePostId =
    activeGoalState?.intent === "orphaned_completed_goal"
      ? activeGoalState.replacementSourcePostId
      : undefined;
  const unexpectedHighlightedCandidate = finalHighlightedCandidates.find(
    (candidate) => candidate.postId !== expectedCompletedSourcePostId,
  );
  if (unexpectedHighlightedCandidate) {
    logDiagnostic("info", "onboarding_modmail_suppressed", {
      workflow: "onboarding_reminder",
      phase: "final_highlight_check",
      lifecycleSource: reloaded.lifecycleSource,
      reason: "live_highlight_appeared",
      postId: unexpectedHighlightedCandidate.postId,
      classification: unexpectedHighlightedCandidate.classification,
    });
    throw new Error(
      `A highlighted Subscriber Goal appeared before warning dispatch: ${unexpectedHighlightedCandidate.postId}.`,
    );
  }

  const message = buildOnboardingReminderMessage(
    subreddit.name,
    reloaded.lifecycleSource,
    subreddit.language,
    activeGoalState?.intent,
  );
  const dispatchToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await saveOnboardingReminderState(redis, {
    ...reloaded,
    status: "dispatching",
    dispatchToken,
  });
  progress.dispatchStarted = true;
  logDiagnostic("info", "onboarding_modmail_dispatch_started", {
    workflow: "onboarding_reminder",
    phase: "modmail_dispatch",
    lifecycleSource: reloaded.lifecycleSource,
    scheduledRunAt: reloaded.nextRunAt,
    startedAt: nowMs,
    startedAtIso: new Date(nowMs).toISOString(),
  });
  await reddit.modMail.createModNotification({
    subredditId: subreddit.id,
    subject: message.subject,
    bodyMarkdown: message.bodyMarkdown,
  });
  const sentWarning = serializeOnboardingReminderState({
    ...reloaded,
    status: "complete",
    completedAt: nowMs,
    result: "sent",
    sentAt: nowMs,
  });
  const scheduledGoal = await scheduleOnboardingSubscriberGoalAfterWarning(
    redis,
    nowMs,
    true,
    sentWarning,
  );
  await resetAutomaticGoalPrerequisiteRetry(redis, operationId);
  logDiagnostic("info", "onboarding_modmail_sent", {
    workflow: "onboarding_reminder",
    phase: "modmail_sent",
    lifecycleSource: reloaded.lifecycleSource,
    sentAt: nowMs,
    sentAtIso: new Date(nowMs).toISOString(),
  });
  if (scheduledGoal) logOnboardingGoalScheduled(scheduledGoal, nowMs);
  console.info(
    `[onboardingReminder] complete: status=sent subscriberCount=${subreddit.numberOfSubscribers} source=${reloaded.lifecycleSource} ${formatReminderDiagnostics(progress.inspected)}`,
  );
  return { status: "sent", ...progress.inspected };
}

async function handleOnboardingWarningFailure(
  { redis, nowMs }: WarningWork,
  progress: WarningProgress,
  state: OnboardingReminderState,
  error: unknown,
): Promise<OnboardingReminderSummary> {
  progress.inspected =
    getDetectionDiagnosticsFromError(error) ?? progress.inspected;
  const errorMessage = String(error);
  try {
    const latest = parseOnboardingReminderState(
      await readOnboardingWarningFields(redis),
    );
    if (latest?.status === "complete") {
      return { status: "complete", ...progress.inspected };
    }
    if (
      !progress.dispatchStarted &&
      error instanceof PostTemporarilyUnavailableError
    ) {
      await saveOnboardingReminderState(redis, {
        ...(latest ?? state),
        status: "pending",
        nextRunAt: nowMs + temporarilyRemovedPostRecheckDelayMs,
        errorMessage,
      });
      logDiagnostic("info", "onboarding_reminder_post_paused", {
        workflow: "onboarding_reminder",
        phase: "post_availability",
        postId: error.postId,
        category: error.category ?? "unknown",
      });
      return { status: "not_due", ...progress.inspected };
    }
    if (progress.dispatchStarted || latest?.status === "dispatching") {
      await settleUnknownOnboardingWarning(
        redis,
        latest ?? state,
        nowMs,
        errorMessage,
        await getOnboardingSubscriberGoalState(redis),
      );
      logDiagnostic(
        "warn",
        "onboarding_modmail_delivery_unknown",
        {
          workflow: "onboarding_reminder",
          phase: "modmail_dispatch",
          lifecycleSource: (latest ?? state).lifecycleSource,
          reason: "dispatch_confirmation_failed",
        },
        error,
      );
      return { status: "cancelled", errorMessage, ...progress.inspected };
    }
    const attempts = (latest?.attempts ?? state.attempts ?? 0) + 1;
    const terminal = attempts >= onboardingMaxAttempts;
    const retryDelayMs = selectOnboardingRetryDelayMs(attempts);
    const warning: OnboardingReminderState = {
      ...(latest ?? state),
      status: terminal ? "complete" : "pending",
      ...(terminal
        ? { completedAt: nowMs }
        : { nextRunAt: nowMs + retryDelayMs }),
      attempts,
      result: terminal ? "retry_exhausted" : "failed",
      errorMessage,
    };
    if (terminal) {
      await recordWarningRetryExhaustion(redis, warning, nowMs);
    } else {
      await saveOnboardingReminderState(redis, warning);
    }
    if (!terminal)
      logDiagnostic(
        "warn",
        "onboarding_reminder_retry_scheduled",
        {
          workflow: "onboarding_reminder",
          phase: "retry",
          lifecycleSource: (latest ?? state).lifecycleSource,
          reminderStaggerMinutes: (latest ?? state).reminderStaggerMinutes,
          attempts,
          nextRunAt: nowMs + retryDelayMs,
        },
        error,
      );
  } catch (stateError) {
    logDiagnostic(
      "error",
      "onboarding_reminder_failed",
      { workflow: "onboarding_reminder", phase: "failure_persistence" },
      stateError,
    );
  }
  logDiagnostic(
    "error",
    "onboarding_reminder_failed",
    { workflow: "onboarding_reminder", phase: "execution" },
    error,
  );
  return { status: "failed", errorMessage, ...progress.inspected };
}

async function recordWarningRetryExhaustion(
  redis: RedisClient,
  warning: OnboardingReminderState,
  nowMs: number,
): Promise<void> {
  const goal = await getOnboardingSubscriberGoalState(redis);
  if (goal?.status !== "awaiting_warning") {
    await saveOnboardingReminderState(redis, warning);
    return;
  }
  await saveOnboardingState(
    redis,
    {
      ...goal,
      status: "complete",
      completedAt: nowMs,
      resultStatus: "retry_exhausted",
    },
    serializeOnboardingReminderState(warning),
  );
}

async function settleUnknownOnboardingWarning(
  redis: RedisClient,
  state: OnboardingReminderState,
  nowMs: number,
  errorMessage: string,
  goal: WarningGoalState,
): Promise<void> {
  const warning: OnboardingReminderState = {
    ...state,
    status: "complete",
    completedAt: nowMs,
    result: "delivery_unknown",
    errorMessage,
  };
  if (goal?.status === "awaiting_warning") {
    await markOnboardingSubscriberGoalCancelled(
      redis,
      "delivery_unknown",
      nowMs,
      errorMessage,
      true,
      serializeOnboardingReminderState(warning),
    );
    return;
  }
  await saveOnboardingReminderState(redis, warning);
}

function formatReminderDiagnostics(
  diagnostics: OnboardingDetectionDiagnostics,
): string {
  return `registeredInspected=${diagnostics.registeredInspected} trackedInspected=${diagnostics.trackedInspected} queuedInspected=${diagnostics.queuedInspected} persistedInspected=${diagnostics.persistedInspected} highlightedInspected=${diagnostics.highlightedInspected} searchInspected=${diagnostics.searchInspected} recentInspected=${diagnostics.recentInspected} validated=${diagnostics.validated} stalePruned=${diagnostics.stalePruned} failed=${diagnostics.failed}`;
}

async function reconcileCompletedReminder(
  redis: RedisClient,
  state: OnboardingReminderState,
  nowMs: number,
  persistWarning = false,
): Promise<void> {
  const warning = persistWarning
    ? serializeOnboardingReminderState(state)
    : undefined;
  if (state.result === "sent" && state.sentAt !== undefined) {
    await scheduleOnboardingSubscriberGoalAfterWarning(
      redis,
      state.sentAt,
      true,
      warning,
    );
  } else if (
    (state.result === "existing" ||
      state.result === "existing_not_highlighted") &&
    state.postId &&
    state.existingSource
  ) {
    if (state.result === "existing") {
      await markOnboardingSubscriberGoalExisting(
        redis,
        state.postId,
        state.existingSource,
        state.completedAt ?? nowMs,
        true,
        warning,
      );
    } else {
      await markOnboardingSubscriberGoalExistingNotHighlighted(
        redis,
        state.postId,
        state.existingSource,
        state.completedAt ?? nowMs,
        state.errorMessage,
        true,
        warning,
      );
    }
  } else if (
    state.result === "ineligible" &&
    state.eligibilitySubscriberCount !== undefined
  ) {
    await markOnboardingSubscriberGoalIneligible(
      redis,
      state.eligibilitySubscriberCount,
      state.completedAt ?? nowMs,
      state.ineligibilityReason,
      true,
      warning,
    );
  } else if (
    state.result === "cancelled_permission" ||
    state.result === "delivery_unknown"
  ) {
    await markOnboardingSubscriberGoalCancelled(
      redis,
      state.result,
      state.completedAt ?? nowMs,
      state.errorMessage,
      true,
      warning,
    );
  } else if (
    isCompletedGoalDisposition(state.result) &&
    state.postId &&
    state.existingSource
  ) {
    await markOnboardingSubscriberGoalCompleted(
      redis,
      state.postId,
      state.existingSource,
      state.result,
      state.completedAt ?? nowMs,
      true,
      warning,
    );
  } else if (state.result === "retry_exhausted") {
    await recordWarningRetryExhaustion(
      redis,
      state,
      state.completedAt ?? nowMs,
    );
  } else if (persistWarning) {
    await saveOnboardingReminderState(redis, state);
  }
}

const completedGoalDispositions = new Set<OnboardingReminderResult>([
  "completed_no_recovery",
  "completed_auto_disabled",
  "replacement_scheduled",
  "replacement_created",
  "replacement_retrying",
  "replacement_exhausted",
]);

function isCompletedGoalDisposition(
  result: OnboardingReminderResult | undefined,
): result is CompletedGoalReconciliationOutcome {
  return result !== undefined && completedGoalDispositions.has(result);
}

export function parseOnboardingReminderState(
  raw: Record<string, string>,
): OnboardingReminderState | undefined {
  const nextRunAt = Number(raw.nextRunAt);
  const armedAt = Number(raw.armedAt);
  const reminderStaggerMinutes = Number(raw.reminderStaggerMinutes);
  if (
    raw.version !== onboardingReminderVersion ||
    !["pending", "processing", "dispatching", "complete"].includes(
      raw.status ?? "",
    ) ||
    !Number.isFinite(nextRunAt) ||
    !Number.isFinite(armedAt) ||
    !Number.isInteger(reminderStaggerMinutes) ||
    reminderStaggerMinutes < 0
  ) {
    return undefined;
  }
  return {
    version: onboardingReminderVersion,
    status: raw.status as OnboardingReminderStatus,
    nextRunAt,
    armedAt,
    lifecycleSource:
      raw.lifecycleSource === "install" ||
      raw.lifecycleSource === "upgrade" ||
      raw.lifecycleSource === "recovery"
        ? raw.lifecycleSource
        : "unknown",
    reminderStaggerMinutes,
    ...parseWarningLegacyMetadata(raw),
    ...(raw.postId ? { postId: raw.postId } : {}),
    ...(isExistingSource(raw.existingSource)
      ? { existingSource: raw.existingSource }
      : {}),
    ...(isResult(raw.result) ? { result: raw.result } : {}),
    ...(raw.errorMessage ? { errorMessage: raw.errorMessage } : {}),
    ...(raw.eligibilitySubscriberCount &&
    Number.isFinite(Number(raw.eligibilitySubscriberCount))
      ? { eligibilitySubscriberCount: Number(raw.eligibilitySubscriberCount) }
      : {}),
    ...(isOnboardingIneligibilityReason(raw.ineligibilityReason)
      ? { ineligibilityReason: raw.ineligibilityReason }
      : {}),
    ...(raw.attempts && Number.isFinite(Number(raw.attempts))
      ? { attempts: Number(raw.attempts) }
      : {}),
    ...(raw.pausedAt && Number.isFinite(Number(raw.pausedAt))
      ? { pausedAt: Number(raw.pausedAt) }
      : {}),
    ...(raw.dispatchToken ? { dispatchToken: raw.dispatchToken } : {}),
  };
}

function parseWarningLegacyMetadata(
  raw: Record<string, string>,
): Partial<OnboardingReminderState> {
  return {
    ...(raw.sentAt && Number.isFinite(Number(raw.sentAt))
      ? { sentAt: Number(raw.sentAt) }
      : {}),
    ...(raw.migratedFromVersion
      ? { migratedFromVersion: raw.migratedFromVersion }
      : {}),
    ...(raw.legacyAttempts && Number.isFinite(Number(raw.legacyAttempts))
      ? { legacyAttempts: Number(raw.legacyAttempts) }
      : {}),
    ...(raw.startedAt && Number.isFinite(Number(raw.startedAt))
      ? { startedAt: Number(raw.startedAt) }
      : {}),
    ...(raw.completedAt && Number.isFinite(Number(raw.completedAt))
      ? { completedAt: Number(raw.completedAt) }
      : {}),
  };
}

function isExistingSource(
  value: string | undefined,
): value is OnboardingExistingSource {
  return (
    value === "registered" ||
    value === "tracked" ||
    value === "queued" ||
    value === "persisted" ||
    value === "highlighted" ||
    value === "search" ||
    value === "recent"
  );
}

function isResult(
  value: string | undefined,
): value is OnboardingReminderResult {
  return (
    value === "sent" ||
    value === "existing" ||
    value === "existing_not_highlighted" ||
    value === "ineligible" ||
    value === "failed" ||
    value === "cancelled_permission" ||
    value === "delivery_unknown" ||
    value === "retry_exhausted" ||
    value === "replacement_scheduled" ||
    value === "replacement_created" ||
    value === "replacement_retrying" ||
    value === "replacement_exhausted" ||
    value === "completed_auto_disabled" ||
    value === "completed_no_recovery"
  );
}

export function serializeOnboardingReminderState(
  state: OnboardingReminderState,
): Record<string, string> {
  return {
    version: state.version,
    status: state.status,
    nextRunAt: String(state.nextRunAt),
    armedAt: String(state.armedAt),
    lifecycleSource: state.lifecycleSource,
    reminderStaggerMinutes: String(state.reminderStaggerMinutes),
    sentAt: String(state.sentAt ?? ""),
    migratedFromVersion: state.migratedFromVersion ?? "",
    legacyAttempts: String(state.legacyAttempts ?? ""),
    eligibilitySubscriberCount: String(state.eligibilitySubscriberCount ?? ""),
    ineligibilityReason: state.ineligibilityReason ?? "",
    startedAt: String(state.startedAt ?? 0),
    completedAt: String(state.completedAt ?? 0),
    postId: state.postId ?? "",
    existingSource: state.existingSource ?? "",
    result: state.result ?? "",
    errorMessage: state.errorMessage ?? "",
    attempts: String(state.attempts ?? 0),
    pausedAt: String(state.pausedAt ?? ""),
    dispatchToken: state.dispatchToken ?? "",
  };
}

export async function saveOnboardingReminderState(
  redis: RedisClient,
  state: OnboardingReminderState,
): Promise<void> {
  await redis.hSet(
    onboardingSubscriberGoalStateKey,
    onboardingWarningFields(serializeOnboardingReminderState(state)),
  );
}
