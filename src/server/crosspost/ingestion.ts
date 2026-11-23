import { reddit, redis } from "@devvit/web/server";
import { type ServerAppSettings } from "../settings";
import {
  completeCrosspostDeletionMarkerReplay,
  getPendingCrosspost,
  getCorrespondingPost,
  listDuePendingCrossposts,
  listDueCrosspostDeletionMarkers,
  removeCorrespondingPost,
  scheduleCrosspostDeletionMarker,
  storeProcessedRevision,
  upsertPendingCrosspost,
} from "../data/crosspostData";
import { logCrosspostEvent, toErrorMessage } from "../utils/crosspostLogs";
import { isLinkId } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";
import {
  crosspostHourlyCreationHistoryKeyPrefix,
  toNormalizedSubredditName,
  isSourceCreateInFlight,
  getCurrentHourlyCrosspostCount,
} from "./bookkeeping";
import {
  type CrosspostIngestionSummary,
  emptySummary,
  type CrosspostIngestionOptions,
} from "./summary";
import {
  type NewPostEvent,
  getNewPosts,
  getNewPostActions,
} from "./wikiRevisions";
import { processPendingCrossposts } from "./pending";
import { mirrorPostAction } from "./moderation";

const getCrosspostRetryWindowMs = (appSettings: ServerAppSettings): number => {
  const minutes =
    Number.isFinite(appSettings.crosspostRetryWindowMinutes) &&
    appSettings.crosspostRetryWindowMinutes > 0
      ? Math.floor(appSettings.crosspostRetryWindowMinutes)
      : 1440;
  return minutes * 60 * 1000;
};

const getCrosspostRetryBaseDelayMs = (
  appSettings: ServerAppSettings,
): number => {
  const seconds =
    Number.isFinite(appSettings.crosspostRetryBaseDelaySeconds) &&
    appSettings.crosspostRetryBaseDelaySeconds > 0
      ? Math.floor(appSettings.crosspostRetryBaseDelaySeconds)
      : 60;
  return seconds * 1000;
};

const getCrosspostRetryMaxDelayMs = (
  appSettings: ServerAppSettings,
): number => {
  const minutes =
    Number.isFinite(appSettings.crosspostRetryMaxDelayMinutes) &&
    appSettings.crosspostRetryMaxDelayMinutes > 0
      ? Math.floor(appSettings.crosspostRetryMaxDelayMinutes)
      : 30;
  return minutes * 60 * 1000;
};

const getCrosspostPendingBatchSize = (
  appSettings: ServerAppSettings,
): number =>
  Number.isFinite(appSettings.crosspostPendingBatchSize) &&
  appSettings.crosspostPendingBatchSize > 0
    ? Math.floor(appSettings.crosspostPendingBatchSize)
    : 25;

export async function updateFromWikis(
  appSettings: ServerAppSettings,
  options: CrosspostIngestionOptions,
): Promise<CrosspostIngestionSummary> {
  const summary = emptySummary();
  const fetchErrors: string[] = [];
  let fetchFailureCount = 0;
  let fetchSuccessCount = 0;
  const nowMs = Date.now();
  const hourlyHistoryKey = `${crosspostHourlyCreationHistoryKeyPrefix}:${toNormalizedSubredditName(
    appSettings.promoSubreddit,
  )}`;
  const hourlyCreatedCount = await getCurrentHourlyCrosspostCount(
    redis,
    hourlyHistoryKey,
    nowMs,
  );
  const retryWindowMs = getCrosspostRetryWindowMs(appSettings);
  const retryBaseDelayMs = getCrosspostRetryBaseDelayMs(appSettings);
  const retryMaxDelayMs = getCrosspostRetryMaxDelayMs(appSettings);
  const pendingBatchSize = getCrosspostPendingBatchSize(appSettings);
  await replayDeletionMarkers(
    appSettings,
    summary,
    nowMs,
    pendingBatchSize,
    retryBaseDelayMs,
  );
  const newPostBatch = await getNewPosts(appSettings);
  summary.revisionsFetched += newPostBatch.revisionsFetched;
  if (newPostBatch.ok) {
    fetchSuccessCount += 1;
  } else {
    fetchFailureCount += 1;
    if (newPostBatch.errorMessage) {
      fetchErrors.push(`post:${newPostBatch.errorMessage}`);
    }
  }

  const newPostIds = newPostBatch.events;
  summary.newPostsSeen = newPostIds.length;
  await enqueueNewPosts(appSettings, summary, nowMs, newPostIds);
  const duePendingCrossposts = await listDuePendingCrossposts(
    redis,
    appSettings.promoSubreddit,
    { nowMs, limit: pendingBatchSize },
  );
  await processPendingCrossposts(duePendingCrossposts, {
    appSettings,
    ...options,
    summary,
    nowMs,
    retryWindowMs,
    retryBaseDelayMs,
    retryMaxDelayMs,
    hourlyHistoryKey,
    hourlyCreatedCount,
  });
  const actionBatches = await Promise.all([
    getNewPostActions(appSettings, "remove"),
    getNewPostActions(appSettings, "approve"),
    getNewPostActions(appSettings, "delete"),
  ]);
  const postActions = actionBatches.flatMap((batch) => batch.events);
  for (const batch of actionBatches) {
    summary.revisionsFetched += batch.revisionsFetched;
    if (batch.ok) {
      fetchSuccessCount += 1;
    } else {
      fetchFailureCount += 1;
      if (batch.errorMessage) {
        fetchErrors.push(batch.errorMessage);
      }
    }
  }

  for (const postAction of postActions) {
    await mirrorPostAction(appSettings, summary, nowMs, postAction);
  }

  if (fetchFailureCount > 0 && fetchSuccessCount === 0) {
    summary.status = "failed";
  } else if (fetchFailureCount > 0) {
    summary.status = "partial";
  } else {
    summary.status = "success";
  }

  if (fetchErrors.length > 0) {
    summary.errorMessage = fetchErrors.join(" | ");
  }

  return summary;
}

