import { afterEach, describe, expect, it, vi } from "vitest";
import { subscriberGoalPostKind } from "../../shared/postKind";
import {
  postHeightSuffix,
  postKindSuffix,
  subscriberGoalsKey,
} from "./subGoalData";
import {
  initializePostKindMigration,
  postKindMigrationQueueKey,
  postKindMigrationStateKey,
  postKindMigrationTerminalKey,
  processPostKindMigrationBatch,
} from "./postKindMigration";

type ZEntry = { member: string; score: number };
const minuteMs = 60 * 1000;
const startTime = Date.UTC(2026, 10, 20);

class TestRedis {
  values = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  sortedSets = new Map<string, Map<string, number>>();

  async set(key: string, value: string, options?: { nx?: boolean }) {
    if (!options?.nx || !this.values.has(key)) this.values.set(key, value);
  }
  async get(key: string) {
    return this.values.get(key);
  }
  async watch(key: string) {
    const watchedValue = this.values.get(key);
    const commands: Array<() => unknown> = [];
    return {
      multi: async () => undefined,
      unwatch: async () => undefined,
      discard: async () => undefined,
      del: async () => {
        commands.push(() => this.values.delete(key));
      },
      hSet: async (hash: string, fields: Record<string, string>) => {
        commands.push(() => this.hSet(hash, fields));
      },
      zAdd: async (set: string, entry: ZEntry) => {
        commands.push(() => this.zAdd(set, entry));
      },
      exec: async () => {
        if (this.values.get(key) !== watchedValue) return [];
        return Promise.all(commands.map((command) => command()));
      },
    };
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }
  async hGetAll(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key)?.entries() ?? []);
  }
  async hMGet(key: string, fields: string[]): Promise<Array<string | null>> {
    return fields.map((field) => this.hashes.get(key)?.get(field) ?? null);
  }
  async hSet(key: string, fields: Record<string, string>): Promise<void> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    Object.entries(fields).forEach(([field, value]) => hash.set(field, value));
    this.hashes.set(key, hash);
  }
  async hDel(key: string, fields: string[]): Promise<void> {
    for (const field of fields) this.hashes.get(key)?.delete(field);
  }
  async zAdd(key: string, ...entries: ZEntry[]): Promise<void> {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    entries.forEach(({ member, score }) => set.set(member, score));
    this.sortedSets.set(key, set);
  }
  async zRange(key: string, start: number, end: number): Promise<ZEntry[]> {
    const entries = [...(this.sortedSets.get(key)?.entries() ?? [])]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score);
    return entries.slice(start, end < 0 ? undefined : end + 1);
  }
  async zRem(key: string, members: string[]): Promise<void> {
    members.forEach((member) => this.sortedSets.get(key)?.delete(member));
  }
}

const asRedis = (redis: TestRedis) =>
  redis as unknown as Parameters<typeof initializePostKindMigration>[0];

