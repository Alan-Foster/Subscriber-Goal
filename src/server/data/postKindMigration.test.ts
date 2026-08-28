import { describe, expect, it, vi } from "vitest";
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
  processPostKindMigrationBatch,
} from "./postKindMigration";

type ZEntry = { member: string; score: number };

class TestRedis {
  hashes = new Map<string, Map<string, string>>();
  sortedSets = new Map<string, Map<string, number>>();

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
  it("repairs a legacy positive goal misclassified as Tiny without replacing it", async () => {
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
      repaired: 1,
      preservedShort: 0,
      recognizedTiny: 0,
      conflicting: 1,
      failed: 0,
    });
    expect(reddit.getPostById).toHaveBeenCalledWith("t3_legacy");
    expect(post.mergePostData).toHaveBeenCalledWith({
      postKind: subscriberGoalPostKind,
    });
    expect(post.setCustomPostStyles).toHaveBeenNthCalledWith(1, undefined);
    expect(post.setCustomPostStyles).toHaveBeenNthCalledWith(2, { height: 1 });
    await expect(
      redis.hGet(subscriberGoalsKey, `t3_legacy${postKindSuffix}`),
    ).resolves.toBe(subscriberGoalPostKind);
    await expect(
      redis.hGet(subscriberGoalsKey, `t3_legacy${postHeightSuffix}`),
    ).resolves.toBe("regular");
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
    ).resolves.toEqual([{ member: "t3_retry", score: 0 }]);
  });
});
