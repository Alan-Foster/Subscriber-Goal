import {
  appAccountHealthRetryStateKey,
  readAppAccountHealthRetry,
  scheduleAppAccountHealthRetry,
  type AppAccountHealthRetry,
} from "../data/appAccountHealthRetry";
import {
  appAccountRecoveryStateKey,
  isTerminalRecoveryStatus,
  updateRecoveryState,
} from "./appAccountRecoveryState";
import { logDiagnostic } from "../../shared/diagnostics";
import { translate } from "../../shared/i18n/catalog";
import type { RedditClient, RedisClient } from "../types";
import { scheduleHighlightRepair } from "../data/highlightRepair";
import {
  highlightPermissionIncidentKey,
  notifyHighlightPermissionIncident,
} from "../utils/highlightFailureNotifications";
import { acquireRedisLock, releaseRedisLock } from "../utils/redisOwnedLock";
import { boundedLockTtlMs, userFacingLockTtlMs } from "../utils/lockTtl";

export const appAccountInstallerKey = "app_account_health_v1_installer";
export const appAccountHealthStateKey = "app_account_health_v1_state";
export const appAccountHealthNotificationLockKey =
  "app_account_health_v1_notification_lock";
const appAccountHealthNotificationLockTtlMs = boundedLockTtlMs(
  "app_account_health_notification",
  userFacingLockTtlMs,
);
export {
  appAccountHealthRetryStateKey,
  appAccountHealthMaxRetryAttempts,
} from "../data/appAccountHealthRetry";
export const subscriberGoalAppUsername = "subscriber-goal";

export type AppAccountHealthStatus = "healthy" | "unhealthy" | "unknown";

export type AppAccountHealthResult = {
  status: AppAccountHealthStatus;
  healthy: boolean;
  appUsername?: string;
  permissions: string[];
  notification:
    "not_needed" | "deduplicated" | "modmail" | "installer_dm" | "failed";
};

