import type { LinkId, RedisClient } from "../types";
import {
  parsePostIdList,
  postRecentSubscriberOrderSuffix,
  postRecentSubscriberSuffix,
  recentSubscriberPostsByUsernameKey,
  stringifyPostIdList,
  subscriberGoalsKey,
} from "./subGoalData";
import {
  parseRecentSubscriberOrder,
  scrubRecentSubscriberOrder,
} from "./recentSubscriberOrder";
import { invalidateSubscriberTracking } from "./subscriberTracking";
import { subscriberTrackingGenerationKey } from "./subscriberTrackingKeys";

const pageSize = 50;
const maxPagesPerRequest = 16;
const sweepBudgetMs = 10_000;
const cursorLifetimeMs = 60 * 60 * 1000;

type Transaction = Awaited<ReturnType<RedisClient["watch"]>>;
type IndexRemovals = Map<string, Set<string>>;
type IndexUpdate = { username: string; kept: string[] };

const cursorKey = (generation: string) =>
  `subscriber_recent_order_erasure_cursor_v1:${generation}`;

export async function eraseSubscriberOrdersById(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  const generationKey = subscriberTrackingGenerationKey(userId);
  const current = await redis.get(generationKey);
  const saved = current ? await redis.get(cursorKey(current)) : undefined;
  const generation =
    current && saved
      ? current
      : await invalidateSubscriberTracking(redis, userId);
  const deadline = Date.now() + sweepBudgetMs;
  let cursor = saved ? Number(saved) : 0;
  for (
    let page = 0;
    page < maxPagesPerRequest && Date.now() < deadline;
    page += 1
  ) {
    cursor = await eraseOrderPage(redis, userId, generation, cursor);
    if (cursor === 0) return;
  }
  // The next submission resumes this generation. A partial sweep must not
  // produce a success toast or delete the user's lookup indexes.
  throw new Error("recent_subscriber_erasure_sweep_incomplete");
}

async function eraseOrderPage(
  redis: RedisClient,
  userId: string,
  generation: string,
  cursor: number,
): Promise<number> {
  const generationKey = subscriberTrackingGenerationKey(userId);
  const progressKey = cursorKey(generation);
  for (let retry = 0; retry < 3; retry += 1) {
    const tx = await redis.watch(
      subscriberGoalsKey,
      recentSubscriberPostsByUsernameKey,
      generationKey,
      progressKey,
    );
    let inMulti = false;
    try {
      const [current, progress] = await Promise.all([
        redis.get(generationKey),
        redis.get(progressKey),
      ]);
      if (current !== generation || Number(progress ?? 0) !== cursor) {
        throw new Error("recent_subscriber_erasure_sweep_superseded");
      }
      const page = await redis.hScan(
        subscriberGoalsKey,
        cursor,
        `*${postRecentSubscriberOrderSuffix}`,
        pageSize,
      );
      const { fields, removals } = await planOrderPage(
        redis,
        page.fieldValues,
        userId,
        generation,
      );
      const index = await readIndexUpdates(redis, removals);
      if (!page.cursor && !progress && Object.keys(fields).length === 0) {
        await tx.unwatch();
        return 0;
      }
      await tx.multi();
      inMulti = true;
      if (Object.keys(fields).length > 0)
        await tx.hSet(subscriberGoalsKey, fields);
      await writeIndexUpdates(tx, index);
      if (page.cursor) {
        await tx.set(progressKey, String(page.cursor), {
          expiration: new Date(Date.now() + cursorLifetimeMs),
        });
      } else if (progress) {
        await tx.del(progressKey);
      }
      if ((await tx.exec()).length > 0) return page.cursor;
    } catch (error) {
      await closeFailedTransaction(tx, inMulti);
      throw error;
    }
  }
  throw new Error("recent_subscriber_erasure_conflict");
}

async function planOrderPage(
  redis: RedisClient,
  rows: { field: string; value: string }[],
  userId: string,
  generation: string,
) {
  const fields: Record<string, string> = {};
  const removals: IndexRemovals = new Map();
  const matched = rows.flatMap(({ field, value }) => {
    if (!field.endsWith(postRecentSubscriberOrderSuffix)) return [];
    const order = parseRecentSubscriberOrder(value);
    if (order?.userId !== userId || order.erasureGeneration === generation)
      return [];
    const postId = field.slice(0, -postRecentSubscriberOrderSuffix.length);
    fields[field] = scrubRecentSubscriberOrder(order);
    return [postId];
  });
  if (matched.length === 0) return { fields, removals };
  const displays = matched.map((id) => `${id}${postRecentSubscriberSuffix}`);
  const names = await redis.hMGet(subscriberGoalsKey, displays);
  for (const [i, postId] of matched.entries()) {
    const username = names[i]?.trim().toLowerCase();
    if (username) {
      fields[`${postId}${postRecentSubscriberSuffix}`] = "";
      const posts = removals.get(username) ?? new Set<string>();
      posts.add(postId);
      removals.set(username, posts);
    }
  }
  return { fields, removals };
}

async function readIndexUpdates(
  redis: RedisClient,
  removals: IndexRemovals,
): Promise<IndexUpdate[]> {
  const usernames = [...removals.keys()];
  if (usernames.length === 0) return [];
  const stored = await redis.hMGet(
    recentSubscriberPostsByUsernameKey,
    usernames,
  );
  return usernames.map((username, index) => ({
    username,
    kept: parsePostIdList(stored[index] ?? undefined).filter(
      (postId) => !removals.get(username)?.has(postId),
    ),
  }));
}

async function writeIndexUpdates(tx: Transaction, updates: IndexUpdate[]) {
  const kept = Object.fromEntries(
    updates
      .filter(({ kept }) => kept.length > 0)
      .map(({ username, kept }) => [username, stringifyPostIdList(kept)]),
  );
  const empty = updates
    .filter(({ kept }) => kept.length === 0)
    .map(({ username }) => username);
  if (Object.keys(kept).length > 0)
    await tx.hSet(recentSubscriberPostsByUsernameKey, kept);
  if (empty.length > 0)
    await tx.hDel(recentSubscriberPostsByUsernameKey, empty);
}

async function closeFailedTransaction(tx: Transaction, inMulti: boolean) {
  try {
    await (inMulti ? tx.discard() : tx.unwatch());
  } catch {
    // diagnostic-allow-silent: preserve the original erasure or retirement error.
  }
}

export async function pruneRetiredRecentSubscriber(
  redis: RedisClient,
  postId: LinkId,
): Promise<void> {
  const field = `${postId}${postRecentSubscriberSuffix}`;
  const [initial] = await redis.hMGet(subscriberGoalsKey, [field]);
  if (!initial?.trim()) return;
  for (let retry = 0; retry < 3; retry += 1) {
    const tx = await redis.watch(
      subscriberGoalsKey,
      recentSubscriberPostsByUsernameKey,
    );
    let inMulti = false;
    try {
      const [current] = await redis.hMGet(subscriberGoalsKey, [field]);
      const username = current?.trim().toLowerCase();
      if (!username) {
        await tx.unwatch();
        return;
      }
      const index = await readIndexUpdates(
        redis,
        new Map([[username, new Set([postId])]]),
      );
      await tx.multi();
      inMulti = true;
      await writeIndexUpdates(tx, index);
      if ((await tx.exec()).length > 0) return;
    } catch (error) {
      await closeFailedTransaction(tx, inMulti);
      throw error;
    }
  }
  throw new Error("recent_subscriber_retirement_conflict");
}
