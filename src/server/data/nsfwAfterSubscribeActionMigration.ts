import {
  createDefaultCreatePostAction,
  defaultAfterSubscribeColorTheme,
} from "../../shared/afterSubscribeAction";
import { logDiagnostic } from "../../shared/diagnostics";
import { isLinkId, type RedisClient } from "../types";
import {
  getSubGoalData,
  postAfterSubscribeActionSuffix,
  postAfterSubscribeButtonTextSuffix,
  postAfterSubscribeColorThemeSuffix,
  postAfterSubscribePresetSuffix,
  postAfterSubscribeUrlSuffix,
  setAfterSubscribeActionForPost,
  subscriberGoalsKey,
} from "./subGoalData";

export const nsfwAfterSubscribeActionMigrationStateKey =
  "nsfw_after_subscribe_action_migration_v1_state";
export const nsfwAfterSubscribeActionMigrationQueueKey =
  "nsfw_after_subscribe_action_migration_v1_queue";
export const nsfwAfterSubscribeActionMigrationVersion =
  "nsfw_after_subscribe_action_v1";
export const nsfwAfterSubscribeActionMigrationLockKeyPrefix =
  "nsfw_after_subscribe_action_migration_v1_lock";
export const nsfwAfterSubscribeActionMigrationTerminalKey =
  "nsfw_after_subscribe_action_migration_v1_terminal";

export type NsfwAfterSubscribeActionMigrationSubreddit = {
  name: string;
  nsfw?: unknown;
};

export type NsfwAfterSubscribeActionMigrationSummary = {
  scanned: number;
  converted: number;
  preserved: number;
  raced: number;
  terminal: number;
  failed: number;
};

const batchSize = 25;
const lockTtlMs = 30_000;

const getRawActionFields = (postId: string): string[] => [
  `${postId}${postAfterSubscribeActionSuffix}`,
  `${postId}${postAfterSubscribeButtonTextSuffix}`,
  `${postId}${postAfterSubscribeUrlSuffix}`,
  `${postId}${postAfterSubscribeColorThemeSuffix}`,
  `${postId}${postAfterSubscribePresetSuffix}`,
];

const emptySummary = (): NsfwAfterSubscribeActionMigrationSummary => ({
  scanned: 0,
  converted: 0,
  preserved: 0,
  raced: 0,
  terminal: 0,
  failed: 0,
});

export async function initializeNsfwAfterSubscribeActionMigration(
  redis: RedisClient,
  candidatePostIds: string[],
  subreddit: NsfwAfterSubscribeActionMigrationSubreddit,
): Promise<void> {
  const version = await redis.hGet(
    nsfwAfterSubscribeActionMigrationStateKey,
    "version",
  );
  if (version === nsfwAfterSubscribeActionMigrationVersion) return;

  const candidates = subreddit.nsfw === true ? candidatePostIds : [];
  if (candidates.length > 0) {
    await redis.zAdd(
      nsfwAfterSubscribeActionMigrationQueueKey,
      ...candidates.map((postId, index) => ({ member: postId, score: index })),
    );
  }
  await redis.hSet(nsfwAfterSubscribeActionMigrationStateKey, {
    version: nsfwAfterSubscribeActionMigrationVersion,
    status: candidates.length > 0 ? "pending" : "complete",
    ...Object.fromEntries(
      Object.keys(emptySummary()).map((field) => [field, "0"]),
    ),
  });
  console.info(
    `[nsfwAfterSubscribeActionMigration] initialized: candidates=${candidates.length} nsfw=${subreddit.nsfw === true}`,
  );
}

