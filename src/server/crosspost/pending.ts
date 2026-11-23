import { getExponentialJobBackoffCap } from "../jobs/backoff";
import { reddit, redis } from "@devvit/web/server";
import { type ServerAppSettings } from "../settings";
import { formatSubscriberCount } from "../../shared/numberFormat";
import {
  type PendingCrosspost,
  completeCrosspostDeletionMarkerReplay,
  getCorrespondingPost,
  hasCrosspostDeletionMarker,
  hasCrosspost,
  removePendingCrosspost,
  scheduleCrosspostDeletionMarker,
  storeCorrespondingPost,
  upsertPendingCrosspost,
} from "../data/crosspostData";
import { logCrosspostEvent, toErrorMessage } from "../utils/crosspostLogs";
import { isLinkId, type LinkId } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";
import { translate } from "../../shared/i18n/catalog";
import { getPostAvailability } from "../utils/postStatus";
import { isNsfwOrUnknown } from "../utils/subredditSafety";
import { acquireRedisLock, releaseRedisLock } from "../utils/redisOwnedLock";
import {
  crosspostCreateInFlightTtlMs,
  finalizeCrosspostPersistenceAtomic,
  hasSourceCreateCooldown,
  setSourceCreateCooldown,
  getCrosspostCreateInFlightKey,
  isSourceCreateInFlight,
  recordCrosspostCreation,
} from "./bookkeeping";
import {
  type CrosspostIngestionSummary,
  type CrosspostIngestionOptions,
} from "./summary";

const crosspostTargetDuplicateScanLimit = 25;

const isPermanentCrosspostError = (errorMessage: string): boolean =>
  /(OVER18_SUBREDDIT_CROSSPOST|SUBREDDIT_NOEXIST|INVALID_SUBREDDIT|FORBIDDEN|NOT_ALLOWED|INVALID_CROSSPOST_THING|root_post_id|link that isn't working|is private|must be a moderator|doesn't allow crossposts|does not allow crossposts)/i.test(
    errorMessage,
  );

export const isMissingSourcePostError = (errorMessage: string): boolean =>
  /(no post\s+t3_|not[\s-]?found|does not exist|deleted|no longer exists)/i.test(
    errorMessage,
  );

const normalizeTimestampMs = (value: number): number =>
  // Devvit may return timestamps in either seconds or milliseconds.
  value < 1_000_000_000_000 ? value * 1000 : value;

const getPostCreatedAtMs = (post: {
  createdAt?: Date | string | number;
}): number => {
  const rawCreatedAt = post.createdAt;
  if (rawCreatedAt instanceof Date) {
    return rawCreatedAt.getTime();
  }
  if (typeof rawCreatedAt === "number") {
    // Devvit may return timestamps in either seconds or milliseconds.
    return rawCreatedAt < 1_000_000_000_000
      ? rawCreatedAt * 1000
      : rawCreatedAt;
  }
  if (typeof rawCreatedAt === "string") {
    const parsed = Date.parse(rawCreatedAt);
    return Number.isNaN(parsed) ? NaN : parsed;
  }
  return NaN;
};

