import type { RedditClient, RedisClient } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";
import {
  AUTOMATIC_ONBOARDING_ENABLED,
  findExistingSubscriberGoal,
  getOnboardingEligibility,
  getOnboardingSubscriberGoalState,
  getDetectionDiagnosticsFromError,
  initializeOnboardingSubscriberGoal,
  markOnboardingSubscriberGoalExisting,
  markOnboardingSubscriberGoalIneligible,
  markOnboardingSubscriberGoalCancelled,
  onboardingMaxAttempts,
  onboardingMinimumSubscriberCount,
  scheduleOnboardingSubscriberGoalAfterWarning,
  selectOnboardingRetryDelayMs,
  type OnboardingDetectionDiagnostics,
  type OnboardingExistingSource,
  type OnboardingLifecycleSource,
} from "./onboardingSubscriberGoal";
import { checkAppAccountHealth } from "./appAccountHealth";
import {
  onboardingGoalBaseDelayMs,
  onboardingGoalStaggerMaxMinutes,
  onboardingReminderStaggerMaxMinutes,
  onboardingReminderStaggerMinMinutes,
} from "./onboardingConfig";

export {
  onboardingReminderStaggerMaxMinutes,
  onboardingReminderStaggerMinMinutes,
} from "./onboardingConfig";

export const onboardingReminderStateKey = "onboarding_reminder_v3_state";
export const onboardingReminderLockKey = "onboarding_reminder_v3_lock";
export const onboardingReminderInitializationLockKey =
  "onboarding_reminder_v3_init_lock";
export const onboardingReminderVersion = "onboarding_reminder_v3";
export const onboardingReminderDelayMs =
  onboardingReminderStaggerMinMinutes * 60 * 1000;

type OnboardingReminderStatus =
  | "pending"
  | "processing"
  | "dispatching"
  | "complete";
type OnboardingReminderResult =
  | "sent"
  | "existing"
  | "ineligible"
  | "failed"
  | "cancelled_permission"
  | "delivery_unknown"
  | "retry_exhausted";

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
  pinnedInspected: 0,
  searchInspected: 0,
  recentInspected: 0,
  validated: 0,
  stalePruned: 0,
  failed: 0,
});

