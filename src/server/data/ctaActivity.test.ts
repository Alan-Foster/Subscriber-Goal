import { describe, expect, it, vi } from "vitest";
import type { RedisClient } from "../types";
import {
  ensureCommunityPostActivityBackfill,
  getCtaActivityMetric,
  recordCommunityPostCreated,
  recordCtaClick,
} from "./ctaActivity";

class FakeRedis {
  values = new Map<string, string>();
  sorted = new Map<string, Map<string, number>>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async set(
    key: string,
    value: string,
    options?: { nx?: boolean },
  ): Promise<string> {
    if (options?.nx && this.values.has(key)) return "";
    this.values.set(key, value);
    return "OK";
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
  async zCard(key: string): Promise<number> {
    return this.sorted.get(key)?.size ?? 0;
  }
  async expire(): Promise<void> {}
}

const asRedis = (redis: FakeRedis): RedisClient => redis as never;
const day = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 8, 7, 12);

describe("CTA activity storage", () => {
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

  it("sums seven days of repeat clicks and isolates each CTA post", async () => {
    const redis = new FakeRedis();
    await recordCtaClick(asRedis(redis), "t3_a", { nowMs: now });
    await recordCtaClick(asRedis(redis), "t3_a", { nowMs: now });
    await recordCtaClick(asRedis(redis), "t3_a", { nowMs: now - 6 * day });
    await recordCtaClick(asRedis(redis), "t3_a", { nowMs: now - 7 * day });

    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_a", "discord", { nowMs: now }),
    ).resolves.toEqual({ kind: "clicks", count: 3, period: "week" });
    await expect(
      getCtaActivityMetric(asRedis(redis), "t3_b", "wiki", { nowMs: now }),
    ).resolves.toEqual({ kind: "clicks", count: 0, period: "week" });
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
