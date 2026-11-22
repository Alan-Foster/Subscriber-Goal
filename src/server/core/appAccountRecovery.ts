import {
  appAccountRecoveryStateKey,
  isTerminalRecoveryStatus,
  updateRecoveryState,
} from "./appAccountRecoveryState";
export { appAccountRecoveryStateKey } from "./appAccountRecoveryState";
import { logDiagnostic } from "../../shared/diagnostics";
import { translate } from "../../shared/i18n/catalog";
import type { RedditClient, RedisClient } from "../types";
import {
  acceptModeratorInvite,
  ModeratorInviteRejectedError,
} from "../utils/moderatorInviteApi";
import { isPrivateSubredditAccessError } from "../utils/redditPermissionErrors";
import {
  appAccountHealthRetryStateKey,
  checkAppAccountHealth,
  subscriberGoalAppUsername,
} from "./appAccountHealth";
import { acquireRedisLock, releaseRedisLock } from "../utils/redisOwnedLock";

export const appAccountInstallationStateKey =
  "app_account_recovery_v1_installation";
export const appAccountRecoveryLockKey = "app_account_recovery_v1_lock";
export const appAccountRecoveryEventKeyPrefix = "app_account_recovery_v1_event";
export const appAccountRecoveryJobName = "app-account-recovery-job";
export const appAccountRecoveryDelayMs = 60_000;
export const appAccountRecoveryMaxAttempts = 2;

const notificationKeyPrefix = "app_account_recovery_v1_notification";
const notificationRetentionMs = 90 * 24 * 60 * 60 * 1000;
const eventClaimTtlMs = 5 * 60 * 1000;

export type AppAccountRecoveryReason =
  "install" | "upgrade" | "removal" | "reinvite";

export type AppAccountRecoveryJobData = {
  incidentToken: string;
};

type SchedulerLike = {
  runJob(options: {
    name: string;
    runAt: Date;
    data: AppAccountRecoveryJobData;
  }): Promise<string>;
};

type RecoveryStatus =
  | "pending"
  | "processing"
  | "healthy"
  | "missing"
  | "insufficient_permissions"
  | "acceptance_failed"
  | "verification_failed"
  | "exhausted";

export type AppAccountRecoveryResult = {
  status: RecoveryStatus | "not_due" | "stale" | "locked";
  incidentToken?: string;
};

type ModeratorInspection = {
  status:
    | "healthy"
    | "missing"
    | "insufficient_permissions"
    | "inaccessible"
    | "unknown";
  permissions: string[];
  error?: string;
};

