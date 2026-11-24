import { reddit, redis, context } from "@devvit/web/server";
import { type ServerAppSettings } from "../settings";
import { countPendingCrossposts } from "../data/crosspostData";
import { logCrosspostEvent, toErrorMessage } from "../utils/crosspostLogs";
import { logDiagnostic } from "../../shared/diagnostics";
import { acquireRedisLock, releaseRedisLock } from "../utils/redisOwnedLock";
import {
  toNormalizedSubredditName,
  getCrosspostAuthoritySubreddit,
  cleanupCrosspostBookkeeping,
} from "./bookkeeping";
import {
  type CrosspostIngestionSummary,
  emptySummary,
  withErrorMessage,
  type CrosspostIngestionOptions,
} from "./summary";
import { updateFromWikis } from "./ingestion";
import { rebuildCrosspostMappings } from "./mappingRebuild";

const crosspostRetryDegradedCountKey = "crosspostRetryDegradedCount";
const crosspostRetryDegradedThreshold = 3;
const crosspostIngestionLockKeyPrefix = "crosspostIngestionLock";
const crosspostIngestionLockTtlMs = 60 * 1000;
const crosspostSchedulerDaisyChainMaxPasses = 3;
const mappingRebuildBudgetMs = 5_000;
const getCrosspostMaxSourcePostAgeMs = (
  appSettings: ServerAppSettings,
): number => {
  const minutes =
    Number.isFinite(appSettings.crosspostMaxSourcePostAgeMinutes) &&
    appSettings.crosspostMaxSourcePostAgeMinutes > 0
      ? Math.floor(appSettings.crosspostMaxSourcePostAgeMinutes)
      : 10;
  return minutes * 60 * 1000;
};

const getCrosspostMaxRevisionAgeMs = (
  appSettings: ServerAppSettings,
): number => {
  const minutes =
    Number.isFinite(appSettings.crosspostMaxRevisionAgeMinutes) &&
    appSettings.crosspostMaxRevisionAgeMinutes > 0
      ? Math.floor(appSettings.crosspostMaxRevisionAgeMinutes)
      : 10;
  return minutes * 60 * 1000;
};

const getMaxCrosspostsPerRun = (appSettings: ServerAppSettings): number =>
  Number.isFinite(appSettings.maxCrosspostsPerRun) &&
  appSettings.maxCrosspostsPerRun > 0
    ? Math.floor(appSettings.maxCrosspostsPerRun)
    : 5;

const getMaxCrosspostsPerHour = (appSettings: ServerAppSettings): number =>
  Number.isFinite(appSettings.maxCrosspostsPerHour) &&
  appSettings.maxCrosspostsPerHour > 0
    ? Math.floor(appSettings.maxCrosspostsPerHour)
    : 30;

