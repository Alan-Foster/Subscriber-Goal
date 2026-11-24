import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@devvit/web/server", () => ({
  reddit: {},
  redis: {},
  context: {},
}));

import {
  cleanupCrosspostBookkeeping,
  crosspostBookkeepingCleanupLastRunKey,
  finalizeCrosspostPersistenceAtomic,
} from "./bookkeeping";
import {
  crosspostListKey,
  processedRevisionsByTimeKey,
  processedRevisionsKey,
  removeCorrespondingPost,
  storeCorrespondingPost,
  upsertPendingCrosspost,
} from "../data/crosspostData";
import {
  crosspostListByTimeKey,
  crosspostMappingRetentionMs,
} from "../data/crosspostMappings";
import { FakeRedisImpl } from "../testing/faultHarness";
import type { RedisClient, RedditClient } from "../types";
import { rebuildCrosspostMappings } from "./mappingRebuild";

class InMemoryRedis extends FakeRedisImpl {
  async zScan(key: string) {
    return { cursor: 0, members: await this.zRange(key, 0, -1) };
  }
}

describe("cleanupCrosspostBookkeeping", () => {
  let redis: InMemoryRedis;

  beforeEach(() => {
    redis = new InMemoryRedis();
  });

  it("removes old processed revisions by age threshold", async () => {
    await redis.hSet(processedRevisionsKey, {
      rev_old: "t3_a",
      rev_new: "t3_b",
    });
    await redis.zAdd(
      processedRevisionsByTimeKey,
      { member: "rev_old", score: 100 },
      { member: "rev_new", score: 1900 },
    );

    await cleanupCrosspostBookkeeping(
      redis as unknown as Parameters<typeof cleanupCrosspostBookkeeping>[0],
      {
        nowMs: 2000,
        retentionMs: 500,
        maxEntries: 100,
        minIntervalMs: 0,
      },
    );

    const remaining = await redis.hGetAll(processedRevisionsKey);
    expect(remaining).toEqual({ rev_new: "t3_b" });
  });

  it("removes oldest excess processed revisions by max-count threshold", async () => {
    await redis.hSet(processedRevisionsKey, {
      rev_1: "t3_a",
      rev_2: "t3_b",
      rev_3: "t3_c",
    });
    await redis.zAdd(
      processedRevisionsByTimeKey,
      { member: "rev_1", score: 1000 },
      { member: "rev_2", score: 1001 },
      { member: "rev_3", score: 1002 },
    );

    await cleanupCrosspostBookkeeping(
      redis as unknown as Parameters<typeof cleanupCrosspostBookkeeping>[0],
      {
        nowMs: 2000,
        retentionMs: 100000,
        maxEntries: 2,
        minIntervalMs: 0,
      },
    );

    const remaining = await redis.hGetAll(processedRevisionsKey);
    expect(remaining).toEqual({ rev_2: "t3_b", rev_3: "t3_c" });
  });

  it("respects interval gate and skips cleanup when called too soon", async () => {
    await redis.set(crosspostBookkeepingCleanupLastRunKey, "1900");
    await redis.hSet(processedRevisionsKey, { rev_old: "t3_a" });
    await redis.zAdd(processedRevisionsByTimeKey, {
      member: "rev_old",
      score: 100,
    });

    await cleanupCrosspostBookkeeping(
      redis as unknown as Parameters<typeof cleanupCrosspostBookkeeping>[0],
      {
        nowMs: 2000,
        retentionMs: 100,
        maxEntries: 1,
        minIntervalMs: 500,
      },
    );

    expect(await redis.hGetAll(processedRevisionsKey)).toEqual({
      rev_old: "t3_a",
    });
  });

  it("keeps valid mappings without requiring a tracked source on the hub", async () => {
    await redis.hSet(crosspostListKey, {
      bad_source: "t3_crosspost1",
      t3_untracked: "t3_crosspost2",
      t3_tracked: "not_a_thing_id",
      t3_comment_mapped: "t1_comment",
      t3_kept: "t3_crosspost3",
    });

    await cleanupCrosspostBookkeeping(
      redis as unknown as Parameters<typeof cleanupCrosspostBookkeeping>[0],
      {
        nowMs: 2000,
        retentionMs: 100000,
        maxEntries: 100,
        minIntervalMs: 0,
      },
    );

    expect(await redis.hGetAll(crosspostListKey)).toEqual({
      t3_untracked: "t3_crosspost2",
      t3_kept: "t3_crosspost3",
    });
    expect(await redis.zScore(crosspostListByTimeKey, "t3_untracked")).toBe(
      2000,
    );
    expect(
      await redis.zScore(crosspostListByTimeKey, "bad_source"),
    ).toBeUndefined();
  });

  it("expires old mappings and removes orphans while keeping the cutoff boundary", async () => {
    const nowMs = crosspostMappingRetentionMs + 1000;
    await redis.hSet(crosspostListKey, {
      t3_old: "t3_mirrorold",
      t3_boundary: "t3_mirrornew",
    });
    await redis.zAdd(
      crosspostListByTimeKey,
      { member: "t3_old", score: 999 },
      { member: "t3_boundary", score: 1000 },
      { member: "t3_orphan", score: nowMs },
    );
    await cleanupCrosspostBookkeeping(redis as unknown as RedisClient, {
      nowMs,
    });
    expect(await redis.hGetAll(crosspostListKey)).toEqual({
      t3_boundary: "t3_mirrornew",
    });
    expect(await redis.zRange(crosspostListByTimeKey, 0, -1)).toEqual([
      { member: "t3_boundary", score: 1000 },
    ]);
  });

  it("resumes a mapping scan before the next six-hour cleanup", async () => {
    await redis.hSet(crosspostListKey, { t3_first: "t3_a", t3_second: "t3_b" });
    const scan = vi
      .spyOn(redis, "hScan")
      .mockResolvedValueOnce({
        cursor: 42,
        fieldValues: [{ field: "t3_first", value: "t3_a" }],
      })
      .mockResolvedValueOnce({
        cursor: 0,
        fieldValues: [{ field: "t3_second", value: "t3_b" }],
      });
    const client = redis as unknown as RedisClient;
    await cleanupCrosspostBookkeeping(client, { nowMs: 1000 });
    await cleanupCrosspostBookkeeping(client, { nowMs: 2000 });
    await cleanupCrosspostBookkeeping(client, { nowMs: 3000 });
    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan).toHaveBeenLastCalledWith(crosspostListKey, 42, undefined, 25);
    expect(await redis.zScore(crosspostListByTimeKey, "t3_second")).toBe(2000);
    expect(await redis.get(crosspostBookkeepingCleanupLastRunKey)).toBe("1000");
  });

  it("backfills hash-only processed revisions into the time index", async () => {
    await redis.hSet(processedRevisionsKey, {
      rev_hash_only: "t3_source",
    });

    await cleanupCrosspostBookkeeping(
      redis as unknown as Parameters<typeof cleanupCrosspostBookkeeping>[0],
      {
        nowMs: 5000,
        retentionMs: 100000,
        maxEntries: 100,
        minIntervalMs: 0,
      },
    );

    expect(await redis.hGetAll(processedRevisionsKey)).toEqual({
      rev_hash_only: "t3_source",
    });
    expect(await redis.zRange(processedRevisionsByTimeKey, 0, -1)).toEqual([
      { member: "rev_hash_only", score: 5000 },
    ]);
  });

  it("removes time-index orphans that are missing from the hash", async () => {
    await redis.zAdd(processedRevisionsByTimeKey, {
      member: "rev_orphan",
      score: 100,
    });

    await cleanupCrosspostBookkeeping(
      redis as unknown as Parameters<typeof cleanupCrosspostBookkeeping>[0],
      {
        nowMs: 2000,
        retentionMs: 100000,
        maxEntries: 100,
        minIntervalMs: 0,
      },
    );

    expect(await redis.zRange(processedRevisionsByTimeKey, 0, -1)).toEqual([]);
  });

  it("does not advance cleanup last-run marker when cleanup fails", async () => {
    class ThrowingRedis extends InMemoryRedis {
      override async hScan(key: string) {
        if (key === crosspostListKey) {
          throw new Error("forced cleanup failure");
        }
        return await super.hScan(key, 0);
      }
    }
    const throwingRedis = new ThrowingRedis();
    await throwingRedis.hSet(processedRevisionsKey, { rev_1: "t3_source" });
    await throwingRedis.zAdd(processedRevisionsByTimeKey, {
      member: "rev_1",
      score: 100,
    });

    await expect(
      cleanupCrosspostBookkeeping(
        throwingRedis as unknown as Parameters<
          typeof cleanupCrosspostBookkeeping
        >[0],
        {
          nowMs: 2000,
          retentionMs: 100000,
          maxEntries: 100,
          minIntervalMs: 0,
        },
      ),
    ).rejects.toThrow("forced cleanup failure");

    expect(
      await throwingRedis.get(crosspostBookkeepingCleanupLastRunKey),
    ).toBeUndefined();
  });
});