const getNextRetryDelayMs = (
  attemptCount: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number => {
  return getExponentialJobBackoffCap(
    { baseMs: baseDelayMs, maxMs: maxDelayMs },
    attemptCount + 1,
  );
};

const isRetryWindowExpired = (
  pending: PendingCrosspost,
  retryWindowMs: number,
  nowMs: number,
): boolean => nowMs - pending.firstSeenMs >= retryWindowMs;

async function findExistingTargetCrosspost(
  sourcePostId: LinkId,
  targetSubreddit: string,
): Promise<LinkId | undefined> {
  try {
    const sourceBase36 = sourcePostId.slice(3).toLowerCase();
    const posts = await reddit
      .getNewPosts({
        subredditName: targetSubreddit,
        limit: crosspostTargetDuplicateScanLimit,
      })
      .get(crosspostTargetDuplicateScanLimit);

    for (const post of posts) {
      const normalizedUrl = (post.url ?? "").toLowerCase();
      const haystack =
        `${normalizedUrl}\n${post.title ?? ""}\n${post.body ?? ""}`.toLowerCase();
      const urlReferencesSource = normalizedUrl.includes(
        `/comments/${sourceBase36}/`,
      );
      if (
        (haystack.includes(sourcePostId.toLowerCase()) ||
          urlReferencesSource) &&
        isLinkId(post.id)
      ) {
        return post.id;
      }
    }
  } catch (error) {
    logDiagnostic(
      "warn",
      "crosspost_phase_failed",
      {
        workflow: "crosspost",
        phase: "existing_target_detection",
        postId: sourcePostId,
      },
      error,
    );
  }
  return undefined;
}

type SourcePost = Awaited<ReturnType<typeof reddit.getPostById>>;

type PendingCrosspostRun = CrosspostIngestionOptions & {
  appSettings: ServerAppSettings;
  summary: CrosspostIngestionSummary;
  nowMs: number;
  retryWindowMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  hourlyHistoryKey: string;
  hourlyCreatedCount: number;
  appUserLookup?: ReturnType<typeof reddit.getAppUser>;
};

export async function processPendingCrossposts(
  duePendingCrossposts: PendingCrosspost[],
  run: PendingCrosspostRun,
): Promise<void> {
  const reconciliationFirstPending = duePendingCrossposts.filter(
    (pending) =>
      pending.status === "crosspost_reconciliation_pending" ||
      Boolean(pending.createdCrosspostId),
  );
  const normalPending = duePendingCrossposts.filter(
    (pending) =>
      pending.status !== "crosspost_reconciliation_pending" &&
      !pending.createdCrosspostId,
  );

  for (const pending of [...reconciliationFirstPending, ...normalPending]) {
    await processPendingCrosspost(run, pending);
  }
}

async function processPendingCrosspost(
  run: PendingCrosspostRun,
  pending: PendingCrosspost,
): Promise<void> {
  const { appSettings, summary } = run;
  let sourceSubredditIsNsfwOrUnknown = false;
  let sourceCreateLock: string | undefined;
  const sourceCreateLockKey = getCrosspostCreateInFlightKey(pending.postId);
  try {
    if (!(await shouldProcessPendingRevision(run, pending))) return;
    const post = await loadFreshSourcePost(run, pending);
    if (!post) return;
    const sourceSubredditInfo = await reddit.getSubredditInfoById(
      post.subredditId,
    );
    sourceSubredditIsNsfwOrUnknown = isNsfwOrUnknown(
      sourceSubredditInfo.isNsfw,
    );
    if (sourceSubredditIsNsfwOrUnknown) {
      await markTerminalFailure(run, pending, "source_subreddit_nsfw");
      return;
    }
    if (await hasCrosspost(redis, pending.postId)) {
      await removePendingCrosspost(
        redis,
        appSettings.promoSubreddit,
        pending.revisionId,
      );
      summary.crosspostsSkipped += 1;
      logCrosspostEvent({
        event: "crosspost_attempt_skipped",
        sourcePostId: pending.postId,
        targetSubreddit: appSettings.promoSubreddit,
        reason: "already_mapped",
        revisionId: pending.revisionId,
      });
      return;
    }
    if (await hasSourceCreateCooldown(redis, pending.postId)) {
      summary.crosspostsSkippedBySourceCooldown += 1;
      await scheduleRetry(run, pending, "source_post_recently_crossposted");
      return;
    }
    const existingCrosspostId = await findExistingTargetCrosspost(
      pending.postId,
      appSettings.promoSubreddit,
    );
    const reconciliationCrosspostId =
      pending.createdCrosspostId ?? existingCrosspostId;
    if (reconciliationCrosspostId) {
      await reconcilePendingCrosspost(run, pending, reconciliationCrosspostId);
      return;
    }
    if (post.nsfw === true) {
      await markTerminalFailure(run, pending, "source_post_nsfw");
      return;
    }
    if (getPostAvailability(post).status !== "active") {
      await markTerminalFailure(run, pending, "source_post_unavailable");
      return;
    }

    if (!(await hasEligibleSourceAuthor(run, pending, post))) return;
    sourceCreateLock = await acquireRedisLock(
      redis,
      sourceCreateLockKey,
      crosspostCreateInFlightTtlMs,
    );
    if (!sourceCreateLock) {
      summary.crosspostsSkippedByInFlight += 1;
      await scheduleRetry(run, pending, "source_create_inflight");
      return;
    }
    const crosspostId = await createCrosspost(
      run,
      pending,
      post,
      sourceSubredditInfo,
    );
    await persistCreatedCrosspost(run, pending, crosspostId);
  } catch (e) {
    const errorMessage = toErrorMessage(e);
    logCrosspostEvent(
      {
        event: "crosspost_attempt_failed",
        sourcePostId: pending.postId,
        targetSubreddit: appSettings.promoSubreddit,
        reason: "crosspost_processing_failed",
        revisionId: pending.revisionId,
        errorMessage,
      },
      "error",
    );
    const permanentFailure = isPermanentCrosspostError(errorMessage);
    const missingSourcePost = isMissingSourcePostError(errorMessage);
    if (
      permanentFailure ||
      sourceSubredditIsNsfwOrUnknown ||
      missingSourcePost
    ) {
      const terminalReason = sourceSubredditIsNsfwOrUnknown
        ? "source_subreddit_nsfw"
        : missingSourcePost
          ? "source_post_missing"
          : /INVALID_CROSSPOST_THING|root_post_id|link that isn't working/i.test(
                errorMessage,
              )
            ? "source_not_crosspostable"
            : "target_policy_reject_or_denied";
      await markTerminalFailure(run, pending, terminalReason, errorMessage);
      return;
    }

    summary.crosspostsFailed += 1;
    await scheduleRetry(run, pending, "crosspost_attempt_failed", errorMessage);
  } finally {
    if (sourceCreateLock) {
      await releaseRedisLock(redis, sourceCreateLockKey, sourceCreateLock, {
        event: "crosspost_cleanup_failed",
        context: {
          workflow: "crosspost",
          phase: "source_create_lock_release",
          postId: pending.postId,
        },
      });
    }
  }
}

