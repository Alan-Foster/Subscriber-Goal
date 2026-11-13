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
  subscriberTrackingUsernameToUserIdKey,
  invalidateSubscriberTracking,
  processSubscriberTrackingRepairs,
} from "./subscriberTracking";
import {
  subscriberStatsByUserIdKey,
  subscriberStatsKey,
} from "./subscriberStats";
import {
  eraseFromRecentSubscribers,
  postRecentSubscriberOrderSuffix,
  subscriberGoalsKey,
} from "./subGoalData";
import { parseRecentSubscriberOrder } from "./recentSubscriberOrder";

type Entry = { member: string; score: number };

class MemoryRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  sorted = new Map<string, Map<string, number>>();
  versions = new Map<string, number>();
  beforeExec: (() => Promise<void>) | undefined;
  pendingReadFailures = new Set<string>();
  execFailures = 0;

  private changed(key: string): void {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  async get(key: string): Promise<string | undefined> {
    return this.strings.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.strings.set(key, value);
    this.changed(key);
  }
  async hGet(key: string, field: string): Promise<string | undefined> {
    if (
      key === subscriberTrackingPendingByOperationKey &&
      this.pendingReadFailures.delete(field)
    ) {
      throw new Error("transient read failure");
    }
    return this.hashes.get(key)?.get(field);
  }
  async hSet(key: string, values: Record<string, string>): Promise<void> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(values)) hash.set(field, value);
    this.hashes.set(key, hash);
    this.changed(key);
  }
  async hDel(key: string, fields: string[]): Promise<void> {
    for (const field of fields) this.hashes.get(key)?.delete(field);
    this.changed(key);
  }
  async hScan(key: string): Promise<{
    cursor: number;
    fieldValues: { field: string; value: string }[];
  }> {
    return {
      cursor: 0,
      fieldValues: [...(this.hashes.get(key) ?? [])].map(([field, value]) => ({
        field,
        value,
      })),
    };
  }
  async zAdd(key: string, ...entries: Entry[]): Promise<void> {
    const sorted = this.sorted.get(key) ?? new Map<string, number>();
    for (const entry of entries) sorted.set(entry.member, entry.score);
    this.sorted.set(key, sorted);
    this.changed(key);
  }
  async zRange(key: string, start: number, end: number): Promise<Entry[]> {
    const entries = [...(this.sorted.get(key) ?? new Map<string, number>())]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    return entries.slice(start, end < 0 ? undefined : end + 1);
  }
  async zRem(key: string, members: string[]): Promise<void> {
    for (const member of members) this.sorted.get(key)?.delete(member);
    this.changed(key);
  }
  async watch(...keys: string[]): Promise<MemoryTransaction> {
    return new MemoryTransaction(this, keys);
  }
}

class MemoryTransaction {
  private queued: (() => Promise<unknown>)[] = [];
  private inMulti = false;
  private readonly watchedVersions: Map<string, number>;
  constructor(
    private readonly redis: MemoryRedis,
    keys: string[],
  ) {
    this.watchedVersions = new Map(
      keys.map((key) => [key, redis.versions.get(key) ?? 0]),
    );
  }
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
    const hook = this.redis.beforeExec;
    this.redis.beforeExec = undefined;
    if (hook) await hook();
    if (this.redis.execFailures > 0) {
      this.redis.execFailures -= 1;
      throw new Error("transaction unavailable");
    }
    if (
      [...this.watchedVersions].some(
        ([key, version]) => (this.redis.versions.get(key) ?? 0) !== version,
      )
    ) {
      return [];
    }
    const results: unknown[] = [];
    for (const action of this.queued) results.push(await action());
    return results;
  }
}

const client = (redis: MemoryRedis): RedisClient =>
  redis as unknown as RedisClient;

