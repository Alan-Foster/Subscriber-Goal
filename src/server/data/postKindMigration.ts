import { EntrypointHeight } from "@devvit/web/server";
import {
  ctaOnlyPostKind,
  subscriberGoalPostKind,
  subscribeOnlyPostKind,
} from "../../shared/postKind";
import { shortSubGoalPostHeightPixels } from "../../shared/subGoalPostHeight";
import { logDiagnostic } from "../../shared/diagnostics";
import type { RedditClient, RedisClient } from "../types";
import { isLinkId } from "../types";
import { isArchivedPostMutationError } from "../utils/communityHighlights";
import { getPostAvailability, isMissingPostError } from "../utils/postStatus";
import { releaseOwnedRedisLock } from "../utils/redisOwnedLock";
import {
  getSubGoalData,
  postHeightSuffix,
  postKindSuffix,
  subscriberGoalsKey,
} from "./subGoalData";

export const postKindMigrationStateKey = "post_kind_migration_v1_state";
export const postKindMigrationQueueKey = "post_kind_migration_v1_queue";
export const postKindMigrationVersion = "post_kind_v1";
export const postKindMigrationTerminalKey = "post_kind_migration_v1_terminal";
const postKindMigrationAttemptsKey = "post_kind_migration_v1_attempts";
const postKindMigrationLockKey = "post_kind_migration_v1_lock";
const retryBaseMs = 5 * 60 * 1000;
const retryWindowMs = 24 * 60 * 60 * 1000;
const firstFailureField = (postId: string) => `${postId}:first_failed_at`;

export type PostKindMigrationSummary = {
  scanned: number;
  repaired: number;
  preservedShort: number;
  recognizedTiny: number;
  conflicting: number;
  failed: number;
};

const emptySummary = (): PostKindMigrationSummary => ({
  scanned: 0,
  repaired: 0,
  preservedShort: 0,
  recognizedTiny: 0,
  conflicting: 0,
  failed: 0,
});

export async function initializePostKindMigration(
  redis: RedisClient,
  trackedPostIds: string[],
): Promise<void> {
  const version = await redis.hGet(postKindMigrationStateKey, "version");
  if (version === postKindMigrationVersion) {
    return;
  }
  if (trackedPostIds.length > 0) {
    await redis.zAdd(
      postKindMigrationQueueKey,
      ...trackedPostIds.map((postId, index) => ({
        member: postId,
        score: index,
      })),
    );
  }
  await redis.hSet(postKindMigrationStateKey, {
    version: postKindMigrationVersion,
    status: trackedPostIds.length > 0 ? "pending" : "complete",
    scanned: "0",
    repaired: "0",
    preservedShort: "0",
    recognizedTiny: "0",
    conflicting: "0",
    failed: "0",
  });
}

export async function processPostKindMigrationBatch(
  reddit: RedditClient,
  redis: RedisClient,
  batchSize = 10,
): Promise<PostKindMigrationSummary> {
  const [version, status] = await redis.hMGet(postKindMigrationStateKey, [
    "version",
    "status",
  ]);
  if (version !== postKindMigrationVersion || status === "complete") {
    return emptySummary();
  }
  const now = Date.now();
  const lockToken = `${now}:${Math.random().toString(36).slice(2)}`;
  await redis.set(postKindMigrationLockKey, lockToken, {
    nx: true,
    expiration: new Date(now + 5 * 60 * 1000),
  });
  if ((await redis.get(postKindMigrationLockKey)) !== lockToken) {
    return emptySummary();
  }
  try {
    return await migratePendingPostKinds(reddit, redis, batchSize);
  } finally {
    try {
      await releaseOwnedRedisLock(redis, postKindMigrationLockKey, lockToken);
    } catch (error) {
      logDiagnostic(
        "warn",
        "migration_lock_release_failed",
        { workflow: "post_kind_migration", phase: "lock_release" },
        error,
      );
    }
  }
}