async function shouldProcessPendingRevision(
  run: PendingCrosspostRun,
  pending: PendingCrosspost,
): Promise<boolean> {
  const {
    appSettings,
    summary,
    nowMs,
    revisionFreshnessWindowMs,
    maxCrosspostsPerRun,
    maxCrosspostsPerHour,
  } = run;
  if (await hasCrosspostDeletionMarker(redis, pending.postId)) {
    const knownMirrorId =
      pending.createdCrosspostId ??
      (await getCorrespondingPost(redis, pending.postId));
    if (knownMirrorId && isLinkId(knownMirrorId)) {
      await storeCorrespondingPost(redis, pending.postId, knownMirrorId);
      await scheduleCrosspostDeletionMarker(redis, pending.postId, nowMs);
      await removePendingCrosspost(
        redis,
        appSettings.promoSubreddit,
        pending.revisionId,
      );
    } else if (await isSourceCreateInFlight(redis, pending.postId)) {
      await scheduleRetry(run, pending, "source_delete_create_inflight");
      return false;
    } else {
      await removePendingCrosspost(
        redis,
        appSettings.promoSubreddit,
        pending.revisionId,
      );
      await completeCrosspostDeletionMarkerReplay(redis, pending.postId);
    }
    summary.crosspostsSkipped += 1;
    return false;
  }
  const revisionDateMs = pending.revisionDateMs;
  if (typeof revisionDateMs !== "number" || !Number.isFinite(revisionDateMs)) {
    console.info(
      `[crosspost] revision freshness check: revisionId=${pending.revisionId} sourcePostId=${pending.postId} revisionDateMs=unknown nowMs=${nowMs} revisionFreshnessWindowMs=${revisionFreshnessWindowMs} result=unknown`,
    );
    await scheduleRetry(run, pending, "revision_age_unknown");
    return false;
  }
  const normalizedRevisionDateMs = normalizeTimestampMs(revisionDateMs);
  const revisionAgeMs = nowMs - normalizedRevisionDateMs;
  if (revisionAgeMs > revisionFreshnessWindowMs) {
    console.info(
      `[crosspost] revision freshness check: revisionId=${pending.revisionId} sourcePostId=${pending.postId} revisionDateMs=${revisionDateMs} normalizedRevisionDateMs=${normalizedRevisionDateMs} revisionAgeMs=${revisionAgeMs} nowMs=${nowMs} revisionFreshnessWindowMs=${revisionFreshnessWindowMs} result=stale`,
    );
    await scheduleRetry(run, pending, "revision_too_old");
    return false;
  }
  if (summary.crosspostsCreatedThisRun >= maxCrosspostsPerRun) {
    summary.crosspostsBlockedByRunCap += 1;
    await scheduleRetry(run, pending, "crosspost_cap_per_run_reached");
    return false;
  }
  if (run.hourlyCreatedCount >= maxCrosspostsPerHour) {
    summary.crosspostsBlockedByHourlyCap += 1;
    await scheduleRetry(run, pending, "crosspost_cap_hourly_reached");
    return false;
  }
  return true;
}