describe("durable subscriber tracking", () => {
  it.each([
    {
      name: "newer public join",
      olderShares: true,
      newerShares: true,
      expectedName: "NewUser",
    },
    {
      name: "newer private join",
      olderShares: true,
      newerShares: false,
      expectedName: "",
    },
    {
      name: "older private join",
      olderShares: false,
      newerShares: true,
      expectedName: "NewUser",
    },
  ])(
    "keeps display order when a paused $name repair resumes",
    async ({ olderShares, newerShares, expectedName }) => {
      const redis = new MemoryRedis();
      const oldGeneration = await getSubscriberTrackingGeneration(
        client(redis),
        "t2_old",
      );
      const oldOperation = (
        await persistAcceptedSubscriberTracking(client(redis), {
          operationId: "op-old",
          userId: "t2_old",
          postId: "t3_post",
          username: "OldUser",
          subscribers: 101,
          timestamp: 1_000,
          shareUsername: olderShares,
          erasureGeneration: oldGeneration,
        })
      ).operation;

      redis.beforeExec = async () => {
        const newGeneration = await getSubscriberTrackingGeneration(
          client(redis),
          "t2_new",
        );
        const newOperation = (
          await persistAcceptedSubscriberTracking(client(redis), {
            operationId: "op-new",
            userId: "t2_new",
            postId: "t3_post",
            username: "NewUser",
            subscribers: 102,
            timestamp: 2_000,
            shareUsername: newerShares,
            erasureGeneration: newGeneration,
          })
        ).operation;
        await applySubscriberTracking(client(redis), newOperation);
      };

      await expect(
        applySubscriberTracking(client(redis), oldOperation),
      ).rejects.toThrow("subscriber_tracking_apply_conflict");
      await expect(
        applySubscriberTracking(client(redis), oldOperation),
      ).resolves.toBe("applied");

      expect(
        await redis.hGet(subscriberGoalsKey, "t3_post_recent_subscriber"),
      ).toBe(expectedName);
      expect(
        parseRecentSubscriberOrder(
          await redis.hGet(
            subscriberGoalsKey,
            `t3_post${postRecentSubscriberOrderSuffix}`,
          ),
        ),
      ).toMatchObject({ timestamp: 2_000, operationId: "op-new" });
      expect(await redis.hGet(subscriberStatsByUserIdKey, "t2_old")).toBe(
        "t2_old:OldUser:101:1000",
      );
    },
  );

  it("uses the operation ID as a deterministic timestamp tie-breaker", async () => {
    const redis = new MemoryRedis();
    for (const [userId, operationId, username] of [
      ["t2_z", "op-z", "Zulu"],
      ["t2_a", "op-a", "Alpha"],
    ] as const) {
      const generation = await getSubscriberTrackingGeneration(
        client(redis),
        userId,
      );
      const operation = (
        await persistAcceptedSubscriberTracking(client(redis), {
          operationId,
          userId,
          postId: "t3_post",
          username,
          subscribers: 101,
          timestamp: 1_000,
          shareUsername: true,
          erasureGeneration: generation,
        })
      ).operation;
      await applySubscriberTracking(client(redis), operation);
    }

    expect(
      await redis.hGet(subscriberGoalsKey, "t3_post_recent_subscriber"),
    ).toBe("Zulu");
  });

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
    await cleanupSubscriberTracking(client(redis), {
      ...first,
      phase: "complete",
    });
    expect(
      await redis.hGet(subscriberTrackingUsernameToUserIdKey, "alice"),
    ).toBeUndefined();

    await redis.hSet(subscriberTrackingPendingByUserKey, { t2_u: "op-first" });
    await redis.hSet(subscriberTrackingPendingByOperationKey, {
      "op-first": JSON.stringify({ ...first, phase: "complete" }),
    });
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

  it("removes a leftover username mapping even when no pending item remains", async () => {
    const redis = new MemoryRedis();
    await redis.hSet(subscriberTrackingUsernameToUserIdKey, {
      alice: "t2_u",
    });

    await invalidateSubscriberTracking(client(redis), "t2_u");

    expect(
      await redis.hGet(subscriberTrackingUsernameToUserIdKey, "alice"),
    ).toBeUndefined();
  });

  it("erasure preserves the ordering token and does not clear a fresh join", async () => {
    const redis = new MemoryRedis();
    const initialGeneration = await getSubscriberTrackingGeneration(
      client(redis),
      "t2_u",
    );
    const old = (
      await persistAcceptedSubscriberTracking(client(redis), {
        operationId: "op-old",
        userId: "t2_u",
        postId: "t3_post",
        username: "Alice",
        subscribers: 101,
        timestamp: 1_000,
        shareUsername: true,
        erasureGeneration: initialGeneration,
      })
    ).operation;
    await applySubscriberTracking(client(redis), old);
    await cleanupSubscriberTracking(client(redis), {
      ...old,
      phase: "complete",
    });
    await invalidateSubscriberTracking(client(redis), "t2_u");
    const freshGeneration = await getSubscriberTrackingGeneration(
      client(redis),
      "t2_u",
    );
    const fresh = (
      await persistAcceptedSubscriberTracking(client(redis), {
        operationId: "op-fresh",
        userId: "t2_u",
        postId: "t3_post",
        username: "Alice",
        subscribers: 102,
        timestamp: 2_000,
        shareUsername: true,
        erasureGeneration: freshGeneration,
      })
    ).operation;
    // Simulate subscriber-record erasure before the genuinely fresh join is
    // applied, then let the delayed display erasure race with that join.
    await redis.hDel(subscriberStatsByUserIdKey, ["t2_u"]);
    await applySubscriberTracking(client(redis), fresh);
    const orderBeforeErasure = await redis.hGet(
      subscriberGoalsKey,
      `t3_post${postRecentSubscriberOrderSuffix}`,
    );

    await eraseFromRecentSubscribers(client(redis), "Alice");

    expect(
      await redis.hGet(subscriberGoalsKey, "t3_post_recent_subscriber"),
    ).toBe("Alice");
    expect(
      await redis.hGet(
        subscriberGoalsKey,
        `t3_post${postRecentSubscriberOrderSuffix}`,
      ),
    ).toBe(orderBeforeErasure);
  });

  it("does not recreate erased work while a failed repair is rescheduling", async () => {
    const redis = new MemoryRedis();
    const generation = await getSubscriberTrackingGeneration(
      client(redis),
      "t2_u",
    );
    await persistAcceptedSubscriberTracking(client(redis), {
      operationId: "op-old",
      userId: "t2_u",
      postId: "t3_post",
      username: "Alice",
      subscribers: 101,
      timestamp: 1_000,
      shareUsername: true,
      erasureGeneration: generation,
    });
    redis.beforeExec = async () => {
      await invalidateSubscriberTracking(client(redis), "t2_u");
    };

    await processSubscriberTrackingRepairs(client(redis), { nowMs: 2_000 });

    expect(
      await redis.hGet(subscriberTrackingPendingByOperationKey, "op-old"),
    ).toBeUndefined();
    expect(await redis.zRange(subscriberTrackingQueueKey, 0, -1)).toEqual([]);
    expect(
      await redis.hGet(subscriberTrackingUsernameToUserIdKey, "alice"),
    ).toBeUndefined();
  });

  it("leaves a fresh post-erasure join intact when stale repair resumes", async () => {
    const redis = new MemoryRedis();
    const generation = await getSubscriberTrackingGeneration(
      client(redis),
      "t2_u",
    );
    await persistAcceptedSubscriberTracking(client(redis), {
      operationId: "op-old",
      userId: "t2_u",
      postId: "t3_old",
      username: "Alice",
      subscribers: 101,
      timestamp: 1_000,
      shareUsername: true,
      erasureGeneration: generation,
    });
    redis.beforeExec = async () => {
      await invalidateSubscriberTracking(client(redis), "t2_u");
      const freshGeneration = await getSubscriberTrackingGeneration(
        client(redis),
        "t2_u",
      );
      await persistAcceptedSubscriberTracking(client(redis), {
        operationId: "op-fresh",
        userId: "t2_u",
        postId: "t3_fresh",
        username: "Alice",
        subscribers: 102,
        timestamp: 2_000,
        shareUsername: false,
        erasureGeneration: freshGeneration,
      });
    };

    await processSubscriberTrackingRepairs(client(redis), { nowMs: 3_000 });

    expect(await redis.hGet(subscriberTrackingPendingByUserKey, "t2_u")).toBe(
      "op-fresh",
    );
    expect(
      await redis.hGet(subscriberTrackingPendingByOperationKey, "op-fresh"),
    ).toBeDefined();
    expect(
      await redis.hGet(subscriberTrackingUsernameToUserIdKey, "alice"),
    ).toContain("op-fresh");
  });

  it.each(["missing", "malformed"])(
    "advances past a full batch of %s queue entries",
    async (kind) => {
      const redis = new MemoryRedis();
      for (let index = 0; index < 25; index += 1) {
        const operationId = `bad-${String(index).padStart(2, "0")}`;
        await redis.zAdd(subscriberTrackingQueueKey, {
          member: operationId,
          score: index,
        });
        if (kind === "malformed") {
          await redis.hSet(subscriberTrackingPendingByOperationKey, {
            [operationId]: "not-json",
          });
        }
      }
      const generation = await getSubscriberTrackingGeneration(
        client(redis),
        "t2_valid",
      );
      await persistAcceptedSubscriberTracking(client(redis), {
        operationId: "valid",
        userId: "t2_valid",
        postId: "t3_post",
        username: "ValidUser",
        subscribers: 126,
        timestamp: 25,
        shareUsername: true,
        erasureGeneration: generation,
      });

      const first = await processSubscriberTrackingRepairs(client(redis), {
        nowMs: 1_000,
      });
      const second = await processSubscriberTrackingRepairs(client(redis), {
        nowMs: 1_000,
      });

      expect(first.read).toBe(25);
      expect(second.read).toBe(1);
      expect(await redis.hGet(subscriberStatsByUserIdKey, "t2_valid")).toBe(
        "t2_valid:ValidUser:126:25",
      );
      expect(await redis.zRange(subscriberTrackingQueueKey, 0, -1)).toEqual([]);
    },
  );

  it("defers transient read failures so later due work progresses", async () => {
    const redis = new MemoryRedis();
    for (let index = 0; index < 25; index += 1) {
      const operationId = `transient-${String(index).padStart(2, "0")}`;
      await redis.zAdd(subscriberTrackingQueueKey, {
        member: operationId,
        score: index,
      });
      redis.pendingReadFailures.add(operationId);
    }
    const generation = await getSubscriberTrackingGeneration(
      client(redis),
      "t2_valid",
    );
    await persistAcceptedSubscriberTracking(client(redis), {
      operationId: "valid",
      userId: "t2_valid",
      postId: "t3_post",
      username: "ValidUser",
      subscribers: 126,
      timestamp: 25,
      shareUsername: true,
      erasureGeneration: generation,
    });

    await processSubscriberTrackingRepairs(client(redis), { nowMs: 1_000 });
    await processSubscriberTrackingRepairs(client(redis), { nowMs: 1_000 });

    expect(await redis.hGet(subscriberStatsByUserIdKey, "t2_valid")).toBe(
      "t2_valid:ValidUser:126:25",
    );
    expect(await redis.zRange(subscriberTrackingQueueKey, 0, -1)).toHaveLength(
      25,
    );
  });

  it("keeps valid work discoverable after rescheduling fails", async () => {
    const redis = new MemoryRedis();
    const failingGeneration = await getSubscriberTrackingGeneration(
      client(redis),
      "t2_failing",
    );
    await persistAcceptedSubscriberTracking(client(redis), {
      operationId: "failing",
      userId: "t2_failing",
      postId: "t3_fail",
      username: "FailingUser",
      subscribers: 101,
      timestamp: 0,
      shareUsername: true,
      erasureGeneration: failingGeneration,
    });
    for (let index = 1; index < 25; index += 1) {
      await redis.zAdd(subscriberTrackingQueueKey, {
        member: `orphan-${index}`,
        score: index,
      });
    }
    const validGeneration = await getSubscriberTrackingGeneration(
      client(redis),
      "t2_valid",
    );
    await persistAcceptedSubscriberTracking(client(redis), {
      operationId: "valid",
      userId: "t2_valid",
      postId: "t3_valid",
      username: "ValidUser",
      subscribers: 126,
      timestamp: 25,
      shareUsername: true,
      erasureGeneration: validGeneration,
    });
    redis.execFailures = 2;

    await processSubscriberTrackingRepairs(client(redis), { nowMs: 1_000 });
    expect(
      (await redis.zRange(subscriberTrackingQueueKey, 0, -1)).map(
        ({ member }) => member,
      ),
    ).toContain("failing");
    await processSubscriberTrackingRepairs(client(redis), { nowMs: 1_000 });
    await processSubscriberTrackingRepairs(client(redis), { nowMs: 1_000 });

    expect(await redis.hGet(subscriberStatsByUserIdKey, "t2_valid")).toBe(
      "t2_valid:ValidUser:126:25",
    );
  });
});
