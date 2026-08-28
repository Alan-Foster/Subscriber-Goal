import { EntrypointHeight } from "@devvit/web/server";
import {
  subscriberGoalPostKind,
  subscribeOnlyPostKind,
} from "../../shared/postKind";
import { shortSubGoalPostHeightPixels } from "../../shared/subGoalPostHeight";
import type { RedditClient, RedisClient } from "../types";
import { isLinkId } from "../types";
import {
  getSubGoalData,
  postHeightSuffix,
  postKindSuffix,
  subscriberGoalsKey,
} from "./subGoalData";

export const postKindMigrationStateKey = "post_kind_migration_v1_state";
export const postKindMigrationQueueKey = "post_kind_migration_v1_queue";
export const postKindMigrationVersion = "post_kind_v1";

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
  const summary = emptySummary();
  const pending = await redis.zRange(
    postKindMigrationQueueKey,
    0,
    Math.max(0, Math.floor(batchSize) - 1),
  );

  for (const { member: postId } of pending) {
    summary.scanned += 1;
    try {
      if (!isLinkId(postId)) {
        throw new Error("invalid post id");
      }
      const rawHeight = await redis.hGet(
        subscriberGoalsKey,
        `${postId}${postHeightSuffix}`,
      );
      const data = await getSubGoalData(redis, postId);
      const post = await reddit.getPostById(postId);

      if (data.postKind === subscribeOnlyPostKind) {
        await post.mergePostData({ postKind: subscribeOnlyPostKind });
        await redis.hSet(subscriberGoalsKey, {
          [`${postId}${postKindSuffix}`]: subscribeOnlyPostKind,
        });
        summary.recognizedTiny += 1;
      } else {
        await post.mergePostData({ postKind: subscriberGoalPostKind });
        const normalizedHeight =
          data.postHeight === "short" ? "short" : "regular";
        if (rawHeight === "tiny") {
          summary.conflicting += 1;
          await post.setCustomPostStyles(undefined);
          await post.setCustomPostStyles({ height: EntrypointHeight.REGULAR });
          summary.repaired += 1;
        } else if (normalizedHeight === "short") {
          await post.setCustomPostStyles({
            height: EntrypointHeight.HEIGHT_UNSPECIFIED,
            heightPixels: shortSubGoalPostHeightPixels,
          });
          summary.preservedShort += 1;
        }
        await redis.hSet(subscriberGoalsKey, {
          [`${postId}${postKindSuffix}`]: subscriberGoalPostKind,
          [`${postId}${postHeightSuffix}`]: normalizedHeight,
        });
      }
      await redis.zRem(postKindMigrationQueueKey, [postId]);
    } catch (error) {
      summary.failed += 1;
      console.error(
        `[postKindMigration] failed: postId=${postId} error=${String(error)}`,
      );
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