async function loadFreshSourcePost(
  run: PendingCrosspostRun,
  pending: PendingCrosspost,
): Promise<SourcePost | undefined> {
  const { sourcePostFreshnessWindowMs } = run;
  const post = await reddit.getPostById(pending.postId);
  if (!post) {
    await markTerminalFailure(run, pending, "source_post_missing");
    return;
  }
  const createdAtMs = getPostCreatedAtMs(post);
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
    console.info(
      `[crosspost] source post freshness check: revisionId=${pending.revisionId} sourcePostId=${pending.postId} createdAtMs=unknown sourcePostFreshnessWindowMs=${sourcePostFreshnessWindowMs} result=unknown`,
    );
    await scheduleRetry(run, pending, "source_post_age_unknown");
    return;
  }
  const postAgeMs = Date.now() - createdAtMs;
  if (postAgeMs > sourcePostFreshnessWindowMs) {
    console.info(
      `[crosspost] source post freshness check: revisionId=${pending.revisionId} sourcePostId=${pending.postId} createdAtMs=${createdAtMs} postAgeMs=${postAgeMs} sourcePostFreshnessWindowMs=${sourcePostFreshnessWindowMs} result=stale`,
    );
    await scheduleRetry(run, pending, "source_post_too_old");
    return;
  }
  return post;
}

async function hasEligibleSourceAuthor(
  run: PendingCrosspostRun,
  pending: PendingCrosspost,
  post: SourcePost,
): Promise<boolean> {
  let appUserId: string | undefined;
  try {
    appUserId = (await (run.appUserLookup ??= reddit.getAppUser()))?.id;
  } catch (error) {
    logDiagnostic(
      "warn",
      "crosspost_source_author_lookup_failed",
      {
        workflow: "crosspost",
        postId: pending.postId,
      },
      error,
    );
  }
  if (!appUserId) {
    await scheduleRetry(run, pending, "source_author_lookup_failed");
    return false;
  }
  if (post.authorId !== appUserId) {
    await markTerminalFailure(run, pending, "source_post_non_app_author");
    return false;
  }
  return true;
}

