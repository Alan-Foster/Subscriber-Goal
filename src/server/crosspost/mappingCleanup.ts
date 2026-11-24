import {
  crosspostListByTimeKey,
  crosspostListKey,
  crosspostMappingRetentionMs,
  updateCrosspostMappings,
} from "../data/crosspostMappings";
import { isLinkId, type RedisClient } from "../types";

const cleanupCursorKey = "crosspostMappingCleanupCursorV1";
const mappingScanSize = 25;
type Cursor = number | null;

export async function cleanupCrosspostMappings(
  redis: RedisClient,
  nowMs: number,
  startScan: boolean,
): Promise<void> {
  const saved = await redis.get(cleanupCursorKey);
  if (!saved && !startScan) return;

  await updateCrosspostMappings(redis, async () => {
    if ((await redis.get(cleanupCursorKey)) !== saved) return;
    const [hashCursor, indexCursor] = decodeCursors(saved);
    const [hash, index] = await Promise.all([
      scanMappings(redis, hashCursor, nowMs),
      scanIndex(redis, indexCursor, nowMs - crosspostMappingRetentionMs),
    ]);
    const remove = [...new Set([...hash.remove, ...index.remove])];
    const removing = new Set(remove);
    const add = hash.add.filter(({ member }) => !removing.has(member));

    return async (tx) => {
      if (remove.length > 0) {
        await tx.hDel(crosspostListKey, remove);
        await tx.zRem(crosspostListByTimeKey, remove);
      }
      if (add.length > 0) await tx.zAdd(crosspostListByTimeKey, ...add);
      if (hash.next === null && index.next === null) {
        await tx.del(cleanupCursorKey);
      } else {
        await tx.set(
          cleanupCursorKey,
          `${hash.next ?? "-"}:${index.next ?? "-"}`,
        );
      }
    };
  }, [cleanupCursorKey]);
}

function decodeCursors(value: string | undefined): [Cursor, Cursor] {
  if (!value || !/^(\d+|-):(\d+|-)$/.test(value)) return [0, 0];
  const [hash, index] = value.split(":");
  return [
    hash === "-" ? null : Number(hash),
    index === "-" ? null : Number(index),
  ];
}

async function scanMappings(redis: RedisClient, cursor: Cursor, nowMs: number) {
  if (cursor === null) return { next: null, remove: [], add: [] };
  const page = await redis.hScan(
    crosspostListKey,
    cursor,
    undefined,
    mappingScanSize,
  );
  const valid = page.fieldValues.filter(
    ({ field, value }) => isLinkId(field) && isLinkId(value),
  );
  const scores = await Promise.all(
    valid.map(({ field }) => redis.zScore(crosspostListByTimeKey, field)),
  );
  return {
    next: page.cursor || null,
    remove: page.fieldValues.flatMap(({ field, value }) =>
      isLinkId(field) && isLinkId(value) ? [] : [field],
    ),
    add: valid.flatMap(({ field }, i) =>
      scores[i] === undefined ? [{ member: field, score: nowMs }] : [],
    ),
  };
}

async function scanIndex(redis: RedisClient, cursor: Cursor, cutoffMs: number) {
  if (cursor === null) return { next: null, remove: [] };
  const page = await redis.zScan(
    crosspostListByTimeKey,
    cursor,
    undefined,
    mappingScanSize,
  );
  const members = page.members.map(({ member }) => member);
  const mapped =
    members.length === 0 ? [] : await redis.hMGet(crosspostListKey, members);
  return {
    next: page.cursor || null,
    remove: page.members.flatMap(({ member, score }, i) =>
      !mapped[i] || score < cutoffMs ? [member] : [],
    ),
  };
}
