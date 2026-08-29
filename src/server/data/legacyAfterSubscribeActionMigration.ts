import { createTopPostFallbackAction } from "../../shared/afterSubscribeAction";
import { subscriberGoalPostKind } from "../../shared/postKind";
import { isLinkId, type RedisClient } from "../types";
import {
  getSubGoalData,
  postAfterSubscribeActionSuffix,
  setAfterSubscribeActionForPostIfMissing,
  subscriberGoalsKey,
} from "./subGoalData";

export const legacyAfterSubscribeActionMigrationStateKey =
  "legacy_after_subscribe_action_migration_v1_state";
export const legacyAfterSubscribeActionMigrationQueueKey =
  "legacy_after_subscribe_action_migration_v1_queue";
export const legacyAfterSubscribeActionMigrationVersion =
  "legacy_after_subscribe_action_v1";

export type LegacyAfterSubscribeActionMigrationSummary = {
  scanned: number;
  upgraded: number;
  alreadyConfigured: number;
  ineligible: number;
  failed: number;
};

const batchSize = 25;

const emptySummary = (): LegacyAfterSubscribeActionMigrationSummary => ({
  scanned: 0,
  upgraded: 0,
  alreadyConfigured: 0,
  ineligible: 0,
  failed: 0,
});

export async function initializeLegacyAfterSubscribeActionMigration(
  redis: RedisClient,
  trackedPostIds: string[],
): Promise<void> {
  const version = await redis.hGet(
    legacyAfterSubscribeActionMigrationStateKey,
    "version",
  );
  if (version === legacyAfterSubscribeActionMigrationVersion) {
    return;
  }

  if (trackedPostIds.length > 0) {
    await redis.zAdd(
      legacyAfterSubscribeActionMigrationQueueKey,
      ...trackedPostIds.map((postId, index) => ({
        member: postId,
        score: index,
      })),
    );
  }
  await redis.hSet(legacyAfterSubscribeActionMigrationStateKey, {
    version: legacyAfterSubscribeActionMigrationVersion,
    status: trackedPostIds.length > 0 ? "pending" : "complete",
    scanned: "0",
    upgraded: "0",
    alreadyConfigured: "0",
    ineligible: "0",
    failed: "0",
  });
}

export async function processLegacyAfterSubscribeActionMigrationBatch(
  redis: RedisClient,
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
    try {
      if (!isLinkId(postId)) {
        throw new Error("invalid post id");
      }
      const [rawActionType, data] = await Promise.all([
        redis.hGet(
          subscriberGoalsKey,
          `${postId}${postAfterSubscribeActionSuffix}`,
        ),
        getSubGoalData(redis, postId),
      ]);
      const hasActionMetadata =
        typeof rawActionType === "string" && rawActionType.trim().length > 0;

      if (data.postKind !== subscriberGoalPostKind || data.goal <= 0) {
        summary.ineligible += 1;
      } else if (hasActionMetadata) {
        summary.alreadyConfigured += 1;
      } else {
        const upgraded = await setAfterSubscribeActionForPostIfMissing(
          redis,
          postId,
          createTopPostFallbackAction({
            language: data.language,
            colorTheme: data.colorTheme,
          }),
          data.colorTheme,
        );
        if (upgraded) {
          summary.upgraded += 1;
        } else {
          summary.alreadyConfigured += 1;
        }
      }
      await redis.zRem(legacyAfterSubscribeActionMigrationQueueKey, [postId]);
    } catch (error) {
      summary.failed += 1;
      console.error(
        `[legacyAfterSubscribeActionMigration] failed: postId=${postId} error=${String(error)}`,
      );
    }
  }

  const remaining = await redis.zRange(
    legacyAfterSubscribeActionMigrationQueueKey,
    0,
    0,
  );
  const previous = await redis.hGetAll(
    legacyAfterSubscribeActionMigrationStateKey,
  );
  const total = (field: keyof LegacyAfterSubscribeActionMigrationSummary) =>
    ((parseInt(previous[field] ?? "0", 10) || 0) + summary[field]).toString();
  await redis.hSet(legacyAfterSubscribeActionMigrationStateKey, {
    version: legacyAfterSubscribeActionMigrationVersion,
    status: remaining.length === 0 ? "complete" : "running",
    scanned: total("scanned"),
    upgraded: total("upgraded"),
    alreadyConfigured: total("alreadyConfigured"),
    ineligible: total("ineligible"),
    failed: total("failed"),
  });
  if (summary.scanned > 0) {
    console.info(
      `[legacyAfterSubscribeActionMigration] batch: scanned=${summary.scanned} upgraded=${summary.upgraded} alreadyConfigured=${summary.alreadyConfigured} ineligible=${summary.ineligible} failed=${summary.failed} remaining=${remaining.length > 0}`,
    );
  }
  return summary;
}