async function reconcilePendingCrosspost(
  run: PendingCrosspostRun,
  pending: PendingCrosspost,
  reconciliationCrosspostId: LinkId,
): Promise<void> {
  const { appSettings, summary, nowMs } = run;
  logCrosspostEvent({
    event: "crosspost_reconciliation_started",
    sourcePostId: pending.postId,
    targetSubreddit: appSettings.promoSubreddit,
    crosspostId: reconciliationCrosspostId,
    reason: pending.createdCrosspostId
      ? "reconcile_from_saved_crosspost_id"
      : "reconcile_from_existing_detection",
    revisionId: pending.revisionId,
    ...(pending.reconciliationAttemptCount
      ? { reconciliationAttemptCount: pending.reconciliationAttemptCount }
      : {}),
  });
  try {
    if (await hasCrosspostDeletionMarker(redis, pending.postId)) {
      await storeCorrespondingPost(
        redis,
        pending.postId,
        reconciliationCrosspostId,
      );
      await scheduleCrosspostDeletionMarker(redis, pending.postId, nowMs);
      await removePendingCrosspost(
        redis,
        appSettings.promoSubreddit,
        pending.revisionId,
      );
      summary.crosspostsSkipped += 1;
      return;
    }
    await finalizeCrosspostPersistenceAtomic({
      redisClient: redis,
      targetSubreddit: appSettings.promoSubreddit,
      sourcePostId: pending.postId,
      crosspostId: reconciliationCrosspostId,
      revisionId: pending.revisionId,
    });
    if (await hasCrosspostDeletionMarker(redis, pending.postId)) {
      try {
        await scheduleCrosspostDeletionMarker(redis, pending.postId, nowMs);
      } catch (handoffError) {
        await upsertPendingCrosspost(redis, appSettings.promoSubreddit, {
          ...pending,
          createdCrosspostId: reconciliationCrosspostId,
          nextAttemptMs: nowMs,
          status: "crosspost_reconciliation_pending",
          lastError: toErrorMessage(handoffError),
        });
        throw handoffError;
      }
    }
    summary.crosspostsSkipped += 1;
    summary.crosspostsSkippedByExistingDetection += 1;
    logCrosspostEvent({
      event: "crosspost_reconciliation_succeeded",
      sourcePostId: pending.postId,
      targetSubreddit: appSettings.promoSubreddit,
      crosspostId: reconciliationCrosspostId,
      reason: "reconciliation_mapping_backfilled",
      revisionId: pending.revisionId,
      ...(pending.reconciliationAttemptCount
        ? { reconciliationAttemptCount: pending.reconciliationAttemptCount }
        : {}),
    });
    return;
  } catch (reconcileError) {
    const reconcileErrorMessage = toErrorMessage(reconcileError);
    logCrosspostEvent(
      {
        event: "crosspost_reconciliation_failed",
        sourcePostId: pending.postId,
        targetSubreddit: appSettings.promoSubreddit,
        crosspostId: reconciliationCrosspostId,
        reason: "reconciliation_finalize_failed",
        revisionId: pending.revisionId,
        ...(pending.reconciliationAttemptCount
          ? {
              reconciliationAttemptCount:
                pending.reconciliationAttemptCount + 1,
            }
          : { reconciliationAttemptCount: 1 }),
        errorMessage: reconcileErrorMessage,
      },
      "warn",
    );
    await scheduleRetry(
      run,
      pending,
      "crosspost_reconciliation_failed",
      reconcileErrorMessage,
      {
        createdCrosspostId: reconciliationCrosspostId,
        forceReconciliation: true,
        incrementReconciliation: true,
      },
    );
    return;
  }
}

async function createCrosspost(
  run: PendingCrosspostRun,
  pending: PendingCrosspost,
  post: SourcePost,
  sourceSubredditInfo: Awaited<ReturnType<typeof reddit.getSubredditInfoById>>,
): Promise<string> {
  const { appSettings, nowMs } = run;
  logCrosspostEvent({
    event: "crosspost_attempt_started",
    sourcePostId: pending.postId,
    targetSubreddit: appSettings.promoSubreddit,
    reason: "dispatch_new_post",
    revisionId: pending.revisionId,
  });

  let crosspostId: string;
  try {
    const crosspost = await reddit.crosspost({
      subredditName: appSettings.promoSubreddit,
      title: translate(
        (sourceSubredditInfo as { language?: unknown }).language,
        "outbound.crosspost.titleV2",
        {
          subredditName: post.subredditName,
          goal: formatSubscriberCount(pending.goal),
        },
      ),
      postId: post.id,
      nsfw: post.nsfw ?? sourceSubredditInfo.isNsfw,
    });
    crosspostId = crosspost.id;
    if (await hasCrosspostDeletionMarker(redis, pending.postId)) {
      await upsertPendingCrosspost(redis, appSettings.promoSubreddit, {
        ...pending,
        createdCrosspostId: crosspostId as LinkId,
        nextAttemptMs: nowMs,
        status: "crosspost_reconciliation_pending",
        lastError: null,
      });
      await storeCorrespondingPost(redis, pending.postId, crosspostId);
      await scheduleCrosspostDeletionMarker(redis, pending.postId, nowMs);
    }
  } catch (error) {
    logCrosspostEvent(
      {
        event: "crosspost_attempt_failed",
        sourcePostId: pending.postId,
        targetSubreddit: appSettings.promoSubreddit,
        reason: "dispatch_new_post",
        revisionId: pending.revisionId,
        errorMessage: toErrorMessage(error),
      },
      "error",
    );
    throw error;
  }
  logCrosspostEvent({
    event: "crosspost_attempt_succeeded",
    sourcePostId: pending.postId,
    targetSubreddit: appSettings.promoSubreddit,
    crosspostId,
    reason: "crosspost_succeeded",
    revisionId: pending.revisionId,
  });

  try {
    await setSourceCreateCooldown(redis, pending.postId);
  } catch (cooldownError) {
    logDiagnostic(
      "warn",
      "crosspost_phase_failed",
      {
        workflow: "crosspost",
        phase: "source_create_cooldown",
        postId: pending.postId,
      },
      cooldownError,
    );
  }
  return crosspostId;
}

