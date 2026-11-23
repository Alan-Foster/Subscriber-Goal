import { beforeEach, describe, expect, it } from "vitest";
import {
  recentSubscriberPostsByUsernameKey,
  subscriberGoalsKey,
} from "./subGoalData";
import { subscriberTrackingGenerationKey } from "./subscriberTrackingKeys";
import {
  getSubscriberStats,
  isTrackedSubscriber,
  subscriberStatsErasedUserIdsKey,
  subscriberStatsByUserIdKey,
  subscriberStatusByUserIdKey,
  subscriberStatsLegacyMembersByUserIdKey,
  subscriberStatsKey,
  subscriberStatsUsernameToUserIdKey,
  untrackSubscriberById,
  untrackSubscriberByUsername,
} from "./subscriberStats";

type ZEntry = { member: string; score: number };

class InMemoryRedis {
  private strings = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private sortedSets = new Map<string, Map<string, number>>();
  zRangeCalls = 0;

  async get(key: string): Promise<string | undefined> {
    return this.strings.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.strings.set(key, value);
  }

  async watch() {
    const queued: (() => Promise<unknown>)[] = [];
    return {
      multi: async () => {},
      unwatch: async () => {},
      hSet: async (key: string, fields: Record<string, string>) => {
        queued.push(() => this.hSet(key, fields));
      },
      hDel: async (key: string, fields: string[]) => {
        queued.push(() => this.hDel(key, fields));
      },
      zRem: async (key: string, members: string[]) => {
        queued.push(() => this.zRem(key, members));
      },
      exec: async () => {
        const results = [];
        for (const action of queued) results.push(await action());
        return results;
      },
    };
  }