export async function processNsfwAfterSubscribeActionMigrationBatch(
  redis: RedisClient,
  subreddit: NsfwAfterSubscribeActionMigrationSubreddit,
  size = batchSize,
): Promise<NsfwAfterSubscribeActionMigrationSummary> {
  const summary = emptySummary();
  if (subreddit.nsfw !== true) return summary;
  const stateVersion = await redis.hGet(
    nsfwAfterSubscribeActionMigrationStateKey,
    "version",
  );
  if (stateVersion !== nsfwAfterSubscribeActionMigrationVersion) return summary;

  const pending = await redis.zRange(
    nsfwAfterSubscribeActionMigrationQueueKey,
    0,
    Math.max(0, Math.floor(size) - 1),
  );
  for (const { member: postId } of pending) {
    summary.scanned += 1;
    let lockKey: string | undefined;
    let lockToken: string | undefined;
    let removeFromQueue = false;
    try {
      if (!isLinkId(postId)) {
        await redis.hSet(nsfwAfterSubscribeActionMigrationTerminalKey, {
          [postId]: "invalid_post_id",
        });
        summary.terminal += 1;
        removeFromQueue = true;
        continue;
      }

      lockKey = `${nsfwAfterSubscribeActionMigrationLockKeyPrefix}:${postId}`;
      lockToken = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
      await redis.set(lockKey, lockToken, {
        nx: true,
        expiration: new Date(Date.now() + lockTtlMs),
      });
      if ((await redis.get(lockKey)) !== lockToken) {
        summary.raced += 1;
        continue;
      }

      const [rawFields, data] = await Promise.all([
        redis.hMGet(subscriberGoalsKey, getRawActionFields(postId)),
        getSubGoalData(redis, postId),
      ]);
      const actionType = rawFields[0]?.trim() ?? "";
      const preset = rawFields[4]?.trim() ?? "";
      const isDynamic =
        actionType === "top-post-day" ||
        actionType === "newest-post" ||
        preset === "top-post-day" ||
        preset === "newest-post";
      if (!isDynamic) {
        summary.preserved += 1;
        removeFromQueue = true;
        continue;
      }

      const latest = await redis.hMGet(
        subscriberGoalsKey,
        getRawActionFields(postId),
      );
      if (!latest.every((value, index) => value === rawFields[index])) {
        summary.raced += 1;
        continue;
      }
      await setAfterSubscribeActionForPost(
        redis,
        postId,
        createDefaultCreatePostAction({
          language: data.language,
          subredditName: subreddit.name,
        }),
        defaultAfterSubscribeColorTheme,
        "create-post",
      );
      summary.converted += 1;
      removeFromQueue = true;
    } catch (error) {
      summary.failed += 1;
      logDiagnostic(
        "error",
        "migration_record_failed",
        {
          workflow: "nsfw_after_subscribe_action_migration",
          phase: "record",
          postId,
        },
        error,
      );
    } finally {
      if (removeFromQueue) {
        await redis.zRem(nsfwAfterSubscribeActionMigrationQueueKey, [postId]);
      }
      if (lockKey && lockToken && (await redis.get(lockKey)) === lockToken) {
        await redis.del(lockKey);
      }
    }
  }

  const remaining = await redis.zRange(
    nsfwAfterSubscribeActionMigrationQueueKey,
    0,
    -1,
  );
  const previous = await redis.hGetAll(
    nsfwAfterSubscribeActionMigrationStateKey,
  );
  const total = (field: keyof NsfwAfterSubscribeActionMigrationSummary) =>
    ((parseInt(previous[field] ?? "0", 10) || 0) + summary[field]).toString();
  await redis.hSet(nsfwAfterSubscribeActionMigrationStateKey, {
    version: nsfwAfterSubscribeActionMigrationVersion,
    status: remaining.length === 0 ? "complete" : "running",
    ...Object.fromEntries(
      Object.keys(summary).map((field) => [
        field,
        total(field as keyof NsfwAfterSubscribeActionMigrationSummary),
      ]),
    ),
  });
  if (summary.scanned > 0) {
    console.info(
      `[nsfwAfterSubscribeActionMigration] batch: scanned=${summary.scanned} converted=${summary.converted} preserved=${summary.preserved} raced=${summary.raced} terminal=${summary.terminal} failed=${summary.failed} remaining=${remaining.length}`,
    );
  }
  return summary;
}