async function persistCreatedCrosspost(
  run: PendingCrosspostRun,
  pending: PendingCrosspost,
  crosspostId: string,
): Promise<void> {
  const { appSettings, summary, nowMs, hourlyHistoryKey } = run;
  try {
    await finalizeCrosspostPersistenceAtomic({
      redisClient: redis,
      targetSubreddit: appSettings.promoSubreddit,
      sourcePostId: pending.postId,
      crosspostId: crosspostId as LinkId,
      revisionId: pending.revisionId,
    });
    if (await hasCrosspostDeletionMarker(redis, pending.postId)) {
      try {
        await scheduleCrosspostDeletionMarker(redis, pending.postId, nowMs);
      } catch (handoffError) {
        await upsertPendingCrosspost(redis, appSettings.promoSubreddit, {
          ...pending,
          createdCrosspostId: crosspostId as LinkId,
          nextAttemptMs: nowMs,
          status: "crosspost_reconciliation_pending",
          lastError: toErrorMessage(handoffError),
        });
        throw handoffError;
      }
    }
    summary.crosspostsCreated += 1;
    summary.crosspostsCreatedThisRun += 1;
    run.hourlyCreatedCount += 1;
    await recordCrosspostCreation(
      redis,
      hourlyHistoryKey,
      pending.revisionId,
      Date.now(),
    );
  } catch (finalizeError) {
    const finalizeErrorMessage = toErrorMessage(finalizeError);
    summary.crosspostPersistenceFailedAfterCreate += 1;
    logCrosspostEvent(
      {
        event: "crosspost_finalize_transaction_failed",
        sourcePostId: pending.postId,
        targetSubreddit: appSettings.promoSubreddit,
        crosspostId,
        reason: "crosspost_finalize_transaction_failed",
        revisionId: pending.revisionId,
        errorMessage: finalizeErrorMessage,
      },
      "error",
    );
    await scheduleRetry(
      run,
      pending,
      "crosspost_persistence_failed_after_create",
      finalizeErrorMessage,
      {
        createdCrosspostId: crosspostId as LinkId,
        persistenceFailureReason: "crosspost_finalize_transaction_failed",
        forceReconciliation: true,
        incrementReconciliation: true,
      },
    );
    logCrosspostEvent(
      {
        event: "crosspost_persistence_failed_after_create",
        sourcePostId: pending.postId,
        targetSubreddit: appSettings.promoSubreddit,
        crosspostId,
        reason: "crosspost_persistence_failed_after_create",
        revisionId: pending.revisionId,
        errorMessage: finalizeErrorMessage,
      },
      "error",
    );
  }
}