it("indexes both mapping writes and clears the hash and index on removal", async () => {
  const redis = new InMemoryRedis();
  const client = redis as unknown as RedisClient;
  await storeCorrespondingPost(client, "t3_source", "t3_first");
  expect(await redis.zScore(crosspostListByTimeKey, "t3_source")).toBeDefined();
  const clock = vi.spyOn(Date, "now").mockReturnValue(123_456);
  try {
    await finalizeCrosspostPersistenceAtomic({
      redisClient: client,
      targetSubreddit: "SubGoal",
      sourcePostId: "t3_source",
      crosspostId: "t3_second",
      revisionId: "revision",
    });
    expect(await redis.hGet(crosspostListKey, "t3_source")).toBe("t3_second");
    expect(await redis.zScore(crosspostListByTimeKey, "t3_source")).toBe(
      123_456,
    );
    await removeCorrespondingPost(client, "t3_source");
    expect(await redis.hGet(crosspostListKey, "t3_source")).toBeUndefined();
    expect(
      await redis.zScore(crosspostListByTimeKey, "t3_source"),
    ).toBeUndefined();
  } finally {
    clock.mockRestore();
  }
});

function listing<T>(posts: T[], hasMore = false) {
  return {
    hasMore,
    async *[Symbol.asyncIterator]() {
      yield* posts;
    },
  };
}