async function removePendingPost(redis: RedisClient, postId: string) {
  await redis.hDel(postKindMigrationAttemptsKey, [
    postId,
    firstFailureField(postId),
  ]);
  await redis.zRem(postKindMigrationQueueKey, [postId]);
}

async function markTerminalPost(
  redis: RedisClient,
  postId: string,
  category: string,
  phase: string,
  error?: unknown,
) {
  await redis.hSet(postKindMigrationTerminalKey, { [postId]: category });
  await removePendingPost(redis, postId);
  logDiagnostic(
    "warn",
    "migration_record_terminal",
    { workflow: "post_kind_migration", phase, postId, category },
    error,
  );
}

async function schedulePostKindMigrationRetry(
  redis: RedisClient,
  postId: string,
  error: unknown,
): Promise<void> {
  const failedAt = Date.now();
  const firstFailure = firstFailureField(postId);
  const [storedAttempts, storedFirstFailureAt] = await redis.hMGet(
    postKindMigrationAttemptsKey,
    [postId, firstFailure],
  );
  const firstFailedAt = Number(storedFirstFailureAt ?? failedAt);
  const deadline = firstFailedAt + retryWindowMs;
  if (failedAt >= deadline) {
    await markTerminalPost(redis, postId, "retry_exhausted", "record", error);
    return;
  }

  const attempts =
    storedFirstFailureAt == null ? 1 : Number(storedAttempts ?? 0) + 1;
  // Try at the end of the window if doubling would overshoot it, while
  // retaining the minimum delay when a scheduler tick ran late.
  const delay = Math.max(
    retryBaseMs,
    Math.min(retryBaseMs * 2 ** (attempts - 1), deadline - failedAt),
  );
  const retryAt = failedAt + delay;
  const transaction = await redis.watch(postKindMigrationQueueKey);
  let multiStarted = false;
  try {
    await transaction.multi();
    multiStarted = true;
    await transaction.hSet(postKindMigrationAttemptsKey, {
      [postId]: String(attempts),
      [firstFailure]: String(firstFailedAt),
    });
    await transaction.zAdd(postKindMigrationQueueKey, {
      member: postId,
      score: retryAt,
    });
    const result = await transaction.exec();
    if (result.length === 0) {
      throw new Error(
        "Post-kind migration queue changed while scheduling a retry.",
      );
    }
  } catch (error) {
    try {
      await (multiStarted ? transaction.discard() : transaction.unwatch());
    } catch {
      // diagnostic-allow-silent: preserve the original transaction error.
    }
    throw error;
  }
  logDiagnostic(
    "error",
    "migration_record_failed",
    {
      workflow: "post_kind_migration",
      phase: "record",
      postId,
      attempts,
      retryAt,
    },
    error,
  );
}

