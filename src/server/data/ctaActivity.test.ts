import { watchTestString } from "../utils/testHashWatch";
import { describe, expect, it, vi } from "vitest";
import type { RedisClient } from "../types";
import {
  anonymousCtaDailyLimit,
  ensureCommunityPostActivityBackfill,
  getCtaActivityMetric,
  getRecentCommunityPostIds,
  recordCommunityPostCreated,
  recordCtaClick,
} from "./ctaActivity";

class FakeRedis {
  watch(key: string) {
    return watchTestString(this, key);
  }

  values = new Map<string, string>();
  sorted = new Map<string, Map<string, number>>();
  expirations = new Map<string, Date>();
  setReply = "OK";

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async set(
    key: string,
    value: string,
    options?: { nx?: boolean; expiration?: Date },
  ): Promise<string> {
    if (options?.nx && this.values.has(key)) return this.setReply;
    this.values.set(key, value);
    if (options?.expiration) this.expirations.set(key, options.expiration);
    return this.setReply;
  }
  async del(...keys: string[]): Promise<void> {
    keys.forEach((key) => this.values.delete(key));
  }
  async incrBy(key: string, increment: number): Promise<number> {
    const next = Number(this.values.get(key) ?? 0) + increment;
    this.values.set(key, String(next));
    return next;
  }
  async mGet(keys: string[]): Promise<(string | null)[]> {
    return keys.map((key) => this.values.get(key) ?? null);
  }
  async zAdd(
    key: string,
    ...members: Array<{ member: string; score: number }>
  ): Promise<number> {
    const set = this.sorted.get(key) ?? new Map<string, number>();
    let added = 0;
    members.forEach(({ member, score }) => {
      if (!set.has(member)) added += 1;
      set.set(member, score);
    });
    this.sorted.set(key, set);
    return added;
  }
  async zRange(
    key: string,
    start: number,
    end: number,
    options: { reverse?: boolean },
  ) {
    return [...(this.sorted.get(key) ?? [])]
      .sort((a, b) => (options.reverse ? b[1] - a[1] : a[1] - b[1]))
      .slice(start, end + 1)
      .map(([member, score]) => ({ member, score }));
  }
  async zCard(key: string): Promise<number> {
    return this.sorted.get(key)?.size ?? 0;
  }
  async expire(key: string, seconds: number): Promise<void> {
    this.expirations.set(key, new Date(now + seconds * 1000));
  }
}

const asRedis = (redis: FakeRedis): RedisClient => redis as never;
const day = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 8, 7, 12);