it("rebuilds each page once, preserves a newer mapping, and folds in pending mirrors", async () => {
  const redis = new InMemoryRedis();
  const client = redis as unknown as RedisClient;
  const nowMs = Date.now();
  const mirror = { authorId: "t2_app", createdAt: new Date(nowMs - 1000) };
  const getNewPosts = vi
    .fn()
    .mockReturnValueOnce(
      listing(
        [
          { ...mirror, id: "t3_mirrora", crosspostParentId: "t3_sourcea" },
          {
            ...mirror,
            id: "t3_foreign",
            authorId: "t2_other",
            crosspostParentId: "t3_sourceskip",
          },
          { ...mirror, id: "t3_ordinary" },
        ],
        true,
      ),
    )
    .mockReturnValueOnce(
      listing([
        { ...mirror, id: "t3_mirrorb", crosspostParentId: "t3_sourceb" },
        {
          ...mirror,
          id: "t3_old",
          crosspostParentId: "t3_sourceold",
          createdAt: new Date(nowMs - crosspostMappingRetentionMs - 1),
        },
      ]),
    );
  const reddit = {
    getAppUser: vi.fn().mockResolvedValue({ id: "t2_app" }),
    getNewPosts,
  } as unknown as RedditClient;
  await storeCorrespondingPost(client, "t3_sourceb", "t3_newer");
  await upsertPendingCrosspost(client, "SubGoal", {
    revisionId: "rev_pending",
    postId: "t3_pending",
    createdCrosspostId: "t3_mirrorpending",
    goal: 100,
    firstSeenMs: nowMs - 20,
    nextAttemptMs: nowMs,
    attemptCount: 0,
    lastError: null,
    status: "crosspost_reconciliation_pending",
  });
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    for (let run = 0; run < 4; run += 1) {
      await rebuildCrosspostMappings(reddit, client, "SubGoal", nowMs);
    }
    const logs = info.mock.calls.map(([line]) => line);
    expect(
      logs.filter((line) =>
        String(line).includes('"event":"crosspost_mapping_rebuild_page"'),
      ),
    ).toHaveLength(3);
    expect(
      logs.filter((line) =>
        String(line).includes('"event":"crosspost_mapping_rebuild_completed"'),
      ),
    ).toEqual([
      expect.stringContaining(
        '"pagesRead":3,"listingPagesRead":2,"mappingsRestored":2',
      ),
    ]);
    expect(logs.at(-1)).toContain(
      `"oldestCrosspostDate":"${new Date(nowMs - crosspostMappingRetentionMs - 1).toISOString()}"`,
    );
    expect(logs.at(-1)).toContain('"listingStopReason":"cutoff"');
  } finally {
    info.mockRestore();
  }
  expect(getNewPosts).toHaveBeenCalledTimes(2);
  expect(getNewPosts).toHaveBeenLastCalledWith(
    expect.objectContaining({ after: "t3_ordinary" }),
  );
  expect(await redis.hGetAll(crosspostListKey)).toEqual({
    t3_sourcea: "t3_mirrora",
    t3_sourceb: "t3_newer",
    t3_pending: "t3_mirrorpending",
  });
  expect(await redis.zScore(crosspostListByTimeKey, "t3_sourcea")).toBe(
    nowMs - 1000,
  );
  expect(await redis.zScore(crosspostListByTimeKey, "t3_pending")).toBe(
    nowMs - 20,
  );
});