type CrosspostDispatchLogContext = {
  currentInstallSubreddit: string;
  authoritySubreddit: string;
  ingestionAllowed: boolean;
  freshnessWindowMs: number;
  revisionFreshnessWindowMs: number;
};
export async function processCrosspostDispatchQueue(
  appSettings: ServerAppSettings,
  reason: string,
  deadlineMs = Number.POSITIVE_INFINITY,
): Promise<CrosspostIngestionSummary> {
  const crosspostIngestionEnabled =
    appSettings.crosspostIngestionEnabled !== false;
  const currentInstallSubredditRaw =
    context.subredditName ?? (await reddit.getCurrentSubreddit()).name;
  const currentInstallSubreddit = toNormalizedSubredditName(
    currentInstallSubredditRaw,
  );
  const authoritySubreddit = getCrosspostAuthoritySubreddit(appSettings);
  const freshnessWindowMs = getCrosspostMaxSourcePostAgeMs(appSettings);
  const revisionFreshnessWindowMs = getCrosspostMaxRevisionAgeMs(appSettings);
  const maxCrosspostsPerRun = getMaxCrosspostsPerRun(appSettings);
  const maxCrosspostsPerHour = getMaxCrosspostsPerHour(appSettings);
  const ingestionAllowed = currentInstallSubreddit === authoritySubreddit;
  const logContext: CrosspostDispatchLogContext = {
    currentInstallSubreddit,
    authoritySubreddit,
    ingestionAllowed,
    freshnessWindowMs,
    revisionFreshnessWindowMs,
  };

  logCrosspostEvent({
    event: "crosspost_retry_started",
    targetSubreddit: appSettings.promoSubreddit,
    reason,
    ...logContext,
  });

  if (!crosspostIngestionEnabled) {
    logCrosspostEvent(
      {
        event: "crosspost_retry_skipped",
        targetSubreddit: appSettings.promoSubreddit,
        reason: "ingestion_disabled",
        status: "success",
        ...logContext,
      },
      "warn",
    );
    return emptySummary();
  }

  if (!ingestionAllowed) {
    const logLevel = reason === "scheduler_posts_updater" ? "info" : "warn";
    logCrosspostEvent(
      {
        event: "crosspost_retry_skipped",
        targetSubreddit: appSettings.promoSubreddit,
        reason: "non_authority",
        status: "success",
        ...logContext,
      },
      logLevel,
    );
    return emptySummary();
  }

  const lockKey = `${crosspostIngestionLockKeyPrefix}:${toNormalizedSubredditName(
    appSettings.promoSubreddit,
  )}`;
  const lock = await acquireRedisLock(
    redis,
    lockKey,
    crosspostIngestionLockTtlMs,
  );
  if (!lock) {
    logCrosspostEvent(
      {
        event: "crosspost_retry_skipped",
        targetSubreddit: appSettings.promoSubreddit,
        reason: "lock_held",
        status: "success",
        ...logContext,
      },
      "warn",
    );
    return emptySummary();
  }

  try {
    try {
      try {
        await cleanupCrosspostBookkeeping(redis);
      } catch (cleanupError) {
        logDiagnostic(
          "warn",
          "crosspost_cleanup_failed",
          { workflow: "crosspost", phase: "bookkeeping_cleanup" },
          cleanupError,
        );
      }
      if (
        reason === "scheduler_posts_updater" &&
        Date.now() + mappingRebuildBudgetMs < deadlineMs
      ) {
        await runMappingRebuild(appSettings.promoSubreddit);
      }
      const summary = await runDispatchPasses(appSettings, reason, {
        sourcePostFreshnessWindowMs: freshnessWindowMs,
        revisionFreshnessWindowMs,
        maxCrosspostsPerRun,
        maxCrosspostsPerHour,
      });
      await recordDispatchOutcome(appSettings, reason, logContext, summary);
      return summary;
    } catch (error) {
      const summary: CrosspostIngestionSummary = {
        ...emptySummary(),
        status: "failed",
        errorMessage: toErrorMessage(error),
      };
      logCrosspostEvent(
        {
          event: "crosspost_retry_failed",
          targetSubreddit: appSettings.promoSubreddit,
          reason,
          status: summary.status,
          ...withErrorMessage(summary.errorMessage),
          ...logContext,
        },
        "error",
      );
      await recordDispatchFailure(appSettings, reason, logContext, summary);
      return summary;
    }
  } finally {
    await releaseRedisLock(redis, lockKey, lock, {
      event: "crosspost_cleanup_failed",
      context: { workflow: "crosspost", phase: "ingestion_lock_release" },
    });
  }
}

async function runMappingRebuild(targetSubreddit: string): Promise<void> {
  try {
    await rebuildCrosspostMappings(reddit, redis, targetSubreddit);
  } catch (error) {
    logDiagnostic(
      "warn",
      "crosspost_mapping_rebuild_failed",
      {
        workflow: "crosspost",
        phase: "mapping_rebuild",
      },
      error,
    );
  }
}

