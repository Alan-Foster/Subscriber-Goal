import { describe, expect, it } from "vitest";
import type { RedisClient } from "../types";
import {
  compareStatisticsValues,
  getStatisticsReport,
  recordStatisticsConfirmedJoin,
  recordStatisticsCtaClick,
  recordStatisticsJoinClick,
  recordStatisticsLoad,
} from "./statisticsAnalytics";

const createRedis = () => {
  const hashes = new Map<string, Record<string, string>>();
  const buffers = new Map<string, Buffer>();
  const expirations = new Map<string, number>();
  const redis = {
    bitfield: async (
      key: string,
      _operation: string,
      _encoding: string,
      offset: number,
      value: number,
    ) => {
      const byteIndex = Math.floor(offset / 8);
      const bitMask = 1 << (7 - (offset % 8));
      const existing = buffers.get(key) ?? Buffer.alloc(0);
      const next =
        existing.length > byteIndex
          ? Buffer.from(existing)
          : Buffer.concat([
              existing,
              Buffer.alloc(byteIndex + 1 - existing.length),
            ]);
      const previous = (next[byteIndex]! & bitMask) === 0 ? 0 : 1;
      if (value === 1) next[byteIndex] = next[byteIndex]! | bitMask;
      buffers.set(key, next);
      return [previous];
    },
    expire: async (key: string, seconds: number) => {
      expirations.set(key, seconds);
    },
    hIncrBy: async (key: string, field: string, amount: number) => {
      const hash = hashes.get(key) ?? {};
      const value = Number(hash[field] ?? 0) + amount;
      hash[field] = String(value);
      hashes.set(key, hash);
      return value;
    },
    hSet: async (key: string, values: Record<string, string>) => {
      const hash = hashes.get(key) ?? {};
      Object.assign(hash, values);
      hashes.set(key, hash);
      return Object.keys(values).length;
    },
    hGetAll: async (key: string) => ({ ...(hashes.get(key) ?? {}) }),
    getBuffer: async (key: string) => {
      const value = buffers.get(key);
      return value ? Buffer.from(value) : undefined;
    },
  } as unknown as RedisClient;
  return { redis, hashes, buffers, expirations };
};

describe("statistics analytics", () => {
  const now = Date.UTC(2026, 10, 2, 12, 30);

  it("deduplicates events and keeps only aggregate identities", async () => {
    const store = createRedis();
    const eventId = "11111111-1111-4111-8111-111111111111";
    await expect(
      recordStatisticsLoad(store.redis, {
        eventId,
        visitorIdentity: "t2_private-user",
        subscribed: true,
        nowMs: now,
      }),
    ).resolves.toBe(true);
    await expect(
      recordStatisticsLoad(store.redis, {
        eventId,
        visitorIdentity: "t2_private-user",
        subscribed: true,
        nowMs: now,
      }),
    ).resolves.toBe(false);

    const persistedText = JSON.stringify([
      ...store.hashes.entries(),
      ...store.buffers.keys(),
    ]);
    expect(persistedText).not.toContain(eventId);
    expect(persistedText).not.toContain("t2_private-user");
    expect(
      [...store.expirations.values()].every((ttl) => ttl === 2_592_000),
    ).toBe(true);
  });

  it("builds current, previous, cohort, funnel, and CTA-label metrics", async () => {
    const { redis } = createRedis();
    await recordStatisticsLoad(redis, {
      eventId: "10000000-0000-4000-8000-000000000001",
      visitorIdentity: "returning-user",
      subscribed: false,
      nowMs: now - 24 * 60 * 60 * 1000,
    });
    await recordStatisticsLoad(redis, {
      eventId: "10000000-0000-4000-8000-000000000002",
      visitorIdentity: "returning-user",
      subscribed: true,
      nowMs: now,
    });
    await recordStatisticsLoad(redis, {
      eventId: "10000000-0000-4000-8000-000000000003",
      visitorIdentity: "new-user",
      subscribed: false,
      nowMs: now,
    });
    await recordStatisticsJoinClick(
      redis,
      "20000000-0000-4000-8000-000000000001",
      now,
    );
    await recordStatisticsJoinClick(
      redis,
      "20000000-0000-4000-8000-000000000002",
      now,
    );
    await recordStatisticsConfirmedJoin(
      redis,
      "30000000-0000-4000-8000-000000000001",
      now,
    );
    await recordStatisticsCtaClick(redis, {
      eventId: "40000000-0000-4000-8000-000000000001",
      visitorIdentity: "returning-user",
      label: "Join the Discord, now",
      nowMs: now,
    });

    const report = await getStatisticsReport(redis, "ExampleSub", 24, now);
    expect(report.metrics.loads.total.value).toBe(2);
    expect(report.metrics.loads.subscribed.value).toBe(1);
    expect(report.metrics.visitors.unique.value).toBe(2);
    expect(report.metrics.visitors.returning.value).toBe(1);
    expect(report.metrics.visitors.new.value).toBe(1);
    expect(report.metrics.joins.conversionRate.value).toBe(50);
    expect(report.metrics.ctas.conversionRate.value).toBe(100);
    expect(report.metrics.ctas.byLabel).toMatchObject([
      {
        label: "Join the Discord, now",
        clicks: { value: 1 },
        uniqueUsers: { value: 1 },
      },
    ]);
  });

  it("represents a nonzero value over a zero baseline as new", () => {
    expect(compareStatisticsValues(4, 0)).toEqual({
      value: 4,
      previousValue: 0,
      absoluteChange: 4,
      percentChange: null,
      comparisonStatus: "new",
    });
  });
});