it("logs listing exhaustion when the cutoff was not reached", async () => {
  const redis = new InMemoryRedis() as unknown as RedisClient;
  const reddit = {
    getAppUser: vi.fn().mockResolvedValue({ id: "t2_app" }),
    getNewPosts: vi.fn().mockReturnValue(listing([])),
  } as unknown as RedditClient;
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await rebuildCrosspostMappings(reddit, redis, "SubGoal");
    await rebuildCrosspostMappings(reddit, redis, "SubGoal");
    expect(info).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenLastCalledWith(
      expect.stringContaining(
        '"pagesRead":2,"listingPagesRead":1,"mappingsRestored":0,"oldestCrosspostDate":"none","listingStopReason":"listing_exhausted"',
      ),
    );
  } finally {
    info.mockRestore();
  }
});

it("retries blind mapping writes once on a transaction conflict", async () => {
  const redis = new InMemoryRedis();
  const client = redis as unknown as RedisClient;
  const tx = await redis.watch();
  const conflicted = { ...tx, exec: async () => [] };
  const watch = vi.spyOn(redis, "watch").mockResolvedValueOnce(conflicted);
  await storeCorrespondingPost(client, "t3_source", "t3_mirror");
  expect(watch).toHaveBeenCalledTimes(2);
  expect(await redis.hGet(crosspostListKey, "t3_source")).toBe("t3_mirror");

  watch.mockResolvedValueOnce(conflicted).mockResolvedValueOnce(conflicted);
  await expect(removeCorrespondingPost(client, "t3_source")).rejects.toThrow(
    "Crosspost mapping transaction conflicted",
  );
  expect(watch).toHaveBeenCalledTimes(4);
  expect(await redis.hGet(crosspostListKey, "t3_source")).toBe("t3_mirror");
  await removeCorrespondingPost(client, "t3_source");
  expect(
    await redis.zScore(crosspostListByTimeKey, "t3_source"),
  ).toBeUndefined();
});

it("retries the same rebuild page after a concurrent mapping write aborts the transaction", async () => {
  const redis = new InMemoryRedis();
  const client = redis as unknown as RedisClient;
  const nowMs = Date.now();
  const getNewPosts = vi.fn(() =>
    listing([
      {
        id: "t3_oldmirror",
        crosspostParentId: "t3_source",
        authorId: "t2_app",
        createdAt: new Date(nowMs - 1000),
      },
    ]),
  );
  const reddit = {
    getAppUser: vi.fn().mockResolvedValue({ id: "t2_app" }),
    getNewPosts,
  } as unknown as RedditClient;
  const tx = await redis.watch();
  vi.spyOn(redis, "watch").mockResolvedValueOnce({
    ...tx,
    async exec() {
      await storeCorrespondingPost(client, "t3_source", "t3_newmirror");
      return [];
    },
  });

  await expect(
    rebuildCrosspostMappings(reddit, client, "SubGoal", nowMs),
  ).rejects.toThrow("Crosspost mapping transaction conflicted");
  const newerScore = await redis.zScore(crosspostListByTimeKey, "t3_source");
  await rebuildCrosspostMappings(reddit, client, "SubGoal", nowMs);
  expect(getNewPosts).toHaveBeenCalledTimes(2);
  expect(getNewPosts.mock.calls[0]).toEqual(getNewPosts.mock.calls[1]);
  expect(await redis.hGet(crosspostListKey, "t3_source")).toBe("t3_newmirror");
  expect(await redis.zScore(crosspostListByTimeKey, "t3_source")).toBe(
    newerScore,
  );
});
