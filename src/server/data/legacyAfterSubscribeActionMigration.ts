import { createDefaultAfterSubscribeAction } from "../../shared/afterSubscribeAction";
import { logDiagnostic } from "../../shared/diagnostics";
import { subscriberGoalPostKind } from "../../shared/postKind";
import { getAfterSubscribePresetMessages } from "../../shared/subGoalPostI18n";
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

// Keep the prior migration keys intact. A separate v3 marker deliberately
// re-queues installations where the v2 migration has already completed.
export const legacyAfterSubscribeActionMigrationStateKey =
  "legacy_after_subscribe_action_migration_v3_state";
export const legacyAfterSubscribeActionMigrationQueueKey =
  "legacy_after_subscribe_action_migration_v3_queue";
export const legacyAfterSubscribeActionMigrationVersion =
  "legacy_after_subscribe_action_v3";
export const legacyAfterSubscribeActionMigrationLockKeyPrefix =
  "legacy_after_subscribe_action_migration_v3_lock";
export const legacyAfterSubscribeActionMigrationTerminalKey =
  "legacy_after_subscribe_action_migration_v3_terminal";

export type LegacyAfterSubscribeActionMigrationSubreddit = {
  name: string;
  type: unknown;
};

export type LegacyAfterSubscribeActionMigrationSummary = {
  scanned: number;
  convertedCanonicalCreatePostDefaults: number;
  convertedActionless: number;
  preservedExplicit: number;
  alreadyTopPostDefaults: number;
  ineligible: number;
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

const emptySummary = (): LegacyAfterSubscribeActionMigrationSummary => ({
  scanned: 0,
  convertedCanonicalCreatePostDefaults: 0,
  convertedActionless: 0,
  preservedExplicit: 0,
  alreadyTopPostDefaults: 0,
  ineligible: 0,
  raced: 0,
  terminal: 0,
  failed: 0,
});

export async function initializeLegacyAfterSubscribeActionMigration(
  redis: RedisClient,
  candidatePostIds: string[],
  subreddit: LegacyAfterSubscribeActionMigrationSubreddit,
): Promise<void> {
  const version = await redis.hGet(
    legacyAfterSubscribeActionMigrationStateKey,
    "version",
  );
  if (version === legacyAfterSubscribeActionMigrationVersion) {
    return;
  }

  if (candidatePostIds.length > 0) {
    await redis.zAdd(
      legacyAfterSubscribeActionMigrationQueueKey,
      ...candidatePostIds.map((postId, index) => ({
        member: postId,
        score: index,
      })),
    );
  }
  await redis.hSet(legacyAfterSubscribeActionMigrationStateKey, {
    version: legacyAfterSubscribeActionMigrationVersion,
    status: candidatePostIds.length > 0 ? "pending" : "complete",
    ...Object.fromEntries(
      Object.keys(emptySummary()).map((field) => [field, "0"]),
    ),
  });
  console.info(
    `[legacyAfterSubscribeActionMigration] initialized: version=${legacyAfterSubscribeActionMigrationVersion} candidates=${candidatePostIds.length} subredditType=${String(subreddit.type ?? "unknown")}`,
  );
}

export async function processLegacyAfterSubscribeActionMigrationBatch(
  redis: RedisClient,
  subreddit: LegacyAfterSubscribeActionMigrationSubreddit,
  size = batchSize,
): Promise<LegacyAfterSubscribeActionMigrationSummary> {
  const summary = emptySummary();
  const pending = await redis.zRange(
    legacyAfterSubscribeActionMigrationQueueKey,
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
        await redis.hSet(legacyAfterSubscribeActionMigrationTerminalKey, {
          [postId]: "invalid_post_id",
        });
        logDiagnostic("warn", "migration_record_terminal", {
          workflow: "legacy_after_subscribe_action_migration",
          phase: "record_validation",
          postId,
          category: "invalid_post_id",
        });
        summary.terminal += 1;
        removeFromQueue = true;
        continue;
      }

      lockKey = `${legacyAfterSubscribeActionMigrationLockKeyPrefix}:${postId}`;
      lockToken = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
      await redis.set(lockKey, lockToken, {
        nx: true,
        expiration: new Date(Date.now() + lockTtlMs),
      });
      if ((await redis.get(lockKey)) !== lockToken) {
        summary.raced += 1;
        continue;
      }

      // Reload every field used for eligibility only after holding the lock.
      const [rawFields, data] = await Promise.all([
        redis.hMGet(subscriberGoalsKey, getRawActionFields(postId)),
        getSubGoalData(redis, postId),
      ]);
      const [rawActionType, rawButtonText, rawUrl, rawColorTheme, rawPreset] =
        rawFields;
      const actionType = rawActionType?.trim() ?? "";
      const preset = rawPreset?.trim() ?? "";
      const hasAnyActionMetadata = rawFields.some(
        (value) => (value?.trim() ?? "").length > 0,
      );

      if (data.postKind !== subscriberGoalPostKind || data.goal <= 0) {
        summary.ineligible += 1;
        removeFromQueue = true;
        continue;
      }

      const presetMessages = getAfterSubscribePresetMessages(data.language);
      const isCanonicalTopPostDefault =
        actionType === "top-post-day" &&
        (preset.length === 0 || preset === "top-post-day") &&
        (rawButtonText ?? "") === presetMessages.viewTopPostToday &&
        (rawUrl?.trim() ?? "").length === 0;
      const isCanonicalCreatePostDefault =
        actionType === "link" &&
        preset === "create-post" &&
        (rawButtonText ?? "") === presetMessages.createNewPost &&
        (rawUrl?.trim() ?? "") ===
          `https://www.reddit.com/r/${subreddit.name}/submit/` &&
        rawColorTheme?.trim() === "blue";

      const stillEligible = async (): Promise<boolean> => {
        const latest = await redis.hMGet(
          subscriberGoalsKey,
          getRawActionFields(postId),
        );
        return latest.every((value, index) => value === rawFields[index]);
      };

      if (!hasAnyActionMetadata) {
        if (!(await stillEligible())) {
          summary.raced += 1;
          continue;
        }
        const action = createDefaultAfterSubscribeAction({
          language: data.language,
          subredditName: subreddit.name,
          subredditType: subreddit.type,
        });
        await setAfterSubscribeActionForPost(
          redis,
          postId,
          action,
          data.colorTheme,
          "top-post-day",
        );
        summary.convertedActionless += 1;
      } else if (isCanonicalCreatePostDefault) {
        if (!(await stillEligible())) {
          summary.raced += 1;
          continue;
        }
        const action = createDefaultAfterSubscribeAction({
          language: data.language,
          subredditName: subreddit.name,
          subredditType: subreddit.type,
        });
        await setAfterSubscribeActionForPost(
          redis,
          postId,
          action,
          data.colorTheme,
          "top-post-day",
        );
        summary.convertedCanonicalCreatePostDefaults += 1;
      } else if (isCanonicalTopPostDefault) {
        summary.alreadyTopPostDefaults += 1;
      } else {
        summary.preservedExplicit += 1;
      }
      removeFromQueue = true;
    } catch (error) {
      summary.failed += 1;
      logDiagnostic(
        "error",
        "migration_record_failed",
        {
          workflow: "legacy_after_subscribe_action_migration",
          phase: "record",
          postId,
        },
        error,
      );
    } finally {
      if (removeFromQueue) {
        await redis.zRem(legacyAfterSubscribeActionMigrationQueueKey, [postId]);
      }
      if (lockKey && lockToken && (await redis.get(lockKey)) === lockToken) {
        await redis.del(lockKey);
      }
    }
  }

  const remainingEntries = await redis.zRange(
    legacyAfterSubscribeActionMigrationQueueKey,
    0,
    -1,
  );
  const previous = await redis.hGetAll(
    legacyAfterSubscribeActionMigrationStateKey,
  );
  const total = (field: keyof LegacyAfterSubscribeActionMigrationSummary) =>
    ((parseInt(previous[field] ?? "0", 10) || 0) + summary[field]).toString();
  await redis.hSet(legacyAfterSubscribeActionMigrationStateKey, {
    version: legacyAfterSubscribeActionMigrationVersion,
    status: remainingEntries.length === 0 ? "complete" : "running",
    ...Object.fromEntries(
      Object.keys(summary).map((field) => [
        field,
        total(field as keyof LegacyAfterSubscribeActionMigrationSummary),
      ]),
    ),
  });
  if (summary.scanned > 0) {
    console.info(
      `[legacyAfterSubscribeActionMigration] batch: scanned=${summary.scanned} convertedCanonicalCreatePostDefaults=${summary.convertedCanonicalCreatePostDefaults} convertedActionless=${summary.convertedActionless} preservedExplicit=${summary.preservedExplicit} alreadyTopPostDefaults=${summary.alreadyTopPostDefaults} ineligible=${summary.ineligible} raced=${summary.raced} terminal=${summary.terminal} failed=${summary.failed} remaining=${remainingEntries.length}`,
    );
  }
  return summary;
}