describe("CTA activity storage", () => {
  it("reads no more than ten distinct recent post IDs by creation time across day buckets", async () => {
    const redis = new FakeRedis();
    const client = asRedis(redis);
    await recordCommunityPostCreated(client, "t3_first", now - 5000);
    await recordCommunityPostCreated(client, "t3_newest", now);
    for (let i = 0; i < 12; i++) {
      await recordCommunityPostCreated(
        client,
        "t3_old" + i,
        now - day - i * 1000,
      );
    }
    await recordCommunityPostCreated(client, "t3_newest", now - day + 5000);
    await recordCommunityPostCreated(client, "t3_first", now - 5000);
    await expect(getRecentCommunityPostIds(client, now)).resolves.toEqual([
      "t3_newest",
      "t3_first",
      ...Array.from({ length: 8 }, (_, i) => "t3_old" + i),
    ]);
  });

  it("deduplicates post-create retries and applies the minimum weekly value", async () => {
    const redis = new FakeRedis();
    await recordCommunityPostCreated(asRedis(redis), "t3_one", now);
    await recordCommunityPostCreated(asRedis(redis), "t3_one", now);

    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_goal", "create-post", {
        nowMs: now,
      }),
    ).resolves.toEqual({ kind: "posts", count: 1, period: "week" });

    const empty = new FakeRedis();
    await expect(
      getCtaActivityMetric(asRedis(empty), "t3_goal", "newest-post", {
        nowMs: now,
      }),
    ).resolves.toEqual({ kind: "posts", count: 1, period: "week" });
  });

  it("uses today's post count when the seven-day total reaches seven", async () => {
    const redis = new FakeRedis();
    for (let index = 0; index < 7; index += 1) {
      await recordCommunityPostCreated(
        asRedis(redis),
        `t3_${index}`,
        now - (index === 0 ? 0 : day),
      );
    }

    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_goal", "top-post-day", {
        nowMs: now,
      }),
    ).resolves.toEqual({ kind: "posts", count: 1, period: "today" });
  });

  it("sums eligible daily activations across seven days and isolates each CTA post", async () => {
    const redis = new FakeRedis();
    await recordCtaClick(asRedis(redis), "t3_a", "viewer-0", { nowMs: now });
    await recordCtaClick(asRedis(redis), "t3_a", "viewer-1", { nowMs: now });
    await recordCtaClick(asRedis(redis), "t3_a", "viewer-2", {
      nowMs: now - 6 * day,
    });
    await recordCtaClick(asRedis(redis), "t3_a", "viewer-3", {
      nowMs: now - 7 * day,
    });

    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_a", "discord", { nowMs: now }),
    ).resolves.toEqual({ kind: "clicks", count: 3, period: "week" });
    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_b", "wiki", { nowMs: now }),
    ).resolves.toEqual({ kind: "clicks", count: 0, period: "week" });
  });

  it("atomically claims one activation per post, viewer and UTC day", async () => {
    const redis = new FakeRedis();
    await Promise.all(
      Array.from({ length: 50 }, () =>
        recordCtaClick(asRedis(redis), "t3_a", "user:t2_one", { nowMs: now }),
      ),
    );
    await recordCtaClick(asRedis(redis), "t3_a", "user:t2_two", { nowMs: now });
    await recordCtaClick(asRedis(redis), "t3_b", "user:t2_one", { nowMs: now });
    await recordCtaClick(asRedis(redis), "t3_a", "user:t2_one", {
      nowMs: Date.UTC(2026, 8, 8),
    });
    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_a", "web-link", {
        nowMs: Date.UTC(2026, 8, 8),
      }),
    ).resolves.toMatchObject({ count: 3 });
    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_b", "wiki", { nowMs: now }),
    ).resolves.toMatchObject({ count: 1 });
    const claims = [...redis.values.keys()].filter((key) =>
      key.startsWith("cta_click_claim_v1:"),
    );
    expect(claims).toHaveLength(4);
    for (const key of claims) {
      expect(key).toMatch(/^cta_click_claim_v1:[a-f0-9]{64}$/);
      expect(redis.expirations.get(key)?.getTime()).toBeLessThanOrEqual(
        Date.UTC(2026, 8, 10),
      );
    }
  });

  it.each(["OK", ""])(
    "verifies claim ownership without relying on SET reply %j",
    async (reply) => {
      const redis = new FakeRedis();
      redis.setReply = reply;
      await Promise.all(
        Array.from({ length: 50 }, () =>
          recordCtaClick(asRedis(redis), "t3_a", "user:t2_one", { nowMs: now }),
        ),
      );
      await recordCtaClick(asRedis(redis), "t3_a", "user:t2_one", {
        nowMs: now,
      });
      await expect(
        getCtaActivityMetric(asRedis(redis), "t3_a", "wiki", { nowMs: now }),
      ).resolves.toMatchObject({ count: 1 });
    },
  );

  it("caps rotating anonymous IDs per post and UTC day with fixed expiring storage", async () => {
    const redis = new FakeRedis();
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        recordCtaClick(asRedis(redis), "t3_a", `visitor:${index}`, {
          nowMs: now,
        }),
      ),
    );
    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_a", "wiki", { nowMs: now }),
    ).resolves.toMatchObject({ count: anonymousCtaDailyLimit });
    const slots = [...redis.values.keys()].filter((key) =>
      key.startsWith("cta_click_anonymous_slot_v1:"),
    );
    expect(slots).toHaveLength(anonymousCtaDailyLimit);
    expect(
      [...redis.values.keys()].some((key) =>
        key.startsWith("cta_click_claim_v1:"),
      ),
    ).toBe(false);
    for (const key of slots) {
      expect(redis.expirations.get(key)).toEqual(
        new Date(Date.UTC(2026, 8, 9)),
      );
      expect(redis.values.get(key)).toMatch(/^[a-f0-9]{64}:[a-f0-9-]{36}$/);
    }
    const before = new Map(redis.expirations);
    await recordCtaClick(asRedis(redis), "t3_a", "visitor:another", {
      nowMs: now,
    });
    expect(redis.expirations).toEqual(before);
    await recordCtaClick(asRedis(redis), "t3_a", "user:t2_signedin", {
      nowMs: now,
    });
    await recordCtaClick(asRedis(redis), "t3_b", "visitor:another", {
      nowMs: now,
    });
    await recordCtaClick(asRedis(redis), "t3_a", "visitor:another", {
      nowMs: Date.UTC(2026, 8, 8),
    });
    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_a", "wiki", {
        nowMs: Date.UTC(2026, 8, 8),
      }),
    ).resolves.toMatchObject({ count: anonymousCtaDailyLimit + 2 });
    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_b", "wiki", { nowMs: now }),
    ).resolves.toMatchObject({ count: 1 });
  });

  it("deduplicates concurrent anonymous deliveries without consuming extra quota slots", async () => {
    const redis = new FakeRedis();
    await Promise.all(
      Array.from({ length: 50 }, () =>
        recordCtaClick(asRedis(redis), "t3_a", "visitor:same", { nowMs: now }),
      ),
    );
    expect(
      [...redis.values.keys()].filter((key) =>
        key.startsWith("cta_click_anonymous_slot_v1:"),
      ),
    ).toHaveLength(1);
    await recordCtaClick(asRedis(redis), "t3_a", "visitor:different", {
      nowMs: now,
    });
    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_a", "wiki", { nowMs: now }),
    ).resolves.toMatchObject({ count: 2 });
  });

  it("resets at UTC midnight and never extends a daily claim on replay", async () => {
    const redis = new FakeRedis();
    const midnight = Date.UTC(2026, 8, 8);
    await recordCtaClick(asRedis(redis), "t3_a", "viewer", {
      nowMs: midnight - 1,
    });
    const expirations = new Map(redis.expirations);
    await recordCtaClick(asRedis(redis), "t3_a", "viewer", {
      nowMs: midnight - 1,
    });
    expect(redis.expirations).toEqual(expirations);
    await recordCtaClick(asRedis(redis), "t3_a", "viewer", { nowMs: midnight });
    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_a", "discord", {
        nowMs: midnight,
      }),
    ).resolves.toMatchObject({ count: 2 });
    const claims = [...redis.values.keys()].filter((key) =>
      key.startsWith("cta_click_claim_v1:"),
    );
    expect(
      claims.map((key) => redis.expirations.get(key)?.getTime()).sort(),
    ).toEqual([midnight + day, midnight + 2 * day]);
  });

  it("keeps legacy totals alongside new deduped counts until their UTC days age out", async () => {
    const redis = new FakeRedis();
    const today = Date.UTC(2026, 8, 7);
    redis.values.set(`cta_click_activity:t3_a:${today}`, "5");
    redis.values.set(`cta_click_activity:t3_a:${today - 6 * day}`, "3");
    redis.values.set(`cta_click_activity:t3_a:${today - 7 * day}`, "99");
    await recordCtaClick(asRedis(redis), "t3_a", "viewer", { nowMs: now });
    await recordCtaClick(asRedis(redis), "t3_a", "viewer", { nowMs: now });
    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_a", "discord", { nowMs: now }),
    ).resolves.toMatchObject({ count: 9 });
    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_a", "discord", {
        nowMs: now + day,
      }),
    ).resolves.toMatchObject({ count: 6 });
    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_a", "discord", {
        nowMs: now + 7 * day,
      }),
    ).resolves.toMatchObject({ count: 0 });
  });

  it("does not double-count after an increment commits but its response is lost", async () => {
    const redis = new FakeRedis();
    const increment = redis.incrBy.bind(redis);
    vi.spyOn(redis, "incrBy").mockImplementation(async (key, amount) => {
      await increment(key, amount);
      throw new Error("response lost");
    });
    await expect(
      recordCtaClick(asRedis(redis), "t3_a", "viewer", { nowMs: now }),
    ).rejects.toThrow("response lost");
    await recordCtaClick(asRedis(redis), "t3_a", "viewer", { nowMs: now });
    expect(redis.incrBy).toHaveBeenCalledOnce();
    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_a", "wiki", { nowMs: now }),
    ).resolves.toMatchObject({ count: 1 });
  });

  it("skips missing identity and never increments when claiming fails", async () => {
    const redis = new FakeRedis();
    await recordCtaClick(asRedis(redis), "t3_a", "", { nowMs: now });
    expect(redis.values.size).toBe(0);
    vi.spyOn(redis, "set").mockRejectedValue(new Error("unavailable"));
    const increment = vi.spyOn(redis, "incrBy");
    await expect(
      recordCtaClick(asRedis(redis), "t3_a", "viewer", { nowMs: now }),
    ).rejects.toThrow("unavailable");
    expect(increment).not.toHaveBeenCalled();
  });

  it("skips a concurrent backfill even if SET NX returns a success-like response", async () => {
    const redis = asRedis(new FakeRedis());
    const reddit = {
      getNewPosts: vi.fn(() => ({ all: async () => [] })),
    };

    await Promise.all([
      ensureCommunityPostActivityBackfill(reddit as never, redis, "ExampleSub"),
      ensureCommunityPostActivityBackfill(reddit as never, redis, "ExampleSub"),
    ]);

    expect(reddit.getNewPosts).toHaveBeenCalledOnce();
  });

  it("backfills recent posts once and shares trigger deduplication", async () => {
    const redis = new FakeRedis();
    const all = vi.fn().mockResolvedValue([
      { id: "t3_recent", createdAt: new Date(now - day) },
      { id: "t3_old", createdAt: new Date(now - 8 * day) },
    ]);
    const reddit = {
      getNewPosts: vi.fn().mockReturnValue({ all }),
    };

    await recordCommunityPostCreated(asRedis(redis), "t3_recent", now - day);
    await ensureCommunityPostActivityBackfill(
      reddit as never,
      asRedis(redis),
      "ExampleSub",
      { nowMs: now },
    );
    await ensureCommunityPostActivityBackfill(
      reddit as never,
      asRedis(redis),
      "ExampleSub",
      { nowMs: now },
    );

    expect(reddit.getNewPosts).toHaveBeenCalledOnce();
    expect(reddit.getNewPosts).toHaveBeenCalledWith({
      subredditName: "ExampleSub",
      limit: 1_000,
      pageSize: 100,
    });
    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_goal", "share-picture", {
        nowMs: now,
      }),
    ).resolves.toEqual({ kind: "posts", count: 1, period: "week" });
  });
});