async function runDispatchPasses(
  appSettings: ServerAppSettings,
  reason: string,
  options: CrosspostIngestionOptions,
): Promise<CrosspostIngestionSummary> {
  const summary = emptySummary();
  const runErrorMessages: string[] = [];
  const maxPasses =
    reason === "scheduler_posts_updater"
      ? crosspostSchedulerDaisyChainMaxPasses
      : 1;
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const passSummary = await updateFromWikis(appSettings, options);

    summary.revisionsFetched += passSummary.revisionsFetched;
    summary.newPostsSeen += passSummary.newPostsSeen;
    summary.crosspostsCreated += passSummary.crosspostsCreated;
    summary.crosspostsSkipped += passSummary.crosspostsSkipped;
    summary.crosspostsFailed += passSummary.crosspostsFailed;
    summary.actionsMirrored += passSummary.actionsMirrored;
    summary.actionsFailed += passSummary.actionsFailed;
    summary.crosspostsCreatedThisRun += passSummary.crosspostsCreatedThisRun;
    summary.crosspostsBlockedByRunCap += passSummary.crosspostsBlockedByRunCap;
    summary.crosspostsBlockedByHourlyCap +=
      passSummary.crosspostsBlockedByHourlyCap;
    summary.crosspostPersistenceFailedAfterCreate +=
      passSummary.crosspostPersistenceFailedAfterCreate;
    summary.crosspostsSkippedBySourceCooldown +=
      passSummary.crosspostsSkippedBySourceCooldown;
    summary.crosspostsSkippedByInFlight +=
      passSummary.crosspostsSkippedByInFlight;
    summary.crosspostsSkippedByExistingDetection +=
      passSummary.crosspostsSkippedByExistingDetection;

    if (passSummary.status === "failed") {
      summary.status = "failed";
    } else if (
      passSummary.status === "partial" &&
      summary.status !== "failed"
    ) {
      summary.status = "partial";
    }
    if (passSummary.errorMessage) {
      runErrorMessages.push(passSummary.errorMessage);
    }

    const pendingDepth = await countPendingCrossposts(
      redis,
      appSettings.promoSubreddit,
    );
    if (pendingDepth > 0 || passSummary.status !== "success") {
      console.info(
        `[crosspost] daisy-chain pass ${pass}/${maxPasses}: pendingDepth=${pendingDepth} status=${passSummary.status}`,
      );
    }
    if (pendingDepth === 0) {
      break;
    }
  }
  if (runErrorMessages.length > 0) {
    summary.errorMessage = runErrorMessages.join(" | ");
  }
  return summary;
}

async function recordDispatchOutcome(
  appSettings: ServerAppSettings,
  reason: string,
  logContext: CrosspostDispatchLogContext,
  summary: CrosspostIngestionSummary,
): Promise<void> {
  if (summary.status === "success") {
    await redis.set(crosspostRetryDegradedCountKey, "0");
  } else {
    const previous = parseInt(
      (await redis.get(crosspostRetryDegradedCountKey)) ?? "0",
      10,
    );
    const consecutiveFailures = Number.isNaN(previous) ? 1 : previous + 1;
    await redis.set(
      crosspostRetryDegradedCountKey,
      consecutiveFailures.toString(),
    );

    if (consecutiveFailures >= crosspostRetryDegradedThreshold) {
      logCrosspostEvent(
        {
          event: "crosspost_retry_degraded",
          targetSubreddit: appSettings.promoSubreddit,
          reason,
          status: summary.status,
          revisionsFetched: summary.revisionsFetched,
          newPostsSeen: summary.newPostsSeen,
          crosspostsCreated: summary.crosspostsCreated,
          crosspostsSkipped: summary.crosspostsSkipped,
          crosspostsFailed: summary.crosspostsFailed,
          actionsMirrored: summary.actionsMirrored,
          actionsFailed: summary.actionsFailed,
          crosspostsCreatedThisRun: summary.crosspostsCreatedThisRun,
          crosspostsBlockedByRunCap: summary.crosspostsBlockedByRunCap,
          crosspostsBlockedByHourlyCap: summary.crosspostsBlockedByHourlyCap,
          crosspostPersistenceFailedAfterCreate:
            summary.crosspostPersistenceFailedAfterCreate,
          crosspostsSkippedBySourceCooldown:
            summary.crosspostsSkippedBySourceCooldown,
          crosspostsSkippedByInFlight: summary.crosspostsSkippedByInFlight,
          crosspostsSkippedByExistingDetection:
            summary.crosspostsSkippedByExistingDetection,
          ...withErrorMessage(summary.errorMessage),
          consecutiveFailures,
          ...logContext,
        },
        "warn",
      );
    }
  }

  logCrosspostEvent(
    {
      event:
        summary.status === "failed"
          ? "crosspost_retry_failed"
          : "crosspost_retry_succeeded",
      targetSubreddit: appSettings.promoSubreddit,
      reason,
      status: summary.status,
      revisionsFetched: summary.revisionsFetched,
      newPostsSeen: summary.newPostsSeen,
      crosspostsCreated: summary.crosspostsCreated,
      crosspostsSkipped: summary.crosspostsSkipped,
      crosspostsFailed: summary.crosspostsFailed,
      actionsMirrored: summary.actionsMirrored,
      actionsFailed: summary.actionsFailed,
      crosspostsCreatedThisRun: summary.crosspostsCreatedThisRun,
      crosspostsBlockedByRunCap: summary.crosspostsBlockedByRunCap,
      crosspostsBlockedByHourlyCap: summary.crosspostsBlockedByHourlyCap,
      crosspostPersistenceFailedAfterCreate:
        summary.crosspostPersistenceFailedAfterCreate,
      crosspostsSkippedBySourceCooldown:
        summary.crosspostsSkippedBySourceCooldown,
      crosspostsSkippedByInFlight: summary.crosspostsSkippedByInFlight,
      crosspostsSkippedByExistingDetection:
        summary.crosspostsSkippedByExistingDetection,
      ...withErrorMessage(summary.errorMessage),
      ...logContext,
    },
    summary.status === "failed" ? "error" : "info",
  );
}