async function replayDeletionMarkers(
  appSettings: ServerAppSettings,
  summary: CrosspostIngestionSummary,
  nowMs: number,
  pendingBatchSize: number,
  retryBaseDelayMs: number,
): Promise<void> {
  const dueDeletionMarkers = await listDueCrosspostDeletionMarkers(redis, {
    nowMs,
    limit: pendingBatchSize,
  });
  for (const sourcePostId of dueDeletionMarkers) {
    try {
      const mappedMirrorId = await getCorrespondingPost(redis, sourcePostId);
      if (!mappedMirrorId || !isLinkId(mappedMirrorId)) {
        if (mappedMirrorId) await removeCorrespondingPost(redis, sourcePostId);
        if (await isSourceCreateInFlight(redis, sourcePostId)) {
          await scheduleCrosspostDeletionMarker(
            redis,
            sourcePostId,
            nowMs + retryBaseDelayMs,
          );
          continue;
        }
        await completeCrosspostDeletionMarkerReplay(redis, sourcePostId);
        continue;
      }
      const mirror = await reddit.getPostById(mappedMirrorId);
      if (!mirror) {
        await removeCorrespondingPost(redis, sourcePostId);
        await completeCrosspostDeletionMarkerReplay(redis, sourcePostId);
        continue;
      }
      if (
        mirror.subredditName.toLowerCase() !==
        appSettings.promoSubreddit.toLowerCase()
      ) {
        await removeCorrespondingPost(redis, sourcePostId);
        await completeCrosspostDeletionMarkerReplay(redis, sourcePostId);
        continue;
      }
      await mirror.delete();
      await removeCorrespondingPost(redis, sourcePostId);
      await completeCrosspostDeletionMarkerReplay(redis, sourcePostId);
      summary.actionsMirrored += 1;
    } catch (error) {
      logDiagnostic(
        "warn",
        "crosspost_delete_marker_replay_failed",
        {
          workflow: "crosspost",
          phase: "delete_marker_replay",
          postId: sourcePostId,
        },
        error,
      );
      const message = toErrorMessage(error);
      if (
        /not[\s-]?found|does not exist|deleted|no longer exists/i.test(message)
      ) {
        await removeCorrespondingPost(redis, sourcePostId);
        await completeCrosspostDeletionMarkerReplay(redis, sourcePostId);
      } else {
        await scheduleCrosspostDeletionMarker(
          redis,
          sourcePostId,
          nowMs + retryBaseDelayMs,
        );
        summary.actionsFailed += 1;
      }
    }
  }
}

async function enqueueNewPosts(
  appSettings: ServerAppSettings,
  summary: CrosspostIngestionSummary,
  nowMs: number,
  newPostIds: NewPostEvent[],
): Promise<void> {
  for (const newPost of newPostIds) {
    try {
      const existing = await getPendingCrosspost(
        redis,
        appSettings.promoSubreddit,
        newPost.revisionId,
      );
      await upsertPendingCrosspost(redis, appSettings.promoSubreddit, {
        revisionId: newPost.revisionId,
        postId: newPost.postId,
        goal: newPost.goal,
        firstSeenMs: existing?.firstSeenMs ?? nowMs,
        nextAttemptMs: existing?.nextAttemptMs ?? nowMs,
        attemptCount: existing?.attemptCount ?? 0,
        lastError: existing?.lastError ?? null,
        status: existing?.status ?? "queued_for_crosspost",
        ...(typeof newPost.revisionDateMs === "number"
          ? { revisionDateMs: newPost.revisionDateMs }
          : {}),
      });
      await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
      logCrosspostEvent({
        event: "crosspost_attempt_started",
        sourcePostId: newPost.postId,
        targetSubreddit: appSettings.promoSubreddit,
        reason: "queued_for_crosspost",
        revisionId: newPost.revisionId,
      });
    } catch (queueError) {
      summary.crosspostsFailed += 1;
      logCrosspostEvent(
        {
          event: "crosspost_attempt_failed",
          sourcePostId: newPost.postId,
          targetSubreddit: appSettings.promoSubreddit,
          reason: "queue_enqueue_failed",
          revisionId: newPost.revisionId,
          errorMessage: toErrorMessage(queueError),
        },
        "error",
      );
    }
  }
}
