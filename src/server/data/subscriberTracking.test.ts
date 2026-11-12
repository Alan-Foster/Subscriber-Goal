import { describe, expect, it } from "vitest";
import type { RedisClient } from "../types";
import {
  applySubscriberTracking,
  cleanupSubscriberTracking,
  getPendingSubscriberTracking,
  getSubscriberTrackingGeneration,
  persistAcceptedSubscriberTracking,
  subscriberTrackingPendingByOperationKey,
  subscriberTrackingPendingByUserKey,
  subscriberTrackingQueueKey,
} from "./subscriberTracking";
import {
  subscriberStatsByUserIdKey,
  subscriberStatsKey,
} from "./subscriberStats";
import { subscriberGoalsKey } from "./subGoalData";

type Entry = { member: string; score: number };

class MemoryRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  sorted = new Map<string, Map<string, number>>();

  async get(key: string): Promise<string | undefined> {
    return this.strings.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.strings.set(key, value);
  }
  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }
  async hSet(key: string, values: Record<string, string>): Promise<void> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(values)) hash.set(field, value);
    this.hashes.set(key, hash);
  }
  async hDel(key: string, fields: string[]): Promise<void> {
    for (const field of fields) this.hashes.get(key)?.delete(field);
  }
  async zAdd(key: string, ...entries: Entry[]): Promise<void> {
    const sorted = this.sorted.get(key) ?? new Map<string, number>();
    for (const entry of entries) sorted.set(entry.member, entry.score);
    this.sorted.set(key, sorted);
  }
  async zRange(key: string, start: number, end: number): Promise<Entry[]> {
    const entries = [...(this.sorted.get(key) ?? new Map<string, number>())]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    return entries.slice(start, end < 0 ? undefined : end + 1);
  }
  async zRem(key: string, members: string[]): Promise<void> {
    for (const member of members) this.sorted.get(key)?.delete(member);
  }
  async watch(): Promise<MemoryTransaction> {
    return new MemoryTransaction(this);
  }
}

class MemoryTransaction {
  private queued: (() => Promise<unknown>)[] = [];
  private inMulti = false;
  constructor(private readonly redis: MemoryRedis) {}
  async multi(): Promise<void> {
    this.inMulti = true;
  }
  async unwatch(): Promise<this> {
    return this;
  }
  private async command(action: () => Promise<unknown>): Promise<this> {
    if (this.inMulti) this.queued.push(action);
    else await action();
    return this;
  }
  async set(key: string, value: string): Promise<this> {
    return await this.command(() => this.redis.set(key, value));
  }
  async hSet(key: string, values: Record<string, string>): Promise<this> {
    return await this.command(() => this.redis.hSet(key, values));
  }
  async hDel(key: string, fields: string[]): Promise<this> {
    return await this.command(() => this.redis.hDel(key, fields));
  }
  async zAdd(key: string, ...entries: Entry[]): Promise<this> {
    return await this.command(() => this.redis.zAdd(key, ...entries));
  }
  async zRem(key: string, members: string[]): Promise<this> {
    return await this.command(() => this.redis.zRem(key, members));
  }
  async exec(): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const action of this.queued) results.push(await action());
    return results;
  }
}

const client = (redis: MemoryRedis): RedisClient =>
  redis as unknown as RedisClient;

describe("durable subscriber tracking", () => {
  it("keeps the winning join inputs across overlapping accepted requests", async () => {
    const redis = new MemoryRedis();
    const generation = await getSubscriberTrackingGeneration(
      client(redis),
      "t2_u",
    );
    const first = await persistAcceptedSubscriberTracking(client(redis), {
      operationId: "op-first",
      userId: "t2_u",
      postId: "t3_first",
      username: "Alice",
      subscribers: 101,
      timestamp: 1_000,
      shareUsername: true,
      erasureGeneration: generation,
    });
    const second = await persistAcceptedSubscriberTracking(client(redis), {
      operationId: "op-second",
      userId: "t2_u",
      postId: "t3_second",
      username: "Alice",
      subscribers: 102,
      timestamp: 1_001,
      shareUsername: false,
      erasureGeneration: generation,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.operation).toMatchObject({
      operationId: "op-first",
      postId: "t3_first",
      subscribers: 101,
      timestamp: 1_000,
      shareUsername: true,
    });

    await expect(
      applySubscriberTracking(client(redis), second.operation),
    ).resolves.toBe("applied");
    expect(await redis.hGet(subscriberStatsByUserIdKey, "t2_u")).toBe(
      "t2_u:Alice:101:1000",
    );
    expect(await redis.zRange(subscriberStatsKey, 0, -1)).toEqual([
      { member: "t2_u:Alice:101", score: 1_000 },
    ]);
    expect(
      await redis.hGet(subscriberGoalsKey, "t3_first_recent_subscriber"),
    ).toBe("Alice");
    expect(
      await redis.hGet(subscriberGoalsKey, "t3_second_recent_subscriber"),
    ).toBeUndefined();
  });

  it("does not let stale cleanup remove a newer operation", async () => {
    const redis = new MemoryRedis();
    const generation = await getSubscriberTrackingGeneration(
      client(redis),
      "t2_u",
    );
    const first = (
      await persistAcceptedSubscriberTracking(client(redis), {
        operationId: "op-first",
        userId: "t2_u",
        postId: "t3_first",
        username: "Alice",
        subscribers: 101,
        timestamp: 1_000,
        shareUsername: true,
        erasureGeneration: generation,
      })
    ).operation;
    await applySubscriberTracking(client(redis), first);
    await redis.hSet(subscriberTrackingPendingByUserKey, { t2_u: "op-new" });
    await redis.hSet(subscriberTrackingPendingByOperationKey, {
      "op-new": JSON.stringify({ ...first, operationId: "op-new" }),
    });
    await redis.zAdd(subscriberTrackingQueueKey, {
      member: "op-new",
      score: 2_000,
    });

    await expect(
      cleanupSubscriberTracking(client(redis), { ...first, phase: "complete" }),
    ).resolves.toBe(false);
    expect(
      await getPendingSubscriberTracking(client(redis), "t2_u"),
    ).toMatchObject({
      operationId: "op-new",
    });
  });
});