export async function rememberAppInstaller(
  redis: RedisClient,
  installerUsername: string | undefined,
): Promise<void> {
  const normalized = installerUsername?.trim().replace(/^u\//i, "");
  if (normalized) {
    await redis.set(appAccountInstallerKey, normalized);
  }
}

export function buildAppAccountRecoveryMessage(
  subredditName: string,
  language?: unknown,
): {
  subject: string;
  bodyMarkdown: string;
} {
  return {
    subject: translate(language, "outbound.health.subject", { subredditName }),
    bodyMarkdown: translate(language, "outbound.health.body", {
      subredditName,
      appUsername: subscriberGoalAppUsername,
      installationUrl: `https://developers.reddit.com/r/${subredditName}/apps/subscriber-goal`,
    }),
  };
}

type HealthCheck = {
  reddit: RedditClient;
  redis: RedisClient;
  subredditName: string;
  subredditId: string | undefined;
  language: unknown;
  nowMs: number;
};

type ModeratorPermissions = {
  appUsername: string | undefined;
  permissions: string[];
};

export async function checkAppAccountHealth({
  reddit,
  redis,
  subredditName,
  subredditId,
  notify = true,
  scheduleUnknownRetry = true,
  language,
  nowMs = Date.now(),
}: {
  reddit: RedditClient;
  redis: RedisClient;
  subredditName: string;
  subredditId?: string;
  notify?: boolean;
  scheduleUnknownRetry?: boolean;
  language?: unknown;
  nowMs?: number;
}): Promise<AppAccountHealthResult> {
  const recovery = await redis.hGetAll(appAccountRecoveryStateKey);
  const check = { reddit, redis, subredditName, subredditId, language, nowMs };
  const inspection = await inspectAppAccountPermissions(
    check,
    scheduleUnknownRetry,
  );
  if ("status" in inspection) return inspection;
  const { permissions } = inspection;

  const currentRecovery = await redis.hGetAll(appAccountRecoveryStateKey);
  if (
    ["incidentToken", "status", "verificationToken"].some(
      (key) => currentRecovery[key] !== recovery[key],
    )
  ) {
    return {
      status: "unknown",
      healthy: false,
      permissions: [],
      notification: "not_needed",
    };
  }
  const [previousHealth, previousRetry] = await Promise.all([
    redis.hGetAll(appAccountHealthStateKey),
    readAppAccountHealthRetry(redis),
  ]);

  const healthy = permissions.includes("all") || permissions.includes("posts");
  if (healthy) {
    return recordHealthyAppAccount(
      check,
      inspection,
      recovery,
      previousHealth,
      previousRetry,
    );
  }
  return recordUnhealthyAppAccount(check, inspection, previousRetry, notify);
}

async function inspectAppAccountPermissions(
  { reddit, redis, subredditName, subredditId, language, nowMs }: HealthCheck,
  scheduleUnknownRetry: boolean,
): Promise<ModeratorPermissions | AppAccountHealthResult> {
  let appUsername: string | undefined;
  let permissions: string[] = [];
  try {
    const appUser = await reddit.getAppUser();
    appUsername = appUser?.username;
    if (!appUser) throw new Error("The app account could not be resolved.");
    permissions = await appUser.getModPermissionsForSubreddit(subredditName);
  } catch (error) {
    if (scheduleUnknownRetry) {
      const previousRetry = await readAppAccountHealthRetry(redis);
      await scheduleAppAccountHealthRetry(
        redis,
        previousRetry.attempts,
        nowMs,
        {
          subredditName,
          subredditId: subredditId ?? "",
          language: typeof language === "string" ? language : "",
          lastError: error instanceof Error ? error.message : String(error),
        },
      );
    }
    logDiagnostic(
      "warn",
      "app_account_health_check_failed",
      {
        workflow: "app_account_health",
        phase: "permission_lookup",
        subredditName,
      },
      error,
    );
    return {
      status: "unknown",
      healthy: false,
      ...(appUsername ? { appUsername } : {}),
      permissions,
      notification: "not_needed",
    };
  }
  return { appUsername, permissions };
}

async function recordHealthyAppAccount(
  { redis, nowMs }: HealthCheck,
  { appUsername, permissions }: ModeratorPermissions,
  recovery: Record<string, string>,
  previousHealth: Record<string, string>,
  previousRetry: AppAccountHealthRetry,
): Promise<AppAccountHealthResult> {
  const restoredRecovery = isTerminalRecoveryStatus(recovery.status);
  if (
    restoredRecovery &&
    !(await updateRecoveryState(redis, recovery, {
      status: "healthy",
      completedAt: String(nowMs),
      permissions: permissions.join(","),
      lastError: "",
    }))
  ) {
    return {
      status: "unknown",
      healthy: false,
      permissions: [],
      notification: "not_needed",
    };
  }

  await redis.del(appAccountHealthRetryStateKey);
  if (previousHealth.status === "unhealthy" || previousRetry.lastError) {
    await redis.del(highlightPermissionIncidentKey);
  }
  await redis.hSet(appAccountHealthStateKey, {
    status: "healthy",
    checkedAt: String(nowMs),
    appUsername: appUsername ?? "",
    permissions: permissions.join(","),
    incidentFingerprint: "",
    incidentToken: "",
    notification: "not_needed",
  });
  if (
    restoredRecovery ||
    previousHealth.status === "unhealthy" ||
    previousRetry.status === "pending" ||
    previousRetry.status === "exhausted"
  ) {
    await scheduleHighlightRepair(redis, {
      nowMs,
      delayMs: 0,
      force: true,
      reason: "permissions_restored",
    });
  }
  return {
    status: "healthy",
    healthy: true,
    ...(appUsername ? { appUsername } : {}),
    permissions,
    notification: "not_needed",
  };
}

async function recordUnhealthyAppAccount(
  check: HealthCheck,
  inspection: ModeratorPermissions,
  previousRetry: AppAccountHealthRetry,
  notify: boolean,
): Promise<AppAccountHealthResult> {
  const { redis, subredditName, subredditId, nowMs } = check;
  const { appUsername, permissions } = inspection;
  await scheduleAppAccountHealthRetry(redis, previousRetry.attempts, nowMs, {
    subredditName,
    subredditId: subredditId ?? "",
    lastError: "missing_posts_permission",
  });

  let notificationLockToken: string | undefined;
  if (notify) {
    notificationLockToken = await acquireRedisLock(
      redis,
      appAccountHealthNotificationLockKey,
      appAccountHealthNotificationLockTtlMs,
      { nowMs },
    );
    if (!notificationLockToken) {
      return {
        status: "unhealthy",
        healthy: false,
        ...(appUsername ? { appUsername } : {}),
        permissions,
        notification: "deduplicated",
      };
    }
  }
  try {
    return await recordHealthIncident(
      check,
      inspection,
      notify,
      notificationLockToken,
    );
  } finally {
    if (notificationLockToken) {
      await releaseRedisLock(
        redis,
        appAccountHealthNotificationLockKey,
        notificationLockToken,
      );
    }
  }
}

async function recordHealthIncident(
  check: HealthCheck,
  { appUsername, permissions }: ModeratorPermissions,
  notify: boolean,
  notificationLockToken: string | undefined,
): Promise<AppAccountHealthResult> {
  const { redis, subredditName, nowMs } = check;
  const fingerprint = "missing_posts";
  const previous = await redis.hGetAll(appAccountHealthStateKey);
  const duplicateIncident =
    previous.status === "unhealthy" && previous.notification !== "not_needed";
  let notification: AppAccountHealthResult["notification"] = notify
    ? "failed"
    : "not_needed";

  if (duplicateIncident && notify) {
    notification = "deduplicated";
  } else if (notify) {
    const incidentToken = notificationLockToken ?? String(nowMs);
    await redis.hSet(appAccountHealthStateKey, {
      status: "unhealthy",
      checkedAt: String(nowMs),
      appUsername: appUsername ?? "",
      permissions: permissions.join(","),
      incidentFingerprint: fingerprint,
      incidentToken,
      incidentStartedAt: String(nowMs),
      notification: "notifying",
    });
    notification = await sendHealthIncidentNotification(check);
  }

  const current = await redis.hGetAll(appAccountHealthStateKey);
  const mayFinalize =
    duplicateIncident ||
    !notify ||
    current.incidentToken === notificationLockToken;
  if (mayFinalize)
    await redis.hSet(appAccountHealthStateKey, {
      status: "unhealthy",
      checkedAt: String(nowMs),
      appUsername: appUsername ?? "",
      permissions: permissions.join(","),
      incidentFingerprint: fingerprint,
      notification:
        !notify && duplicateIncident
          ? (previous.notification ?? notification)
          : notification,
      ...(duplicateIncident ? {} : { incidentStartedAt: String(nowMs) }),
    });
  logDiagnostic("warn", "app_account_unhealthy", {
    workflow: "app_account_health",
    phase: "permission_check",
    subredditName,
    username: appUsername,
    category: fingerprint,
    notification,
  });
  return {
    status: "unhealthy",
    healthy: false,
    ...(appUsername ? { appUsername } : {}),
    permissions,
    notification,
  };
}

async function sendHealthIncidentNotification({
  reddit,
  redis,
  subredditName,
  subredditId,
  language,
  nowMs,
}: HealthCheck): Promise<AppAccountHealthResult["notification"]> {
  let notification: AppAccountHealthResult["notification"] = "failed";
  const message = buildAppAccountRecoveryMessage(subredditName, language);
  if (subredditId) {
    try {
      const outcome = await notifyHighlightPermissionIncident(
        redis,
        async () => {
          await reddit.modMail.createModNotification({
            subredditId: subredditId as `t5_${string}`,
            subject: message.subject,
            bodyMarkdown: message.bodyMarkdown,
          });
          return "sent";
        },
        nowMs,
      );
      notification =
        outcome === "skipped_duplicate" ? "deduplicated" : "modmail";
    } catch (error) {
      logDiagnostic(
        "warn",
        "app_account_health_notification_failed",
        { workflow: "app_account_health", phase: "modmail", subredditName },
        error,
      );
    }
  }
  if (notification === "failed") {
    const installerUsername = await redis.get(appAccountInstallerKey);
    if (installerUsername) {
      try {
        await reddit.sendPrivateMessage({
          to: installerUsername,
          subject: message.subject,
          text: message.bodyMarkdown,
        });
        notification = "installer_dm";
      } catch (error) {
        logDiagnostic(
          "warn",
          "app_account_health_notification_failed",
          {
            workflow: "app_account_health",
            phase: "installer_dm",
            subredditName,
          },
          error,
        );
      }
    }
  }
  return notification;
}