async function recordDispatchFailure(
  appSettings: ServerAppSettings,
  reason: string,
  logContext: CrosspostDispatchLogContext,
  summary: CrosspostIngestionSummary,
): Promise<void> {
  try {
    const previous = parseInt(
      (await redis.get(crosspostRetryDegradedCountKey)) ?? "0",
      10,
    );
    const consecutiveFailures = Number.isNaN(previous) ? 1 : previous + 1;
    await redis.set(
      crosspostRetryDegradedCountKey,
      consecutiveFailures.toString(),
    );
    if (consecutiveFailures >= crosspostRetryDegradedThreshold) {
      logCrosspostEvent(
        {
          event: "crosspost_retry_degraded",
          targetSubreddit: appSettings.promoSubreddit,
          reason,
          status: summary.status,
          ...withErrorMessage(summary.errorMessage),
          consecutiveFailures,
          ...logContext,
        },
        "warn",
      );
    }
  } catch (bookkeepingError) {
    logDiagnostic(
      "warn",
      "crosspost_cleanup_failed",
      { workflow: "crosspost", phase: "failure_bookkeeping" },
      bookkeepingError,
    );
  }

  logCrosspostEvent(
    {
      event: "crosspost_retry_failed",
      targetSubreddit: appSettings.promoSubreddit,
      reason,
      status: summary.status,
      revisionsFetched: summary.revisionsFetched,
      newPostsSeen: summary.newPostsSeen,
      crosspostsCreated: summary.crosspostsCreated,
      crosspostsSkipped: summary.crosspostsSkipped,
      crosspostsFailed: summary.crosspostsFailed,
      actionsMirrored: summary.actionsMirrored,
      actionsFailed: summary.actionsFailed,
      crosspostsCreatedThisRun: summary.crosspostsCreatedThisRun,
      crosspostsBlockedByRunCap: summary.crosspostsBlockedByRunCap,
      crosspostsBlockedByHourlyCap: summary.crosspostsBlockedByHourlyCap,
      crosspostPersistenceFailedAfterCreate:
        summary.crosspostPersistenceFailedAfterCreate,
      crosspostsSkippedBySourceCooldown:
        summary.crosspostsSkippedBySourceCooldown,
      crosspostsSkippedByInFlight: summary.crosspostsSkippedByInFlight,
      crosspostsSkippedByExistingDetection:
        summary.crosspostsSkippedByExistingDetection,
      ...withErrorMessage(summary.errorMessage),
      ...logContext,
    },
    "error",
  );
}
