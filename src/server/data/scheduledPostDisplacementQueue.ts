import { isLinkId, type LinkId, type RedisClient } from "../types";

export const scheduledPostDisplacementKey = "scheduled_post_displacement_v1";
export const displacementPendingKey = "scheduled_post_displacement_pending_v1";
export const displacementWaitMs = 15 * 60_000;
export const displacementBatchSize = 25;

type Transaction = Awaited<ReturnType<RedisClient["watch"]>>;
type Update<Result> = {
  result: Result;
  write?: (tx: Transaction) => Promise<void>;
};

async function updateChecks<Result>(
  redis: RedisClient,
  prepare: () => Promise<Update<Result>>,
): Promise<Result> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tx = await redis.watch(scheduledPostDisplacementKey);
    let inMulti = false;
    try {
      const { result, write } = await prepare();
      if (!write) {
        await tx.unwatch();
        return result;
      }
      await tx.multi();
      inMulti = true;
      await write(tx);
      if ((await tx.exec()).length > 0) return result;
    } catch (error) {
      try {
        await (inMulti ? tx.discard() : tx.unwatch());
      } catch {
        // diagnostic-allow-silent: retain the original transaction error.
      }
      throw error;
    }
  }
  throw new Error(
    "Scheduled displacement checks changed during every update attempt.",
  );
}

export async function enqueueDisplacementCheck(
  redis: RedisClient,
  postId: LinkId,
  unpinnedAt: number,
): Promise<void> {
  await updateChecks(redis, async () => ({
    result: undefined,
    write: async (tx) => {
      await tx.hSet(scheduledPostDisplacementKey, {
        [postId]: String(unpinnedAt),
      });
      await tx.zAdd(displacementPendingKey, {
        member: postId,
        score: unpinnedAt + displacementWaitMs,
      });
    },
  }));
}

// Compare the original value while watching the hash. A fresh unpin can land
// during a moderation-log read and must retain its own timestamp and index row.
export async function updateDisplacementCheck(
  redis: RedisClient,
  postId: string,
  expected: string | undefined,
  nextRunAt?: number,
): Promise<boolean> {
  return updateChecks(redis, async () => {
    if ((await redis.hGet(scheduledPostDisplacementKey, postId)) !== expected)
      return { result: false };
    return {
      result: true,
      write: async (tx) => {
        if (nextRunAt === undefined) {
          if (expected !== undefined)
            await tx.hDel(scheduledPostDisplacementKey, [postId]);
          await tx.zRem(displacementPendingKey, [postId]);
        } else {
          await tx.zAdd(displacementPendingKey, {
            member: postId,
            score: nextRunAt,
          });
        }
      },
    };
  });
}

export async function indexLegacyDisplacementPage(
  redis: RedisClient,
  cursor: number,
): Promise<number | null> {
  return updateChecks(redis, async () => {
    const page = await redis.hScan(
      scheduledPostDisplacementKey,
      cursor,
      undefined,
      displacementBatchSize,
    );
    const result = page.cursor || null;
    if (page.fieldValues.length === 0) return { result };
    const entries: { member: string; score: number }[] = [];
    const invalid: string[] = [];
    for (const { field, value } of page.fieldValues) {
      const unpinnedAt = Number(value);
      if (isLinkId(field) && Number.isFinite(unpinnedAt)) {
        entries.push({ member: field, score: unpinnedAt + displacementWaitMs });
      } else {
        invalid.push(field);
      }
    }
    return {
      result,
      write: async (tx) => {
        if (entries.length > 0)
          await tx.zAdd(displacementPendingKey, ...entries);
        if (invalid.length > 0) {
          await tx.hDel(scheduledPostDisplacementKey, invalid);
          await tx.zRem(displacementPendingKey, invalid);
        }
      },
    };
  });
}