async function migratePendingPostKinds(
  reddit: RedditClient,
  redis: RedisClient,
  batchSize: number,
): Promise<PostKindMigrationSummary> {
  const summary = emptySummary();
  const now = Date.now();
  const pending = await redis.zRange(
    postKindMigrationQueueKey,
    0,
    Math.max(0, Math.floor(batchSize) - 1),
  );

  // Original queue scores are small ordinal values. Retry scores are epoch
  // milliseconds, so untried records stay ahead of delayed retries.
  for (const { member: postId, score } of pending) {
    if (score > now) break;
    summary.scanned += 1;
    if (await redis.hGet(postKindMigrationTerminalKey, postId)) {
      await removePendingPost(redis, postId);
      continue;
    }
    if (!isLinkId(postId)) {
      await markTerminalPost(
        redis,
        postId,
        "invalid_post_id",
        "record_validation",
      );
      continue;
    }
    try {
      const [rawKind, rawHeight] = await redis.hMGet(subscriberGoalsKey, [
        `${postId}${postKindSuffix}`,
        `${postId}${postHeightSuffix}`,
      ]);
      const data = await getSubGoalData(redis, postId);
      const post = await reddit.getPostById(postId).catch((error: unknown) => {
        if (isMissingPostError(error, postId)) return null;
        throw error;
      });
      const availability = getPostAvailability(post);
      if (post === null || availability.status === "terminal") {
        await markTerminalPost(
          redis,
          postId,
          availability.status === "terminal" ? "post_deleted" : "post_missing",
          "post_lookup",
        );
        summary.failed += 1;
        continue;
      }

      const kindHeightConflict =
        (rawKind === subscriberGoalPostKind &&
          (rawHeight === "tiny" || rawHeight === "cta")) ||
        (rawKind === subscribeOnlyPostKind && rawHeight !== "tiny") ||
        (rawKind === ctaOnlyPostKind && rawHeight !== "cta") ||
        (rawHeight === "tiny" && rawKind !== subscribeOnlyPostKind) ||
        (rawHeight === "cta" && rawKind !== ctaOnlyPostKind);
      if (kindHeightConflict) {
        summary.conflicting += 1;
        await redis.hSet(postKindMigrationTerminalKey, {
          [postId]: JSON.stringify({ rawKind, rawHeight }),
        });
        await removePendingPost(redis, postId);
        logDiagnostic("warn", "post_kind_metadata_conflict_preserved", {
          workflow: "post_kind_migration",
          phase: "classification",
          postId,
          rawKind: rawKind ?? "missing",
          rawHeight: rawHeight ?? "missing",
        });
        continue;
      }

      const isCompactPost =
        data.postKind === subscribeOnlyPostKind ||
        data.postKind === ctaOnlyPostKind;
      const postKind = isCompactPost ? data.postKind : subscriberGoalPostKind;
      const postHeight = isCompactPost
        ? data.postHeight
        : data.postHeight === "short"
          ? "short"
          : "regular";
      if (!post.archived) {
        try {
          await post.mergePostData({ postKind });
          if (postHeight === "short") {
            await post.setCustomPostStyles({
              height: EntrypointHeight.HEIGHT_UNSPECIFIED,
              heightPixels: shortSubGoalPostHeightPixels,
            });
          }
        } catch (error) {
          if (!isArchivedPostMutationError(error)) throw error;
        }
      }
      await redis.hSet(subscriberGoalsKey, {
        [`${postId}${postKindSuffix}`]: postKind,
        [`${postId}${postHeightSuffix}`]: postHeight,
      });
      await removePendingPost(redis, postId);
      if (isCompactPost) summary.recognizedTiny += 1;
      if (postHeight === "short") summary.preservedShort += 1;
    } catch (error) {
      // A terminal write can succeed even when queue cleanup fails.
      if (await redis.hGet(postKindMigrationTerminalKey, postId)) throw error;
      summary.failed += 1;
      await schedulePostKindMigrationRetry(redis, postId, error);
    }
  }

  const remaining = await redis.zRange(postKindMigrationQueueKey, 0, 0);
  const previous = await redis.hGetAll(postKindMigrationStateKey);
  const total = (field: keyof PostKindMigrationSummary): string =>
    ((parseInt(previous[field] ?? "0", 10) || 0) + summary[field]).toString();
  await redis.hSet(postKindMigrationStateKey, {
    version: postKindMigrationVersion,
    status: remaining.length === 0 ? "complete" : "running",
    scanned: total("scanned"),
    repaired: total("repaired"),
    preservedShort: total("preservedShort"),
    recognizedTiny: total("recognizedTiny"),
    conflicting: total("conflicting"),
    failed: total("failed"),
  });
  if (summary.scanned > 0) {
    console.info(
      `[postKindMigration] batch: scanned=${summary.scanned} repaired=${summary.repaired} preservedShort=${summary.preservedShort} recognizedTiny=${summary.recognizedTiny} conflicting=${summary.conflicting} failed=${summary.failed} remaining=${remaining.length > 0}`,
    );
  }
  return summary;
}