async function scheduleRetry(
  run: PendingCrosspostRun,
  pending: PendingCrosspost,
  reason: string,
  errorMessage?: string,
  options?: {
    createdCrosspostId?: LinkId;
    persistenceFailureReason?: string;
    forceReconciliation?: boolean;
    incrementReconciliation?: boolean;
  },
): Promise<void> {
  const {
    appSettings,
    nowMs,
    retryWindowMs,
    retryBaseDelayMs,
    retryMaxDelayMs,
    summary,
  } = run;
  const nextReconciliationAttemptCount =
    (pending.reconciliationAttemptCount ?? 0) +
    (options?.incrementReconciliation ? 1 : 0);
  const nextCreatedCrosspostId =
    options?.createdCrosspostId ?? pending.createdCrosspostId;
  if (
    isRetryWindowExpired(pending, retryWindowMs, nowMs) &&
    !reason.startsWith("delete_marker_")
  ) {
    await removePendingCrosspost(
      redis,
      appSettings.promoSubreddit,
      pending.revisionId,
    );
    summary.crosspostsSkipped += 1;
    logRetrySkip(
      pending,
      appSettings.promoSubreddit,
      `${reason}_retry_window_expired`,
      nextCreatedCrosspostId,
      nextReconciliationAttemptCount,
      options?.persistenceFailureReason,
      errorMessage,
    );
    return;
  }

  const nextDelayMs = getNextRetryDelayMs(
    pending.attemptCount,
    retryBaseDelayMs,
    retryMaxDelayMs,
  );
  await upsertPendingCrosspost(redis, appSettings.promoSubreddit, {
    ...pending,
    attemptCount: pending.attemptCount + 1,
    nextAttemptMs: nowMs + nextDelayMs,
    lastError: errorMessage ?? reason,
    status:
      options?.forceReconciliation || nextCreatedCrosspostId
        ? "crosspost_reconciliation_pending"
        : "crosspost_retrying",
    ...(nextCreatedCrosspostId
      ? { createdCrosspostId: nextCreatedCrosspostId }
      : {}),
    ...(options?.persistenceFailureReason
      ? { persistenceFailureReason: options.persistenceFailureReason }
      : pending.persistenceFailureReason
        ? { persistenceFailureReason: pending.persistenceFailureReason }
        : {}),
    ...(nextReconciliationAttemptCount > 0
      ? { reconciliationAttemptCount: nextReconciliationAttemptCount }
      : {}),
  });
  summary.crosspostsSkipped += 1;
  logRetrySkip(
    pending,
    appSettings.promoSubreddit,
    reason,
    nextCreatedCrosspostId,
    nextReconciliationAttemptCount,
    options?.persistenceFailureReason,
    errorMessage,
  );
  console.info(
    `[crosspost] crosspost_retrying: revisionId=${pending.revisionId} postId=${pending.postId} reason=${reason} attempt=${pending.attemptCount + 1} nextAttemptMs=${nowMs + nextDelayMs}`,
  );
}

function logRetrySkip(
  pending: PendingCrosspost,
  targetSubreddit: string,
  reason: string,
  nextCreatedCrosspostId: LinkId | undefined,
  nextReconciliationAttemptCount: number,
  persistenceFailureReason: string | undefined,
  errorMessage: string | undefined,
): void {
  logCrosspostEvent(
    {
      event: "crosspost_attempt_skipped",
      sourcePostId: pending.postId,
      targetSubreddit: targetSubreddit,
      reason,
      revisionId: pending.revisionId,
      ...(nextCreatedCrosspostId
        ? { crosspostId: nextCreatedCrosspostId }
        : {}),
      ...(nextReconciliationAttemptCount > 0
        ? { reconciliationAttemptCount: nextReconciliationAttemptCount }
        : {}),
      ...(persistenceFailureReason
        ? { persistenceFailureReason: persistenceFailureReason }
        : {}),
      ...(errorMessage ? { errorMessage } : {}),
    },
    "warn",
  );
}

async function markTerminalFailure(
  run: PendingCrosspostRun,
  pending: PendingCrosspost,
  reason: string,
  errorMessage?: string,
): Promise<void> {
  const { appSettings, summary } = run;
  await removePendingCrosspost(
    redis,
    appSettings.promoSubreddit,
    pending.revisionId,
  );
  summary.crosspostsSkipped += 1;
  logCrosspostEvent(
    {
      event: "crosspost_attempt_skipped",
      sourcePostId: pending.postId,
      targetSubreddit: appSettings.promoSubreddit,
      reason,
      revisionId: pending.revisionId,
      ...(pending.createdCrosspostId
        ? { crosspostId: pending.createdCrosspostId }
        : {}),
      ...(pending.reconciliationAttemptCount
        ? { reconciliationAttemptCount: pending.reconciliationAttemptCount }
        : {}),
      ...(pending.persistenceFailureReason
        ? { persistenceFailureReason: pending.persistenceFailureReason }
        : {}),
      ...(errorMessage ? { errorMessage } : {}),
    },
    "warn",
  );
}