export function buildOnboardingReminderMessage(
  subredditName: string,
  lifecycleSource: OnboardingLifecycleSource = "install",
): OnboardingReminderMessage {
  const isUpgrade = lifecycleSource === "upgrade";
  const automaticCreationNotice =
    `If a pinned Subscriber Goal does not already exist, the ${formatDelay(onboardingGoalBaseDelayMs)} countdown begins when this message is sent. ` +
    `If this community remains eligible and Subscriber Goal retains Manage Posts permission, the app will attempt to create and pin a goal during the following ${onboardingGoalStaggerMaxMinutes.toLocaleString("en-US")} minutes.`;
  return {
    subject: isUpgrade
      ? `Subscriber Goal automatic goal update for r/${subredditName}`
      : `Welcome to Subscriber Goal in r/${subredditName}`,
    bodyMarkdown:
      (isUpgrade
        ? `Subscriber Goal has been updated in r/${subredditName}.\n\n`
        : `Welcome to Subscriber Goal for r/${subredditName}!\n\n`) +
      "You can find more information about creating a Subscriber Goal at https://developers.reddit.com/apps/subscriber-goal.\n\n" +
      "If you have questions, please send a DM to u/Alan-Foster.\n\n" +
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
  }: {
    lifecycleSource?: OnboardingLifecycleSource;
    nowMs?: number;
    migrationOnly?: boolean;
    automationEnabled?: boolean;
  },
): Promise<void> {
  void migrationOnly;
  if (!automationEnabled) return;
  const lockToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(onboardingReminderInitializationLockKey, lockToken, {
    nx: true,
    expiration: new Date(nowMs + 60 * 1000),
  });
  if ((await redis.get(onboardingReminderInitializationLockKey)) !== lockToken)
    return;
  try {
    const rawState = await redis.hGetAll(onboardingReminderStateKey);
    const existing = parseOnboardingReminderState(rawState);
    if (existing) return;
    if (Object.keys(rawState).length > 0) return;
    const goalState = await getOnboardingSubscriberGoalState(redis);
    if (goalState?.status !== "awaiting_warning") return;
    const reminderStaggerMinutes = selectOnboardingReminderStaggerMinutes();
    const state: OnboardingReminderState = {
      version: onboardingReminderVersion,
      status: "pending",
      armedAt: goalState?.armedAt ?? nowMs,
      nextRunAt: nowMs + reminderStaggerMinutes * 60 * 1000,
      lifecycleSource: goalState?.lifecycleSource ?? lifecycleSource,
      reminderStaggerMinutes,
      ...(goalState?.migratedFromVersion
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
  } finally {
    if (
      (await redis.get(onboardingReminderInitializationLockKey)) === lockToken
    )
      await redis.del(onboardingReminderInitializationLockKey);
  }
}

export async function markOnboardingReminderIneligible(
  redis: RedisClient,
  subscriberCount: number,
  nowMs = Date.now(),
): Promise<void> {
  const state = parseOnboardingReminderState(
    await redis.hGetAll(onboardingReminderStateKey),
  );
  if (!state || state.status === "complete") return;
  await saveOnboardingReminderState(redis, {
    ...state,
    status: "complete",
    completedAt: nowMs,
    result: "ineligible",
    eligibilitySubscriberCount: subscriberCount,
  });
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
  const base = emptySummary();
  await initializeOnboardingSubscriberGoal(redis, {
    nowMs,
    lifecycleSource: "recovery",
    automationEnabled,
  });
  await scheduleOnboardingReminder(redis, {
    nowMs,
    lifecycleSource: "recovery",
    automationEnabled,
  });
  let state = parseOnboardingReminderState(
    await redis.hGetAll(onboardingReminderStateKey),
  );
  if (state?.status === "complete") {
    await reconcileCompletedReminder(redis, state, nowMs);
    return { status: "complete", ...base };
  }
  if (state?.status === "dispatching") {
    await saveOnboardingReminderState(redis, {
      ...state,
      status: "complete",
      completedAt: nowMs,
      result: "delivery_unknown",
      errorMessage: "A previous modmail dispatch could not be confirmed.",
    });
    await markOnboardingSubscriberGoalCancelled(
      redis,
      "delivery_unknown",
      nowMs,
      "A previous modmail dispatch could not be confirmed.",
    );
    logDiagnostic("warn", "onboarding_modmail_delivery_unknown", {
      workflow: "onboarding_reminder",
      phase: "dispatch_recovery",
      lifecycleSource: state.lifecycleSource,
      reason: "stale_dispatch_state",
    });
    return { status: "cancelled", ...base };
  }
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

  const lockToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(onboardingReminderLockKey, lockToken, {
    nx: true,
    expiration: new Date(nowMs + 5 * 60 * 1000),
  });
  if ((await redis.get(onboardingReminderLockKey)) !== lockToken) {
    return { status: "not_due", ...base };
  }

  let inspected = base;
  let dispatchStarted = false;
  try {
    const reloaded = parseOnboardingReminderState(
      await redis.hGetAll(onboardingReminderStateKey),
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
      await markOnboardingReminderIneligible(
        redis,
        eligibility.subscriberCount,
        nowMs,
      );
      await markOnboardingSubscriberGoalIneligible(
        redis,
        eligibility.subscriberCount,
        nowMs,
      );
      console.info(
        `[onboardingReminder] complete: status=ineligible subscriberCount=${eligibility.subscriberCount} minimumSubscriberCount=${onboardingMinimumSubscriberCount} subredditType=${eligibility.subredditType} reason=${eligibility.reason} source=${reloaded.lifecycleSource}`,
      );
      return {
        status: "ineligible",
        eligibilitySubscriberCount: eligibility.subscriberCount,
        ...base,
      };
    }

    const existing = await findExistingSubscriberGoal(reddit, redis, nowMs);
    inspected = {
      registeredInspected: existing.registeredInspected ?? 0,
      trackedInspected: existing.trackedInspected ?? 0,
      queuedInspected: existing.queuedInspected ?? 0,
      persistedInspected: existing.persistedInspected ?? 0,
      pinnedInspected: existing.pinnedInspected ?? 0,
      searchInspected: existing.searchInspected ?? 0,
      recentInspected: existing.recentInspected ?? 0,
      validated: existing.validated ?? 0,
      stalePruned: existing.stalePruned ?? 0,
      failed: existing.failed ?? 0,
    };
    if (existing.postId) {
      const existingSource = existing.source ?? "tracked";
      await saveOnboardingReminderState(redis, {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        result: "existing",
        postId: existing.postId,
        existingSource,
      });
      await markOnboardingSubscriberGoalExisting(
        redis,
        existing.postId,
        existingSource,
        nowMs,
      );
      console.info(
        `[onboardingReminder] complete: status=existing existingSource=${existingSource} postId=${existing.postId} ${formatReminderDiagnostics(inspected)}`,
      );
      return {
        status: "existing",
        postId: existing.postId,
        existingSource,
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
      await saveOnboardingReminderState(redis, {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        result: "cancelled_permission",
        errorMessage,
      });
      await markOnboardingSubscriberGoalCancelled(
        redis,
        "cancelled_permission",
        nowMs,
        errorMessage,
      );
      logDiagnostic("warn", "onboarding_reminder_cancelled", {
        workflow: "onboarding_reminder",
        phase: "permission_check",
        lifecycleSource: reloaded.lifecycleSource,
        reason: "manage_posts_permission",
      });
      return { status: "cancelled", errorMessage, ...inspected };
    }

    if (!automationEnabled) {
      await saveOnboardingReminderState(redis, {
        ...reloaded,
        status: "pending",
        pausedAt: nowMs,
      });
      return { status: "paused", ...inspected };
    }

    const message = buildOnboardingReminderMessage(
      subreddit.name,
      reloaded.lifecycleSource,
    );
    const dispatchToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
    await saveOnboardingReminderState(redis, {
      ...reloaded,
      status: "dispatching",
      dispatchToken,
    });
    dispatchStarted = true;
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
    await saveOnboardingReminderState(redis, {
      ...reloaded,
      status: "complete",
      completedAt: nowMs,
      result: "sent",
      sentAt: nowMs,
    });
    logDiagnostic("info", "onboarding_modmail_sent", {
      workflow: "onboarding_reminder",
      phase: "modmail_sent",
      lifecycleSource: reloaded.lifecycleSource,
      sentAt: nowMs,
      sentAtIso: new Date(nowMs).toISOString(),
    });
    try {
      await scheduleOnboardingSubscriberGoalAfterWarning(redis, nowMs);
    } catch (error) {
      logDiagnostic(
        "warn",
        "onboarding_goal_warning_reconciliation_failed",
        { workflow: "onboarding_reminder", phase: "goal_schedule" },
        error,
      );
    }
    console.info(
      `[onboardingReminder] complete: status=sent subscriberCount=${subreddit.numberOfSubscribers} source=${reloaded.lifecycleSource} ${formatReminderDiagnostics(inspected)}`,
    );
    return { status: "sent", ...inspected };
  } catch (error) {
    inspected = getDetectionDiagnosticsFromError(error) ?? inspected;
    const errorMessage = String(error);
    try {
      const latest = parseOnboardingReminderState(
        await redis.hGetAll(onboardingReminderStateKey),
      );
      if (latest?.status === "complete") {
        return { status: "complete", ...inspected };
      }
      if (dispatchStarted || latest?.status === "dispatching") {
        await saveOnboardingReminderState(redis, {
          ...(latest ?? state),
          status: "complete",
          completedAt: nowMs,
          result: "delivery_unknown",
          errorMessage,
        });
        await markOnboardingSubscriberGoalCancelled(
          redis,
          "delivery_unknown",
          nowMs,
          errorMessage,
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
        return { status: "cancelled", errorMessage, ...inspected };
      }
      const attempts = (latest?.attempts ?? state.attempts ?? 0) + 1;
      const terminal = attempts >= onboardingMaxAttempts;
      const retryDelayMs = selectOnboardingRetryDelayMs(attempts);
      await saveOnboardingReminderState(redis, {
        ...(latest ?? state),
        status: terminal ? "complete" : "pending",
        ...(terminal
          ? { completedAt: nowMs }
          : { nextRunAt: nowMs + retryDelayMs }),
        attempts,
        result: terminal ? "retry_exhausted" : "failed",
        errorMessage,
      });
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
    return { status: "failed", errorMessage, ...inspected };
  } finally {
    try {
      if ((await redis.get(onboardingReminderLockKey)) === lockToken) {
        await redis.del(onboardingReminderLockKey);
      }
    } catch (error) {
      logDiagnostic(
        "warn",
        "onboarding_reminder_cleanup_failed",
        { workflow: "onboarding_reminder", phase: "lock_release" },
        error,
      );
    }
  }
}

function formatReminderDiagnostics(
  diagnostics: OnboardingDetectionDiagnostics,
): string {
  return `registeredInspected=${diagnostics.registeredInspected} trackedInspected=${diagnostics.trackedInspected} queuedInspected=${diagnostics.queuedInspected} persistedInspected=${diagnostics.persistedInspected} pinnedInspected=${diagnostics.pinnedInspected} searchInspected=${diagnostics.searchInspected} recentInspected=${diagnostics.recentInspected} validated=${diagnostics.validated} stalePruned=${diagnostics.stalePruned} failed=${diagnostics.failed}`;
}

async function reconcileCompletedReminder(
  redis: RedisClient,
  state: OnboardingReminderState,
  nowMs: number,
): Promise<void> {
  if (state.result === "sent" && state.sentAt !== undefined) {
    await scheduleOnboardingSubscriberGoalAfterWarning(redis, state.sentAt);
  } else if (
    state.result === "existing" &&
    state.postId &&
    state.existingSource
  ) {
    await markOnboardingSubscriberGoalExisting(
      redis,
      state.postId,
      state.existingSource,
      state.completedAt ?? nowMs,
    );
  } else if (
    state.result === "ineligible" &&
    state.eligibilitySubscriberCount !== undefined
  ) {
    await markOnboardingSubscriberGoalIneligible(
      redis,
      state.eligibilitySubscriberCount,
      state.completedAt ?? nowMs,
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
    );
  }
}

function parseOnboardingReminderState(
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
    ...(raw.attempts && Number.isFinite(Number(raw.attempts))
      ? { attempts: Number(raw.attempts) }
      : {}),
    ...(raw.pausedAt && Number.isFinite(Number(raw.pausedAt))
      ? { pausedAt: Number(raw.pausedAt) }
      : {}),
    ...(raw.dispatchToken ? { dispatchToken: raw.dispatchToken } : {}),
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
    value === "pinned" ||
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
    value === "ineligible" ||
    value === "failed" ||
    value === "cancelled_permission" ||
    value === "delivery_unknown" ||
    value === "retry_exhausted"
  );
}

function serializeOnboardingReminderState(
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

async function saveOnboardingReminderState(
  redis: RedisClient,
  state: OnboardingReminderState,
): Promise<void> {
  await redis.hSet(
    onboardingReminderStateKey,
    serializeOnboardingReminderState(state),
  );
}