const normalizeUsername = (value: string | undefined): string | undefined => {
  const normalized = value?.trim().replace(/^u\//i, "");
  return normalized || undefined;
};

export function buildModeratorRemovalMessage(
  moderatorName: string,
  subredditName: string,
): { subject: string; text: string } {
  const installationUrl = `https://developers.reddit.com/r/${subredditName}/apps/subscriber-goal`;
  return {
    subject: translate(undefined, "outbound.health.removalSubject"),
    text: translate(undefined, "outbound.health.removalBody", {
      moderatorName,
      subredditName,
      installationUrl,
    }),
  };
}

export async function recordLifecycleAndScheduleRecovery({
  redis,
  scheduler,
  lifecycleSource,
  subredditName,
  subredditId,
  language,
  installerUsername,
  nowMs = Date.now(),
}: {
  redis: RedisClient;
  scheduler: SchedulerLike;
  lifecycleSource: "install" | "upgrade";
  subredditName: string;
  subredditId?: string;
  language?: unknown;
  installerUsername?: string;
  nowMs?: number;
}): Promise<string> {
  const installation = await redis.hGetAll(appAccountInstallationStateKey);
  const activeRecovery = await redis.hGetAll(appAccountRecoveryStateKey);
  const latestLifecycleAt = Number(installation.latestLifecycleAt);
  const duplicateInstallDelivery =
    lifecycleSource === "install" &&
    activeRecovery.reason === "install" &&
    (activeRecovery.status === "pending" ||
      activeRecovery.status === "processing") &&
    activeRecovery.subredditName?.toLowerCase() ===
      subredditName.toLowerCase() &&
    Number.isFinite(latestLifecycleAt) &&
    nowMs - latestLifecycleAt <= eventClaimTtlMs;
  const installedAt =
    lifecycleSource === "install"
      ? duplicateInstallDelivery
        ? Number(installation.installedAt) || nowMs
        : nowMs
      : Number(installation.installedAt) || nowMs - appAccountRecoveryDelayMs;
  await redis.hSet(appAccountInstallationStateKey, {
    installedAt: String(installedAt),
    latestLifecycleAt: String(nowMs),
    latestLifecycleSource: lifecycleSource,
    ...(normalizeUsername(installerUsername)
      ? { installerUsername: normalizeUsername(installerUsername)! }
      : {}),
  });
  return scheduleAppAccountRecovery({
    redis,
    scheduler,
    reason: lifecycleSource,
    subredditName,
    ...(subredditId ? { subredditId } : {}),
    ...(typeof language === "string" ? { language } : {}),
    nowMs,
    dueAtMs: nowMs + appAccountRecoveryDelayMs,
    forceNewIncident:
      lifecycleSource === "install" && !duplicateInstallDelivery,
  });
}

export async function scheduleAppAccountRecovery({
  redis,
  scheduler,
  reason,
  subredditName,
  subredditId,
  language,
  removedBy,
  actionedAt,
  forceNewIncident = false,
  nowMs = Date.now(),
  dueAtMs = nowMs + appAccountRecoveryDelayMs,
}: {
  redis: RedisClient;
  scheduler: SchedulerLike;
  reason: AppAccountRecoveryReason;
  subredditName: string;
  subredditId?: string;
  language?: unknown;
  removedBy?: string;
  actionedAt?: string;
  forceNewIncident?: boolean;
  nowMs?: number;
  dueAtMs?: number;
}): Promise<string> {
  const normalizedRemovedBy = normalizeUsername(removedBy);
  const current = await redis.hGetAll(appAccountRecoveryStateKey);
  const preserveRemoval =
    reason === "upgrade" &&
    current.reason === "removal" &&
    (current.status === "pending" || current.status === "processing");
  if (
    current.incidentToken &&
    (preserveRemoval ||
      isDuplicateRecovery(current, {
        reason,
        subredditName,
        normalizedRemovedBy,
        actionedAt,
        forceNewIncident,
      }))
  ) {
    if (!current.schedulerJobId && current.status === "pending") {
      const jobId = await scheduler.runJob({
        name: appAccountRecoveryJobName,
        runAt: new Date(Number(current.dueAt) || dueAtMs),
        data: { incidentToken: current.incidentToken },
      });
      await redis.hSet(appAccountRecoveryStateKey, { schedulerJobId: jobId });
    }
    return current.incidentToken;
  }

  const incidentToken = crypto.randomUUID();
  await redis.del(appAccountHealthRetryStateKey);
  await redis.hSet(appAccountRecoveryStateKey, {
    status: "pending",
    incidentToken,
    reason,
    subredditName,
    subredditId: subredditId ?? "",
    language: typeof language === "string" ? language : "",
    removedBy: normalizedRemovedBy ?? "",
    actionedAt: actionedAt ?? "",
    createdAt: String(nowMs),
    dueAt: String(dueAtMs),
    attempts: "0",
    schedulerJobId: "",
    lastError: "",
    invitationAcceptedAt: "",
    verificationToken: "",
    verificationAttempts: "0",
    nextVerificationAt: "",
    notification: normalizedRemovedBy ? "pending" : "unavailable",
  });
  const jobId = await scheduler.runJob({
    name: appAccountRecoveryJobName,
    runAt: new Date(dueAtMs),
    data: { incidentToken },
  });
  await redis.hSet(appAccountRecoveryStateKey, { schedulerJobId: jobId });
  return incidentToken;
}

function isDuplicateRecovery(
  current: Record<string, string>,
  {
    reason,
    subredditName,
    normalizedRemovedBy,
    actionedAt,
    forceNewIncident,
  }: {
    reason: AppAccountRecoveryReason;
    subredditName: string;
    normalizedRemovedBy: string | undefined;
    actionedAt: string | undefined;
    forceNewIncident: boolean;
  },
): boolean {
  return (
    !forceNewIncident &&
    (current.status === "pending" || current.status === "processing") &&
    current.reason === reason &&
    current.subredditName?.toLowerCase() === subredditName.toLowerCase() &&
    (reason !== "removal" ||
      current.removedBy?.toLowerCase() ===
        normalizedRemovedBy?.toLowerCase()) &&
    (!actionedAt || !current.actionedAt || current.actionedAt === actionedAt)
  );
}

type ModeratorActionOptions = {
  reddit: RedditClient;
  redis: RedisClient;
  scheduler: SchedulerLike;
  action: string;
  moderatorName?: string;
  actionedAt?: string;
  subredditName: string;
  subredditId?: string;
  language?: unknown;
  nowMs?: number;
  acceptInvite?: (subredditName: string) => Promise<void>;
};

type ModeratorInviteEvent = {
  reddit: RedditClient;
  redis: RedisClient;
  scheduler: SchedulerLike;
  subredditName: string;
  subredditId: string | undefined;
  language: unknown;
  nowMs: number;
  acceptInvite: (subredditName: string) => Promise<void>;
  eventClaim: ModeratorEventClaim | undefined;
};

export async function handleAppAccountModeratorAction({
  reddit,
  redis,
  scheduler,
  action,
  moderatorName,
  actionedAt,
  subredditName,
  subredditId,
  language,
  nowMs = Date.now(),
  acceptInvite = acceptModeratorInvite,
}: ModeratorActionOptions): Promise<AppAccountRecoveryResult | undefined> {
  const eventClaim = actionedAt
    ? await claimModeratorEvent(
        redis,
        action,
        subredditName,
        moderatorName,
        actionedAt,
        nowMs,
      )
    : undefined;
  if (actionedAt && !eventClaim) {
    const state = await redis.hGetAll(appAccountRecoveryStateKey);
    return state.incidentToken
      ? {
          status: toRecoveryResultStatus(state.status),
          incidentToken: state.incidentToken,
        }
      : { status: "stale" };
  }

  if (action === "removemoderator") {
    const incidentToken = await scheduleAppAccountRecovery({
      redis,
      scheduler,
      reason: "removal",
      subredditName,
      ...(subredditId ? { subredditId } : {}),
      ...(typeof language === "string" ? { language } : {}),
      ...(moderatorName ? { removedBy: moderatorName } : {}),
      ...(actionedAt ? { actionedAt } : {}),
      nowMs,
    });
    await completeModeratorEvent(redis, eventClaim, incidentToken, nowMs);
    return { status: "pending", incidentToken };
  }

  if (action === "invitemoderator") {
    return handleModeratorInviteEvent({
      reddit,
      redis,
      scheduler,
      subredditName,
      subredditId,
      language,
      nowMs,
      acceptInvite,
      eventClaim,
    });
  }

  await checkAppAccountHealth({
    reddit,
    redis,
    subredditName,
    ...(subredditId ? { subredditId } : {}),
    ...(typeof language === "string" ? { language } : {}),
  });
  await completeModeratorEvent(redis, eventClaim, "handled", nowMs);
  return undefined;
}

async function handleModeratorInviteEvent(
  event: ModeratorInviteEvent,
): Promise<AppAccountRecoveryResult> {
  const {
    reddit,
    redis,
    scheduler,
    subredditName,
    subredditId,
    language,
    nowMs,
    acceptInvite,
    eventClaim,
  } = event;
  const installation = await redis.hGetAll(appAccountInstallationStateKey);
  const installedAt = Number(installation.installedAt);
  if (Number.isFinite(installedAt) && nowMs < installedAt + 60_000) {
    await completeModeratorEvent(redis, eventClaim, "handled", nowMs);
    return { status: "not_due" };
  }
  const activeRecovery = await redis.hGetAll(appAccountRecoveryStateKey);
  if (
    activeRecovery.reason === "removal" &&
    activeRecovery.status === "pending" &&
    activeRecovery.incidentToken &&
    activeRecovery.subredditName
  ) {
    return handleInviteDuringRemoval(event, activeRecovery.incidentToken);
  }
  const incidentToken = await scheduleAppAccountRecovery({
    redis,
    scheduler,
    reason: "reinvite",
    subredditName,
    ...(subredditId ? { subredditId } : {}),
    ...(typeof language === "string" ? { language } : {}),
    nowMs,
    dueAtMs: nowMs,
  });
  const result = await processAppAccountRecovery({
    reddit,
    redis,
    scheduler,
    incidentToken,
    nowMs,
    acceptInvite,
  });
  await completeModeratorEvent(redis, eventClaim, incidentToken, nowMs);
  return result;
}

async function handleInviteDuringRemoval(
  {
    reddit,
    redis,
    subredditName,
    subredditId,
    language,
    nowMs,
    acceptInvite,
    eventClaim,
  }: ModeratorInviteEvent,
  incidentToken: string,
): Promise<AppAccountRecoveryResult> {
  const inspection = await inspectModeratorAccount(reddit, subredditName);
  if (inspection.status === "missing" || inspection.status === "inaccessible") {
    try {
      await acceptInvite(subredditName);
      await redis.hSet(appAccountRecoveryStateKey, {
        invitationAcceptedAt: String(nowMs),
      });
    } catch (error) {
      logDiagnostic(
        "warn",
        "app_account_invitation_acceptance_failed",
        {
          workflow: "app_account_recovery",
          phase: "reinvite_event",
          subredditName,
        },
        error,
      );
      await redis.hSet(appAccountRecoveryStateKey, {
        lastError: error instanceof Error ? error.message : String(error),
      });
      const result: AppAccountRecoveryResult = {
        status: "pending",
        incidentToken,
      };
      await completeModeratorEvent(redis, eventClaim, incidentToken, nowMs);
      return result;
    }
  }
  const verified =
    inspection.status === "missing" || inspection.status === "inaccessible"
      ? await inspectModeratorAccount(reddit, subredditName)
      : inspection;
  if (verified.status === "healthy") {
    await checkAppAccountHealth({
      reddit,
      redis,
      subredditName,
      ...(subredditId ? { subredditId } : {}),
      ...(typeof language === "string" ? { language } : {}),
      notify: false,
      scheduleUnknownRetry: false,
      nowMs,
    });
    await redis.hSet(appAccountRecoveryStateKey, {
      recoveredAt: String(nowMs),
      permissions: verified.permissions.join(","),
      lastError: "",
    });
    const result: AppAccountRecoveryResult = {
      status: "healthy",
      incidentToken,
    };
    await completeModeratorEvent(redis, eventClaim, incidentToken, nowMs);
    return result;
  }
  const result: AppAccountRecoveryResult = {
    status: "pending",
    incidentToken,
  };
  await completeModeratorEvent(redis, eventClaim, incidentToken, nowMs);
  return result;
}

function toRecoveryResultStatus(value: string | undefined): RecoveryStatus {
  const statuses = new Set<RecoveryStatus>([
    "pending",
    "processing",
    "healthy",
    "missing",
    "insufficient_permissions",
    "acceptance_failed",
    "verification_failed",
    "exhausted",
  ]);
  return statuses.has(value as RecoveryStatus)
    ? (value as RecoveryStatus)
    : "pending";
}

type ModeratorEventClaim = { key: string; token: string };

async function claimModeratorEvent(
  redis: RedisClient,
  action: string,
  subredditName: string,
  moderatorName: string | undefined,
  actionedAt: string,
  nowMs: number,
): Promise<ModeratorEventClaim | undefined> {
  const fingerprint = [
    action.toLowerCase(),
    subredditName.toLowerCase(),
    normalizeUsername(moderatorName)?.toLowerCase() ?? "masked",
    actionedAt,
  ]
    .map(encodeURIComponent)
    .join(":");
  const key = `${appAccountRecoveryEventKeyPrefix}:${fingerprint}`;
  const token = crypto.randomUUID();
  await redis.set(key, token, {
    nx: true,
    expiration: new Date(nowMs + eventClaimTtlMs),
  });
  return (await redis.get(key)) === token ? { key, token } : undefined;
}

async function completeModeratorEvent(
  redis: RedisClient,
  claim: ModeratorEventClaim | undefined,
  outcome: string,
  nowMs: number,
): Promise<void> {
  if (!claim || (await redis.get(claim.key)) !== claim.token) return;
  await redis.set(claim.key, outcome, {
    expiration: new Date(nowMs + notificationRetentionMs),
  });
}

export async function processDueAppAccountRecovery({
  reddit,
  redis,
  scheduler,
  nowMs = Date.now(),
  acceptInvite = acceptModeratorInvite,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  scheduler: SchedulerLike;
  nowMs?: number;
  acceptInvite?: (subredditName: string) => Promise<void>;
}): Promise<AppAccountRecoveryResult> {
  const state = await redis.hGetAll(appAccountRecoveryStateKey);
  if (!state.incidentToken) return { status: "stale" };
  if (isTerminalRecoveryStatus(state.status)) {
    // Legacy terminal records have no verification deadline: inspect them once
    // immediately, then keep retrying with a one-hour ceiling.
    if (!state.subredditName || nowMs < Number(state.nextVerificationAt || 0)) {
      return {
        status: state.status as RecoveryStatus,
        incidentToken: state.incidentToken,
      };
    }
    const attempts = Math.min(7, (Number(state.verificationAttempts) || 0) + 1);
    const claimed = await updateRecoveryState(redis, state, {
      verificationToken: crypto.randomUUID(),
      verificationAttempts: String(attempts),
      nextVerificationAt: String(
        nowMs + Math.min(3_600_000, 60_000 * 2 ** (attempts - 1)),
      ),
    });
    if (!claimed)
      return { status: "locked", incidentToken: state.incidentToken };
    await checkAppAccountHealth({
      reddit,
      redis,
      subredditName: state.subredditName,
      ...(state.subredditId ? { subredditId: state.subredditId } : {}),
      notify: false,
      scheduleUnknownRetry: false,
      nowMs,
    });
    const current = await redis.hGetAll(appAccountRecoveryStateKey);
    return {
      status: toRecoveryResultStatus(current.status),
      ...(current.incidentToken
        ? { incidentToken: current.incidentToken }
        : {}),
    };
  }
  const result = await processAppAccountRecovery({
    reddit,
    redis,
    scheduler,
    incidentToken: state.incidentToken,
    nowMs,
    acceptInvite,
  });
  if (result.status === "locked") return result;
  const current = await redis.hGetAll(appAccountRecoveryStateKey);
  return {
    status: toRecoveryResultStatus(current.status),
    ...(current.incidentToken ? { incidentToken: current.incidentToken } : {}),
  };
}

type ActiveRecoveryState = Record<string, string> & {
  incidentToken: string;
  subredditName: string;
  reason: string;
};

type ActiveRecovery = {
  reddit: RedditClient;
  redis: RedisClient;
  scheduler: SchedulerLike;
  activeState: ActiveRecoveryState;
  nowMs: number;
  acceptInvite: (subredditName: string) => Promise<void>;
};

export async function processAppAccountRecovery({
  reddit,
  redis,
  scheduler,
  incidentToken,
  nowMs = Date.now(),
  acceptInvite = acceptModeratorInvite,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  scheduler: SchedulerLike;
  incidentToken: string;
  nowMs?: number;
  acceptInvite?: (subredditName: string) => Promise<void>;
}): Promise<AppAccountRecoveryResult> {
  const state = await redis.hGetAll(appAccountRecoveryStateKey);
  if (
    state.incidentToken !== incidentToken ||
    !state.subredditName ||
    !state.reason
  ) {
    return { status: "stale" };
  }
  const activeState = state as ActiveRecoveryState;
  if (activeState.status !== "pending" && activeState.status !== "processing") {
    return { status: activeState.status as RecoveryStatus, incidentToken };
  }
  if (nowMs < Number(activeState.dueAt)) {
    return { status: "not_due", incidentToken };
  }

  const lockToken = await acquireRedisLock(
    redis,
    appAccountRecoveryLockKey,
    2 * 60_000,
    { nowMs, token: `${incidentToken}:${crypto.randomUUID()}` },
  );
  if (!lockToken) {
    return { status: "locked", incidentToken };
  }

  try {
    return await recoverAppAccount({
      reddit,
      redis,
      scheduler,
      activeState,
      nowMs,
      acceptInvite,
    });
  } finally {
    await releaseRedisLock(redis, appAccountRecoveryLockKey, lockToken);
  }
}

async function recoverAppAccount(
  recovery: ActiveRecovery,
): Promise<AppAccountRecoveryResult> {
  const { reddit, redis, scheduler, activeState, nowMs } = recovery;
  const { incidentToken } = activeState;
  if (
    !(await updateRecoveryState(redis, activeState, {
      status: "processing",
      startedAt: String(nowMs),
    }))
  )
    return { status: "stale", incidentToken };
  activeState.status = "processing";
  const removalNotificationDelivered = await sendRemovalNotificationOnce(
    reddit,
    redis,
    activeState,
    nowMs,
  );

  const inspection = await inspectModeratorAccount(
    reddit,
    activeState.subredditName,
  );
  const outcome = await recordRecoveryInspection(
    recovery,
    inspection,
    removalNotificationDelivered,
  );
  if (outcome) return outcome;
  if (inspection.status === "unknown") {
    return retryOrExhaust({
      reddit,
      redis,
      scheduler,
      state: activeState,
      nowMs,
      error: inspection.error ?? "Moderator membership could not be verified.",
      terminalStatus: "verification_failed",
      suppressHealthNotification: removalNotificationDelivered,
    });
  }
  if (activeState.invitationAcceptedAt) {
    return retryOrExhaust({
      reddit,
      redis,
      scheduler,
      state: activeState,
      nowMs,
      error: inspection.error ?? "Invitation acceptance could not be verified.",
      terminalStatus: "verification_failed",
      suppressHealthNotification: removalNotificationDelivered,
    });
  }

  return acceptAndVerifyRecoveryInvite(recovery, removalNotificationDelivered);
}

async function acceptAndVerifyRecoveryInvite(
  recovery: ActiveRecovery,
  removalNotificationDelivered: boolean,
): Promise<AppAccountRecoveryResult> {
  const { reddit, redis, scheduler, activeState, nowMs, acceptInvite } =
    recovery;
  const { incidentToken } = activeState;
  try {
    await acceptInvite(activeState.subredditName);
    await redis.hSet(appAccountRecoveryStateKey, {
      invitationAcceptedAt: String(nowMs),
    });
  } catch (error) {
    logDiagnostic(
      "warn",
      "app_account_invitation_acceptance_failed",
      {
        workflow: "app_account_recovery",
        phase: "scheduled_acceptance",
        subredditName: activeState.subredditName,
      },
      error,
    );
    if (error instanceof ModeratorInviteRejectedError) {
      await recordUnhealthy(
        reddit,
        redis,
        activeState,
        "missing",
        [],
        nowMs,
        error.message,
        removalNotificationDelivered,
      );
      return { status: "missing", incidentToken };
    }
    return retryOrExhaust({
      reddit,
      redis,
      scheduler,
      state: activeState,
      nowMs,
      error: error instanceof Error ? error.message : String(error),
      terminalStatus: "acceptance_failed",
      suppressHealthNotification: removalNotificationDelivered,
    });
  }

  const verified = await inspectModeratorAccount(
    reddit,
    activeState.subredditName,
  );
  const outcome = await recordRecoveryInspection(
    recovery,
    verified,
    removalNotificationDelivered,
  );
  if (outcome) return outcome;
  return retryOrExhaust({
    reddit,
    redis,
    scheduler,
    state: activeState,
    nowMs,
    error: verified.error ?? "Invitation acceptance could not be verified.",
    terminalStatus: "verification_failed",
    suppressHealthNotification: removalNotificationDelivered,
  });
}

async function recordRecoveryInspection(
  { reddit, redis, scheduler, activeState, nowMs }: ActiveRecovery,
  inspection: ModeratorInspection,
  removalNotificationDelivered: boolean,
): Promise<AppAccountRecoveryResult | undefined> {
  const { incidentToken } = activeState;
  if (inspection.status === "healthy") {
    const recorded = await recordHealthy(
      reddit,
      redis,
      activeState,
      inspection.permissions,
      nowMs,
    );
    if (recorded === "stale") return { status: "stale", incidentToken };
    if (recorded === "unverified")
      return retryOrExhaust({
        reddit,
        redis,
        scheduler,
        state: activeState,
        nowMs,
        error: "Permissions could not be verified.",
        terminalStatus: "verification_failed",
        suppressHealthNotification: removalNotificationDelivered,
      });
    return { status: "healthy", incidentToken };
  }
  if (inspection.status === "insufficient_permissions") {
    await recordUnhealthy(
      reddit,
      redis,
      activeState,
      "insufficient_permissions",
      inspection.permissions,
      nowMs,
      "",
      removalNotificationDelivered,
    );
    return { status: "insufficient_permissions", incidentToken };
  }
  return undefined;
}

async function inspectModeratorAccount(
  reddit: RedditClient,
  subredditName: string,
): Promise<ModeratorInspection> {
  try {
    const appUser = await reddit.getAppUser();
    if (!appUser) throw new Error("The app account could not be resolved.");
    const username =
      normalizeUsername(appUser.username) ?? subscriberGoalAppUsername;
    const moderators = await reddit
      .getModerators({ subredditName, username, limit: 1 })
      .get(1);
    const moderator = moderators.find(
      (candidate) =>
        candidate.username.toLowerCase() === username.toLowerCase(),
    );
    if (!moderator) return { status: "missing", permissions: [] };
    const permissions =
      await appUser.getModPermissionsForSubreddit(subredditName);
    return {
      status:
        permissions.includes("all") || permissions.includes("posts")
          ? "healthy"
          : "insufficient_permissions",
      permissions,
    };
  } catch (error) {
    logDiagnostic(
      "warn",
      "app_account_membership_inspection_failed",
      {
        workflow: "app_account_recovery",
        phase: "membership_inspection",
        subredditName,
      },
      error,
    );
    return {
      status: isPrivateSubredditAccessError(error) ? "inaccessible" : "unknown",
      permissions: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function sendRemovalNotificationOnce(
  reddit: RedditClient,
  redis: RedisClient,
  state: Record<string, string> & {
    incidentToken: string;
    subredditName: string;
    reason: string;
  },
  nowMs: number,
): Promise<boolean> {
  if (state.reason !== "removal" || !state.removedBy) return false;
  const key = `${notificationKeyPrefix}:${state.incidentToken}`;
  const notificationClaimToken = crypto.randomUUID();
  await redis.set(key, notificationClaimToken, {
    nx: true,
    expiration: new Date(nowMs + notificationRetentionMs),
  });
  const notificationState = await redis.get(key);
  if (notificationState !== notificationClaimToken) {
    // Treat an existing claim as delivered: the prior worker may have sent the
    // PM before losing execution, and avoiding duplicates is the safer outcome.
    return notificationState !== undefined;
  }
  try {
    await reddit.sendPrivateMessage({
      to: state.removedBy,
      ...buildModeratorRemovalMessage(state.removedBy, state.subredditName),
    });
    await redis.set(key, "sent", {
      expiration: new Date(nowMs + notificationRetentionMs),
    });
    await redis.hSet(appAccountRecoveryStateKey, { notification: "sent" });
    return true;
  } catch (error) {
    await redis.del(key);
    await redis.hSet(appAccountRecoveryStateKey, {
      notification: "failed",
      notificationError: error instanceof Error ? error.message : String(error),
    });
    logDiagnostic(
      "warn",
      "app_account_removal_notification_failed",
      { workflow: "app_account_recovery", subredditName: state.subredditName },
      error,
    );
    return false;
  }
}

async function recordHealthy(
  reddit: RedditClient,
  redis: RedisClient,
  state: Record<string, string> & { subredditName: string },
  permissions: string[],
  nowMs: number,
): Promise<"healthy" | "stale" | "unverified"> {
  const health = await checkAppAccountHealth({
    reddit,
    redis,
    subredditName: state.subredditName,
    ...(state.subredditId ? { subredditId: state.subredditId } : {}),
    ...(state.language ? { language: state.language } : {}),
    notify: false,
    scheduleUnknownRetry: false,
    nowMs,
  });
  if (!health.healthy) return "unverified";
  const updated = await updateRecoveryState(redis, state, {
    status: "healthy",
    completedAt: String(nowMs),
    permissions: permissions.join(","),
    lastError: "",
  });
  return updated ? "healthy" : "stale";
}

async function recordUnhealthy(
  reddit: RedditClient,
  redis: RedisClient,
  state: Record<string, string> & { subredditName: string },
  status: Extract<RecoveryStatus, "missing" | "insufficient_permissions">,
  permissions: string[],
  nowMs: number,
  lastError = "",
  suppressHealthNotification = false,
): Promise<void> {
  await checkAppAccountHealth({
    reddit,
    redis,
    subredditName: state.subredditName,
    ...(state.subredditId ? { subredditId: state.subredditId } : {}),
    ...(state.language ? { language: state.language } : {}),
    notify: !suppressHealthNotification,
    scheduleUnknownRetry: false,
    nowMs,
  });
  await updateRecoveryState(
    redis,
    { ...state, status: "processing" },
    {
      status,
      completedAt: String(nowMs),
      permissions: permissions.join(","),
      lastError,
    },
  );
}

async function retryOrExhaust({
  reddit,
  redis,
  scheduler,
  state,
  nowMs,
  error,
  terminalStatus,
  suppressHealthNotification = false,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  scheduler: SchedulerLike;
  state: Record<string, string> & {
    incidentToken: string;
    subredditName: string;
  };
  nowMs: number;
  error: string;
  terminalStatus: "acceptance_failed" | "verification_failed";
  suppressHealthNotification?: boolean;
}): Promise<AppAccountRecoveryResult> {
  const attempts = (parseInt(state.attempts || "0", 10) || 0) + 1;
  if (attempts < appAccountRecoveryMaxAttempts) {
    const dueAt = nowMs + appAccountRecoveryDelayMs;
    const updated = await updateRecoveryState(
      redis,
      { ...state, status: "processing" },
      {
        status: "pending",
        attempts: String(attempts),
        dueAt: String(dueAt),
        lastError: error,
        schedulerJobId: "",
      },
    );
    if (!updated)
      return { status: "stale", incidentToken: state.incidentToken };
    const jobId = await scheduler.runJob({
      name: appAccountRecoveryJobName,
      runAt: new Date(dueAt),
      data: { incidentToken: state.incidentToken },
    });
    await redis.hSet(appAccountRecoveryStateKey, { schedulerJobId: jobId });
    return { status: "pending", incidentToken: state.incidentToken };
  }
  await checkAppAccountHealth({
    reddit,
    redis,
    subredditName: state.subredditName,
    ...(state.subredditId ? { subredditId: state.subredditId } : {}),
    ...(state.language ? { language: state.language } : {}),
    notify: !suppressHealthNotification,
    scheduleUnknownRetry: false,
    nowMs,
  });
  await updateRecoveryState(
    redis,
    { ...state, status: "processing" },
    {
      status: terminalStatus,
      outcome: terminalStatus,
      attempts: String(attempts),
      completedAt: String(nowMs),
      lastError: error,
    },
  );
  return { status: terminalStatus, incidentToken: state.incidentToken };
}