describe("post kind compatibility migration", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not complete or inspect a migration that was never initialized", async () => {
    const redis = new TestRedis();
    const reddit = { getPostById: vi.fn() };

    await expect(
      processPostKindMigrationBatch(reddit as never, asRedis(redis)),
    ).resolves.toMatchObject({ scanned: 0, failed: 0 });
    expect(await redis.hGetAll(postKindMigrationStateKey)).toEqual({});
    expect(reddit.getPostById).not.toHaveBeenCalled();
  });

  it("moves malformed candidate ids to terminal state", async () => {
    const redis = new TestRedis();
    const reddit = { getPostById: vi.fn() };
    await initializePostKindMigration(asRedis(redis), ["bad-id"]);

    await expect(
      processPostKindMigrationBatch(reddit as never, asRedis(redis)),
    ).resolves.toMatchObject({ scanned: 1, failed: 0 });
    expect(await redis.hGet(postKindMigrationTerminalKey, "bad-id")).toBe(
      "invalid_post_id",
    );
    expect(await redis.zRange(postKindMigrationQueueKey, 0, -1)).toEqual([]);
  });

  it("preserves conflicting legacy Tiny evidence for manual review", async () => {
    const redis = new TestRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_legacy_goal: "250",
      t3_legacy_recent_subscriber: "ExistingUser",
      t3_legacy_completed_time: "123",
      [`t3_legacy${postHeightSuffix}`]: "tiny",
    });
    const post = {
      mergePostData: vi.fn(),
      setCustomPostStyles: vi.fn(),
    };
    const reddit = { getPostById: vi.fn().mockResolvedValue(post) };

    await initializePostKindMigration(asRedis(redis), ["t3_legacy"]);
    const summary = await processPostKindMigrationBatch(
      reddit as never,
      asRedis(redis),
    );

    expect(summary).toEqual({
      scanned: 1,
      repaired: 0,
      preservedShort: 0,
      recognizedTiny: 0,
      conflicting: 1,
      failed: 0,
    });
    expect(reddit.getPostById).toHaveBeenCalledWith("t3_legacy");
    expect(post.mergePostData).not.toHaveBeenCalled();
    expect(post.setCustomPostStyles).not.toHaveBeenCalled();
    await expect(
      redis.hGet(subscriberGoalsKey, `t3_legacy${postKindSuffix}`),
    ).resolves.toBeUndefined();
    await expect(
      redis.hGet(subscriberGoalsKey, `t3_legacy${postHeightSuffix}`),
    ).resolves.toBe("tiny");
    await expect(
      redis.hGet(subscriberGoalsKey, "t3_legacy_goal"),
    ).resolves.toBe("250");
    await expect(
      redis.hGet(subscriberGoalsKey, "t3_legacy_recent_subscriber"),
    ).resolves.toBe("ExistingUser");
    await expect(
      redis.hGet(subscriberGoalsKey, "t3_legacy_completed_time"),
    ).resolves.toBe("123");
  });

  it("preserves Short goals and initializes only once", async () => {
    const redis = new TestRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_short_goal: "100",
      [`t3_short${postHeightSuffix}`]: "short",
    });
    const post = {
      mergePostData: vi.fn(),
      setCustomPostStyles: vi.fn(),
    };
    const reddit = { getPostById: vi.fn().mockResolvedValue(post) };

    await initializePostKindMigration(asRedis(redis), ["t3_short"]);
    await initializePostKindMigration(asRedis(redis), ["t3_should_not_queue"]);
    const summary = await processPostKindMigrationBatch(
      reddit as never,
      asRedis(redis),
    );

    expect(summary.preservedShort).toBe(1);
    expect(post.setCustomPostStyles).toHaveBeenCalledWith({
      height: 0,
      heightPixels: 234,
    });
    await expect(
      redis.zRange(postKindMigrationQueueKey, 0, -1),
    ).resolves.toEqual([]);
    await expect(redis.hGet(postKindMigrationStateKey, "status")).resolves.toBe(
      "complete",
    );
  });

  it("keeps failed posts queued for a later retry", async () => {
    const redis = new TestRedis();
    const clock = vi.spyOn(Date, "now").mockReturnValue(startTime);
    await redis.hSet(subscriberGoalsKey, { t3_retry_goal: "100" });
    const reddit = {
      getPostById: vi.fn().mockRejectedValue(new Error("temporary")),
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await initializePostKindMigration(asRedis(redis), ["t3_retry"]);
    const summary = await processPostKindMigrationBatch(
      reddit as never,
      asRedis(redis),
    );

    expect(summary.failed).toBe(1);
    await expect(
      redis.zRange(postKindMigrationQueueKey, 0, -1),
    ).resolves.toEqual([
      { member: "t3_retry", score: startTime + 5 * minuteMs },
    ]);
    expect(
      await redis.hGet(postKindMigrationTerminalKey, "t3_retry"),
    ).toBeUndefined();

    const post = { mergePostData: vi.fn() };
    reddit.getPostById.mockResolvedValue(post);
    clock.mockReturnValue(startTime + 5 * minuteMs);
    await expect(
      processPostKindMigrationBatch(reddit as never, asRedis(redis)),
    ).resolves.toMatchObject({ scanned: 1, failed: 0 });
    expect(post.mergePostData).toHaveBeenCalledWith({
      postKind: subscriberGoalPostKind,
    });
    expect(await redis.hGet(postKindMigrationStateKey, "status")).toBe(
      "complete",
    );
  });

  it("doubles the retry delay and requires a failed attempt at the 24-hour deadline", async () => {
    const redis = new TestRedis();
    const clock = vi.spyOn(Date, "now").mockReturnValue(startTime);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reddit = {
      getPostById: vi.fn().mockRejectedValue(new Error("temporary")),
    };
    await initializePostKindMigration(asRedis(redis), ["t3_retry"]);
    const migrate = () =>
      processPostKindMigrationBatch(reddit as never, asRedis(redis));

    await expect(migrate()).resolves.toMatchObject({ scanned: 1, failed: 1 });
    const retryMinutes = [5, 15, 35, 75, 155, 315, 635, 1275, 1440];
    for (const [index, minutes] of retryMinutes.entries()) {
      const retryAt = startTime + minutes * minuteMs;
      expect(await redis.zRange(postKindMigrationQueueKey, 0, -1)).toEqual([
        { member: "t3_retry", score: retryAt },
      ]);
      clock.mockReturnValue(retryAt - minuteMs);
      await expect(migrate()).resolves.toMatchObject({ scanned: 0, failed: 0 });
      expect(reddit.getPostById).toHaveBeenCalledTimes(index + 1);
      expect(await redis.hGet(postKindMigrationStateKey, "status")).toBe(
        "running",
      );
      expect(
        await redis.hGet(postKindMigrationTerminalKey, "t3_retry"),
      ).toBeUndefined();
      clock.mockReturnValue(retryAt);
      await expect(migrate()).resolves.toMatchObject({ scanned: 1, failed: 1 });
    }
    expect(reddit.getPostById).toHaveBeenCalledTimes(10);
    expect(await redis.hGet(postKindMigrationTerminalKey, "t3_retry")).toBe(
      "retry_exhausted",
    );
    expect(await redis.hGet(postKindMigrationStateKey, "status")).toBe(
      "complete",
    );
  });

  it.each(["archived flag", "archived style error"])(
    "preserves Redis classification for a Short goal with an %s",
    async (scenario) => {
      const redis = new TestRedis();
      const postId = "t3_archived";
      await redis.hSet(subscriberGoalsKey, {
        [`${postId}_goal`]: "100",
        [`${postId}${postHeightSuffix}`]: "short",
      });
      const post = {
        archived: scenario === "archived flag",
        mergePostData: vi.fn(),
        setCustomPostStyles: vi
          .fn()
          .mockRejectedValue(new Error("Post is archived")),
      };
      const reddit = { getPostById: vi.fn().mockResolvedValue(post) };
      await initializePostKindMigration(asRedis(redis), [postId]);

      await expect(
        processPostKindMigrationBatch(reddit as never, asRedis(redis)),
      ).resolves.toMatchObject({ scanned: 1, failed: 0, preservedShort: 1 });
      expect(post.mergePostData).toHaveBeenCalledTimes(post.archived ? 0 : 1);
      expect(post.setCustomPostStyles).toHaveBeenCalledTimes(
        post.archived ? 0 : 1,
      );
      expect(
        await redis.hGet(subscriberGoalsKey, `${postId}${postKindSuffix}`),
      ).toBe(subscriberGoalPostKind);
      expect(
        await redis.hGet(subscriberGoalsKey, `${postId}${postHeightSuffix}`),
      ).toBe("short");
      expect(await redis.hGet(postKindMigrationStateKey, "status")).toBe(
        "complete",
      );
    },
  );

  it("makes missing and deleted posts terminal without a mutation", async () => {
    const redis = new TestRedis();
    const deleted = { removedByCategory: "deleted", mergePostData: vi.fn() };
    const reddit = {
      getPostById: vi
        .fn()
        .mockRejectedValueOnce(new Error("no post t3_missing"))
        .mockResolvedValueOnce(deleted),
    };
    await initializePostKindMigration(asRedis(redis), [
      "t3_missing",
      "t3_deleted",
    ]);
    await expect(
      processPostKindMigrationBatch(reddit as never, asRedis(redis)),
    ).resolves.toMatchObject({ scanned: 2, failed: 2 });
    expect(await redis.hGetAll(postKindMigrationTerminalKey)).toEqual({
      t3_missing: "post_missing",
      t3_deleted: "post_deleted",
    });
    expect(deleted.mergePostData).not.toHaveBeenCalled();
    expect(await redis.hGet(postKindMigrationStateKey, "status")).toBe(
      "complete",
    );
  });

  it("finishes queue cleanup for a record whose terminal write already committed", async () => {
    const redis = new TestRedis();
    const postId = "t3_missing";
    const reddit = { getPostById: vi.fn().mockRejectedValue({ status: 404 }) };
    await initializePostKindMigration(asRedis(redis), [postId]);
    vi.spyOn(redis, "zRem").mockRejectedValueOnce(
      new Error("Redis unavailable"),
    );
    const migrate = () =>
      processPostKindMigrationBatch(reddit as never, asRedis(redis));

    await expect(migrate()).rejects.toThrow("Redis unavailable");
    expect(await redis.hGet(postKindMigrationTerminalKey, postId)).toBe(
      "post_missing",
    );
    await expect(migrate()).resolves.toMatchObject({ scanned: 1, failed: 0 });
    expect(reddit.getPostById).toHaveBeenCalledOnce();
    expect(await redis.hGet(postKindMigrationStateKey, "status")).toBe(
      "complete",
    );
  });

  it.each(["archived", "unrecognized"])(
    "migrates a healthy post behind ten %s mutation failures",
    async (scenario) => {
      const redis = new TestRedis();
      const clock = vi.spyOn(Date, "now").mockReturnValue(startTime);
      const failing = Array.from(
        { length: 10 },
        (_, index) => `t3_failing${index}`,
      );
      const healthy = { mergePostData: vi.fn() };
      const failed = {
        archived: scenario === "archived",
        mergePostData: vi.fn().mockRejectedValue(new Error("update rejected")),
      };
      const reddit = {
        getPostById: vi.fn(async (postId: string) =>
          postId === "t3_healthy" ? healthy : failed,
        ),
      };
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await initializePostKindMigration(asRedis(redis), [
        ...failing,
        "t3_healthy",
      ]);
      const migrate = () =>
        processPostKindMigrationBatch(reddit as never, asRedis(redis));

      await expect(migrate()).resolves.toMatchObject({ scanned: 10 });
      expect(await redis.hGet(postKindMigrationStateKey, "status")).toBe(
        "running",
      );
      await migrate();
      expect(healthy.mergePostData).toHaveBeenCalledOnce();
      expect(
        await redis.hGet(subscriberGoalsKey, `t3_healthy${postKindSuffix}`),
      ).toBe(subscriberGoalPostKind);

      if (scenario === "unrecognized") {
        expect(await redis.hGet(postKindMigrationStateKey, "status")).toBe(
          "running",
        );
        expect(failed.mergePostData).toHaveBeenCalledTimes(10);
        clock.mockReturnValue(startTime + 24 * 60 * minuteMs);
        await migrate();
        expect(failed.mergePostData).toHaveBeenCalledTimes(20);
        expect(await redis.hGetAll(postKindMigrationTerminalKey)).toEqual(
          Object.fromEntries(
            failing.map((postId) => [postId, "retry_exhausted"]),
          ),
        );
      } else {
        expect(failed.mergePostData).not.toHaveBeenCalled();
        for (const postId of failing) {
          expect(
            await redis.hGet(subscriberGoalsKey, `${postId}${postKindSuffix}`),
          ).toBe(subscriberGoalPostKind);
        }
      }
      expect(await redis.zRange(postKindMigrationQueueKey, 0, -1)).toEqual([]);
      expect(await redis.hGet(postKindMigrationStateKey, "status")).toBe(
        "complete",
      );
      expect(await redis.hGet(postKindMigrationStateKey, "failed")).toBe(
        scenario === "archived" ? "0" : "20",
      );
      await expect(migrate()).resolves.toMatchObject({ scanned: 0 });
    },
  );

  it("does not charge another attempt while a batch is processing the queue", async () => {
    const redis = new TestRedis();
    await initializePostKindMigration(asRedis(redis), ["t3_pending"]);
    const post = { mergePostData: vi.fn() };
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const reddit = {
      getPostById: vi.fn(async () => {
        started.resolve();
        await resume.promise;
        return post;
      }),
    };
    const migrate = () =>
      processPostKindMigrationBatch(reddit as never, asRedis(redis));
    const processing = migrate();
    await started.promise;
    try {
      await expect(migrate()).resolves.toMatchObject({ scanned: 0, failed: 0 });
    } finally {
      resume.resolve();
    }
    await processing;
    expect(reddit.getPostById).toHaveBeenCalledOnce();
    expect(post.mergePostData).toHaveBeenCalledOnce();
  });
});
