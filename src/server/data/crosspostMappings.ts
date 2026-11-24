import { logDiagnostic } from "../../shared/diagnostics";
import type { RedisClient } from "../types";

export const crosspostListKey = "crosspostList";
export const crosspostListByTimeKey = "crosspostListByTime";
export const crosspostMappingRetentionMs = 30 * 24 * 60 * 60 * 1000;

type Transaction = Awaited<ReturnType<RedisClient["watch"]>>;
type WriteMappings = (tx: Transaction) => Promise<void>;

export async function updateCrosspostMappings(
  redis: RedisClient,
  prepare: () => WriteMappings | undefined | Promise<WriteMappings | undefined>,
  extraKeys: string[] = [],
): Promise<void> {
  const tx = await redis.watch(
    crosspostListKey,
    crosspostListByTimeKey,
    ...extraKeys,
  );
  let inMulti = false;
  let closed = false;
  try {
    const write = await prepare();
    if (!write) {
      await tx.unwatch();
      return;
    }
    await tx.multi();
    inMulti = true;
    await write(tx);
    const result = await tx.exec();
    closed = true;
    if (result.length === 0)
      throw new Error("Crosspost mapping transaction conflicted.");
  } catch (error) {
    if (!closed) {
      try {
        await (inMulti ? tx.discard() : tx.unwatch());
      } catch (cleanupError) {
        logDiagnostic(
          "warn",
          "crosspost_mapping_transaction_cleanup_failed",
          {
            workflow: "crosspost",
          },
          cleanupError,
        );
      }
    }
    throw error;
  }
}

export async function writeCrosspostMapping(
  tx: Transaction,
  sourcePostId: string,
  crosspostId: string,
  mappedAt: number,
): Promise<void> {
  await tx.hSet(crosspostListKey, { [sourcePostId]: crosspostId });
  await tx.zAdd(crosspostListByTimeKey, {
    member: sourcePostId,
    score: mappedAt,
  });
}

export async function storeCorrespondingPost(
  redis: RedisClient,
  postId: string,
  crosspostId: string,
): Promise<void> {
  const now = Date.now();
  await updateCrosspostMappings(
    redis,
    () => (tx) => writeCrosspostMapping(tx, postId, crosspostId, now),
  );
}

export async function removeCorrespondingPost(
  redis: RedisClient,
  postId: string,
): Promise<void> {
  await updateCrosspostMappings(redis, () => async (tx) => {
    await tx.hDel(crosspostListKey, [postId]);
    await tx.zRem(crosspostListByTimeKey, [postId]);
  });
}