  async hSet(key: string, fields: Record<string, string>): Promise<number> {
    const current = this.hashes.get(key) ?? new Map<string, string>();
    let added = 0;
    for (const [field, value] of Object.entries(fields)) {
      if (!current.has(field)) {
        added += 1;
      }
      current.set(field, value);
    }
    this.hashes.set(key, current);
    return added;
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    const map = this.hashes.get(key) ?? new Map<string, string>();
    return Object.fromEntries(map.entries());
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

  async hDel(key: string, fields: string[]): Promise<void> {
    const map = this.hashes.get(key);
    if (!map) {
      return;
    }
    for (const field of fields) {
      map.delete(field);
    }
  }

  async hLen(key: string): Promise<number> {
    return this.hashes.get(key)?.size ?? 0;
  }

  async zAdd(key: string, ...entries: ZEntry[]): Promise<number> {
    const current = this.sortedSets.get(key) ?? new Map<string, number>();
    let added = 0;
    for (const entry of entries) {
      if (!current.has(entry.member)) {
        added += 1;
      }
      current.set(entry.member, entry.score);
    }
    this.sortedSets.set(key, current);
    return added;
  }

  async zRange(
    key: string,
    start: number,
    end: number,
    options?: { by: "score" | "lex" | "rank" },
  ): Promise<ZEntry[]> {
    this.zRangeCalls += 1;
    const sorted = this.sortedEntries(key);
    if (options?.by === "score") {
      return sorted.filter(
        (entry) => entry.score >= start && entry.score <= end,
      );
    }
    const normalizedEnd = end < 0 ? sorted.length - 1 : end;
    return sorted.slice(start, normalizedEnd + 1);
  }

  async zScan(
    key: string,
    cursor: number,
    _pattern?: string,
    count = 10,
  ): Promise<{ cursor: number; members: ZEntry[] }> {
    const sorted = this.sortedEntries(key);
    const members = sorted.slice(cursor, cursor + count);
    const nextCursor =
      cursor + members.length >= sorted.length ? 0 : cursor + members.length;
    return { cursor: nextCursor, members };
  }

  async zCard(key: string): Promise<number> {
    return this.sortedSets.get(key)?.size ?? 0;
  }

  async zRem(key: string, members: string[]): Promise<void> {
    const current = this.sortedSets.get(key);
    if (!current) {
      return;
    }
    for (const member of members) {
      current.delete(member);
    }
  }

  private sortedEntries(key: string): ZEntry[] {
    const current = this.sortedSets.get(key) ?? new Map<string, number>();
    return [...current.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
  }
}

describe("subscriberStats direct lookup", () => {
  let redis: InMemoryRedis;

  beforeEach(() => {
    redis = new InMemoryRedis();
  });

  it("returns indexed stats from the user-id hash", async () => {
    await redis.hSet(subscriberStatsByUserIdKey, {
      t2_user: "t2_user:TestUser:123:456",
    });

    await expect(
      getSubscriberStats(
        redis as unknown as Parameters<typeof getSubscriberStats>[0],
        "t2_user",
      ),
    ).resolves.toEqual({
      id: "t2_user",
      username: "TestUser",
      subscribers: 123,
      timestamp: 456,
    });
    expect(redis.zRangeCalls).toBe(0);
  });

  it("reads anonymous subscriber status without profile or legacy data", async () => {
    await redis.hSet(subscriberStatusByUserIdKey, { t2_tiny: "1" });
    expect(await redis.hGet(subscriberStatusByUserIdKey, "t2_tiny")).toBe("1");
    expect(
      await redis.hGet(subscriberStatsByUserIdKey, "t2_tiny"),
    ).toBeUndefined();
    expect(await redis.zCard(subscriberStatsKey)).toBe(0);
    await expect(
      isTrackedSubscriber(
        redis as unknown as Parameters<typeof isTrackedSubscriber>[0],
        "t2_tiny",
      ),
    ).resolves.toBe(true);
  });

  it("does not scan legacy subscriber_stats when the hash is missing", async () => {
    await redis.zAdd(subscriberStatsKey, {
      member: "t2_user:TestUser:123",
      score: 456,
    });

    await expect(
      getSubscriberStats(
        redis as unknown as Parameters<typeof getSubscriberStats>[0],
        "t2_user",
      ),
    ).resolves.toBeUndefined();
    expect(redis.zRangeCalls).toBe(0);
  });

  it("returns undefined for malformed indexed records", async () => {
    await redis.hSet(subscriberStatsByUserIdKey, {
      t2_user: "bad-record",
    });

    await expect(
      getSubscriberStats(
        redis as unknown as Parameters<typeof getSubscriberStats>[0],
        "t2_user",
      ),
    ).resolves.toBeUndefined();
    expect(redis.zRangeCalls).toBe(0);
  });

  it("completely purges by user id without writing a tombstone", async () => {
    await redis.hSet(subscriberStatsByUserIdKey, {
      t2_user: "t2_user:TestUser:124:1000",
    });
    await redis.hSet(subscriberStatusByUserIdKey, { t2_user: "1" });
    await redis.hSet(subscriberStatsUsernameToUserIdKey, {
      testuser: "t2_user",
    });
    await redis.hSet(subscriberStatsLegacyMembersByUserIdKey, {
      t2_user: JSON.stringify(["t2_user:TestUser:124"]),
    });
    await redis.zAdd(subscriberStatsKey, {
      member: "t2_user:TestUser:124",
      score: 1_000,
    });
    await redis.zAdd(subscriberStatsKey, {
      member: "t2_user:OldName:100",
      score: 900,
    });
    await redis.hSet(subscriberStatsErasedUserIdsKey, {
      t2_user: "2000",
    });
    await redis.hSet(recentSubscriberPostsByUsernameKey, {
      testuser: JSON.stringify(["t3_post"]),
    });
    await redis.hSet(subscriberGoalsKey, {
      t3_post_recent_subscriber: "TestUser",
    });

    await expect(
      untrackSubscriberById(
        redis as unknown as Parameters<typeof untrackSubscriberById>[0],
        "t2_user",
      ),
    ).resolves.toEqual({ status: "complete", userIds: ["t2_user"] });

    expect(
      await redis.hGet(subscriberStatsByUserIdKey, "t2_user"),
    ).toBeUndefined();
    expect(
      await redis.hGet(subscriberStatusByUserIdKey, "t2_user"),
    ).toBeUndefined();
    expect(
      await redis.hGet(subscriberStatsUsernameToUserIdKey, "testuser"),
    ).toBeUndefined();
    expect(
      await redis.hGet(subscriberStatsLegacyMembersByUserIdKey, "t2_user"),
    ).toBeUndefined();
    expect(
      await redis.hGet(subscriberStatsErasedUserIdsKey, "t2_user"),
    ).toBeUndefined();
    expect(await redis.zCard(subscriberStatsKey)).toBe(0);
    expect(
      await redis.hGet(recentSubscriberPostsByUsernameKey, "testuser"),
    ).toBeUndefined();
    expect(
      await redis.hGet(subscriberGoalsKey, "t3_post_recent_subscriber"),
    ).toBe("");
    expect(redis.zRangeCalls).toBe(0);
  });

  it("purges marker-only Tiny subscribers by user id", async () => {
    await redis.hSet(subscriberStatusByUserIdKey, { t2_tiny: "1" });

    await expect(
      untrackSubscriberById(
        redis as unknown as Parameters<typeof untrackSubscriberById>[0],
        "t2_tiny",
      ),
    ).resolves.toEqual({ status: "complete", userIds: ["t2_tiny"] });

    expect(
      await redis.hGet(subscriberStatusByUserIdKey, "t2_tiny"),
    ).toBeUndefined();
  });

  it("erases an old-format subscriber with only a legacy member entry", async () => {
    await redis.zAdd(
      subscriberStatsKey,
      { member: "t2_legacy:TestUser:100", score: 900 },
      { member: "t2_other:TestUser:101", score: 950 },
    );

    await expect(
      untrackSubscriberById(
        redis as unknown as Parameters<typeof untrackSubscriberById>[0],
        "t2_legacy",
      ),
    ).resolves.toEqual({ status: "complete", userIds: ["t2_legacy"] });

    expect(await redis.zRange(subscriberStatsKey, 0, -1)).toEqual([
      { member: "t2_other:TestUser:101", score: 950 },
    ]);
  });

  it("erases by username through the username index and returns partial when missing", async () => {
    await redis.hSet(subscriberStatsByUserIdKey, {
      t2_user: "t2_user:TestUser:124:1000",
    });
    await redis.hSet(subscriberStatsUsernameToUserIdKey, {
      testuser: "t2_user",
    });

    await expect(
      untrackSubscriberByUsername(
        redis as unknown as Parameters<typeof untrackSubscriberByUsername>[0],
        "TestUser",
      ),
    ).resolves.toEqual({ status: "complete", userIds: ["t2_user"] });
    await expect(
      untrackSubscriberByUsername(
        redis as unknown as Parameters<typeof untrackSubscriberByUsername>[0],
        "MissingUser",
      ),
    ).resolves.toEqual({ status: "partial", userIds: [] });
    expect(redis.zRangeCalls).toBe(0);
  });

  it.each(["username index", "current scan", "legacy scan"])(
    "invalidates tracking when recovering an ID from the %s",
    async (source) => {
      const generationKey = subscriberTrackingGenerationKey("t2_user");
      await redis.set(generationKey, "before-erasure");
      if (source === "username index") {
        await redis.hSet(subscriberStatsUsernameToUserIdKey, {
          testuser: "t2_user",
        });
      }
      if (source !== "legacy scan") {
        await redis.hSet(subscriberStatsByUserIdKey, {
          t2_user: "t2_user:TestUser:124:1000",
        });
      } else {
        await redis.zAdd(subscriberStatsKey, {
          member: "t2_user:TestUser:124",
          score: 1000,
        });
      }
      await expect(
        untrackSubscriberByUsername(
          redis as unknown as Parameters<typeof untrackSubscriberByUsername>[0],
          "tEsTuSeR",
        ),
      ).resolves.toEqual({ status: "complete", userIds: ["t2_user"] });
      expect(await redis.get(generationKey)).not.toBe("before-erasure");
      expect(
        await redis.hGet(subscriberStatsByUserIdKey, "t2_user"),
      ).toBeUndefined();
      expect(await redis.zCard(subscriberStatsKey)).toBe(0);
    },
  );

  it("clears a legacy tombstone during erasure", async () => {
    await redis.hSet(subscriberStatsErasedUserIdsKey, {
      t2_user: "2000",
    });

    await untrackSubscriberById(
      redis as unknown as Parameters<typeof untrackSubscriberById>[0],
      "t2_user",
      "TestUser",
    );

    expect(
      await redis.hGet(subscriberStatsErasedUserIdsKey, "t2_user"),
    ).toBeUndefined();
  });
});
