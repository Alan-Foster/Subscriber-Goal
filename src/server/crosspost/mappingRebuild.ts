import {
  getCrosspostPendingByRevisionKey,
  parsePendingCrosspost,
} from "../data/crosspostData";
import {
  crosspostListByTimeKey,
  crosspostListKey,
  crosspostMappingRetentionMs,
  updateCrosspostMappings,
} from "../data/crosspostMappings";
import { isLinkId, type RedditClient, type RedisClient } from "../types";

// Keep the done marker for this migration until the rebuild is retired.
const rebuildKey = "crosspostMappingRebuildV1";
const rebuildBatchSize = 25;

type Entry = { source: string; mirror: string; score: number };
type Page = { entries: Entry[]; next: string };

export async function rebuildCrosspostMappings(
  reddit: RedditClient,
  redis: RedisClient,
  targetSubreddit: string,
  nowMs = Date.now(),
): Promise<void> {
  const state = await redis.get(rebuildKey);
  if (state === "done") return;
  const cutoff = nowMs - crosspostMappingRetentionMs;
  const page = state?.startsWith("pending:")
    ? await readPendingPage(
        redis,
        targetSubreddit,
        Number(state.slice(8)),
        cutoff,
      )
    : await readListingPage(reddit, targetSubreddit, state?.slice(8), cutoff);

  await updateCrosspostMappings(redis, async () => {
    if ((await redis.get(rebuildKey)) !== state) return;
    const missing = await getMissingMappings(redis, page.entries);
    return async (tx) => {
      if (missing.length > 0) {
        // WATCH + hMGet lets us insert only missing fields in a single hSet.
        await tx.hSet(
          crosspostListKey,
          Object.fromEntries(
            missing.map(({ source, mirror }) => [source, mirror]),
          ),
        );
        await tx.zAdd(
          crosspostListByTimeKey,
          ...missing.map(({ source, score }) => ({ member: source, score })),
        );
      }
      await tx.set(rebuildKey, page.next);
    };
  }, [rebuildKey]);
}

async function getMissingMappings(redis: RedisClient, entries: Entry[]) {
  const bySource = new Map<string, Entry>();
  for (const entry of entries) {
    if (!bySource.has(entry.source)) bySource.set(entry.source, entry);
  }
  const unique = [...bySource.values()];
  if (unique.length === 0) return [];
  const mapped = await redis.hMGet(crosspostListKey, [...bySource.keys()]);
  return unique.filter((_, i) => mapped[i] == null);
}

async function readListingPage(
  reddit: RedditClient,
  subredditName: string,
  after: string | undefined,
  cutoff: number,
): Promise<Page> {
  const appUser = await reddit.getAppUser();
  if (!appUser)
    throw new Error(
      "Could not identify the app account for the crosspost rebuild.",
    );
  const listing = reddit.getNewPosts({
    subredditName,
    limit: rebuildBatchSize,
    pageSize: rebuildBatchSize,
    ...(after ? { after } : {}),
  });
  const entries: Entry[] = [];
  let lastId: string | undefined;
  for await (const post of listing) {
    const score = post.createdAt.getTime();
    if (score < cutoff) return { entries, next: "pending:0" };
    lastId = post.id;
    if (
      post.authorId === appUser.id &&
      post.crosspostParentId &&
      isLinkId(post.crosspostParentId) &&
      isLinkId(post.id) &&
      Number.isFinite(score)
    ) {
      entries.push({ source: post.crosspostParentId, mirror: post.id, score });
    }
  }
  const next =
    listing.hasMore && lastId && lastId !== after
      ? `listing:${lastId}`
      : "pending:0";
  return { entries, next };
}

async function readPendingPage(
  redis: RedisClient,
  targetSubreddit: string,
  cursor: number,
  cutoff: number,
): Promise<Page> {
  const page = await redis.hScan(
    getCrosspostPendingByRevisionKey(targetSubreddit),
    cursor,
    undefined,
    rebuildBatchSize,
  );
  const pending = page.fieldValues.map(({ field, value }) =>
    parsePendingCrosspost(value, field),
  );
  const entries = pending.flatMap((item) =>
    item?.createdCrosspostId && item.firstSeenMs >= cutoff
      ? [
          {
            source: item.postId,
            mirror: item.createdCrosspostId,
            score: item.firstSeenMs,
          },
        ]
      : [],
  );
  return { entries, next: page.cursor ? `pending:${page.cursor}` : "done" };
}
