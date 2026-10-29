import { logDiagnostic } from "../../shared/diagnostics";
import { translate } from "../../shared/i18n/catalog";
import type { RedditClient, RedisClient } from "../types";
import { scheduleHighlightRepair } from "../data/highlightRepair";

export const appAccountInstallerKey = "app_account_health_v1_installer";
export const appAccountHealthStateKey = "app_account_health_v1_state";
export const appAccountHealthNotificationLockKey =
  "app_account_health_v1_notification_lock";
export const appAccountHealthRetryStateKey =
  "app_account_health_v1_retry_state";
export const subscriberGoalAppUsername = "subscriber-goal";

export type AppAccountHealthStatus = "healthy" | "unhealthy" | "unknown";

export type AppAccountHealthResult = {
  status: AppAccountHealthStatus;
  healthy: boolean;
  appUsername?: string;
  permissions: string[];
  notification:
    | "not_needed"
    | "deduplicated"
    | "modmail"
    | "installer_dm"
    | "failed";
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
    }),
  };
}

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
  let appUsername: string | undefined;
  let permissions: string[] = [];
  try {
    const appUser = await reddit.getAppUser();
    appUsername = appUser?.username;
    if (!appUser) throw new Error("The app account could not be resolved.");
    permissions = await appUser.getModPermissionsForSubreddit(subredditName);
  } catch (error) {
    if (scheduleUnknownRetry) {
      const previousRetry = await redis.hGetAll(appAccountHealthRetryStateKey);
      const attempts = (parseInt(previousRetry.attempts ?? "0", 10) || 0) + 1;
      const retryDelayMs = Math.min(
        60 * 60 * 1000,
        60_000 * 2 ** (attempts - 1),
      );
      await redis.hSet(appAccountHealthRetryStateKey, {
        status: "pending",
        attempts: String(attempts),
        nextRunAt: String(nowMs + retryDelayMs),
        subredditName,
        subredditId: subredditId ?? "",
        language: typeof language === "string" ? language : "",
        lastError: error instanceof Error ? error.message : String(error),
      });
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

  const [previousHealth, previousRetry] = await Promise.all([
    redis.hGetAll(appAccountHealthStateKey),
    redis.hGetAll(appAccountHealthRetryStateKey),
  ]);
  await redis.del(appAccountHealthRetryStateKey);
  const healthy = permissions.includes("all") || permissions.includes("posts");
  const fingerprint = "missing_posts";

  if (healthy) {
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
      previousHealth.status === "unhealthy" ||
      previousRetry.status === "pending"
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

  const healthRetryAttempts =
    (parseInt(previousRetry.attempts ?? "0", 10) || 0) + 1;
  const healthRetryDelayMs = Math.min(
    60 * 60 * 1000,
    60_000 * 2 ** (healthRetryAttempts - 1),
  );
  await redis.hSet(appAccountHealthRetryStateKey, {
    status: "pending",
    attempts: String(healthRetryAttempts),
    nextRunAt: String(nowMs + healthRetryDelayMs),
    subredditName,
    subredditId: subredditId ?? "",
    lastError: "missing_posts_permission",
  });

  let notificationLockToken: string | undefined;
  if (notify) {
    notificationLockToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
    await redis.set(
      appAccountHealthNotificationLockKey,
      notificationLockToken,
      {
        nx: true,
        expiration: new Date(nowMs + 60_000),
      },
    );
    if (
      (await redis.get(appAccountHealthNotificationLockKey)) !==
      notificationLockToken
    ) {
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
    const previous = await redis.hGetAll(appAccountHealthStateKey);
    const duplicateIncident = previous.status === "unhealthy";
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
      const message = buildAppAccountRecoveryMessage(subredditName, language);
      if (subredditId) {
        try {
          await reddit.modMail.createModNotification({
            subredditId: subredditId as `t5_${string}`,
            subject: message.subject,
            bodyMarkdown: message.bodyMarkdown,
          });
          notification = "modmail";
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
        notification,
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
  } finally {
    if (
      notificationLockToken &&
      (await redis.get(appAccountHealthNotificationLockKey)) ===
        notificationLockToken
    ) {
      await redis.del(appAccountHealthNotificationLockKey);
    }
  }
}

export async function processDueAppAccountHealthCheck({
  reddit,
  redis,
  nowMs = Date.now(),
}: {
  reddit: RedditClient;
  redis: RedisClient;
  nowMs?: number;
}): Promise<AppAccountHealthResult | undefined> {
  const retry = await redis.hGetAll(appAccountHealthRetryStateKey);
  if (
    retry.status !== "pending" ||
    !retry.subredditName ||
    !Number.isFinite(Number(retry.nextRunAt)) ||
    nowMs < Number(retry.nextRunAt)
  ) {
    return undefined;
  }
  return checkAppAccountHealth({
    reddit,
    redis,
    subredditName: retry.subredditName,
    ...(retry.subredditId ? { subredditId: retry.subredditId } : {}),
    ...(retry.language ? { language: retry.language } : {}),
    nowMs,
  });
}
