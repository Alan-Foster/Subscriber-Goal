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
  const hashes = new Map<string, Record<string, string>>(),
    buffers = new Map<string, Buffer>(),
    strings = new Map<string, string>(),
    expirations = new Map<string, number>();
  const redis = {
    bitfield: async (
      key: string,
      op: string,
      _encoding: string,
      offset: number,
      value?: number,
    ) => {
      const byte = Math.floor(offset / 8),
        mask = 1 << (7 - (offset % 8)),
        existing = buffers.get(key) ?? Buffer.alloc(0);
      if (op === "get") {
        return [
          existing.length > byte && (existing[byte]! & mask) !== 0 ? 1 : 0,
        ];
      }
      const next =
          existing.length > byte
            ? Buffer.from(existing)
            : Buffer.concat([
                existing,
                Buffer.alloc(byte + 1 - existing.length),
              ]),
        previous = (next[byte]! & mask) === 0 ? 0 : 1;
      if (value === 1) next[byte] = next[byte]! | mask;
      buffers.set(key, next);
      return [previous];
    },
    expire: async (key: string, seconds: number) => {
      expirations.set(key, seconds);
    },
    set: async (key: string, value: string, options?: { nx?: boolean }) => {
      if (options?.nx && strings.has(key)) return undefined;
      strings.set(key, value);
      return "OK";
    },
    get: async (key: string) => strings.get(key),
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
  return { redis, hashes, buffers, strings, expirations };
};

describe("statistics analytics", () => {
  const now = Date.UTC(2026, 10, 2, 12, 30),
    id = (suffix: number) =>
      `10000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
  it("deduplicates retries and same-post sessions without storing raw identities", async () => {
    const store = createRedis();
    const load = (eventId: string, postId = "t3_one") =>
      recordStatisticsLoad(store.redis, {
        eventId,
        postId,
        visitorIdentity: "private-user",
        appTrackedSubscribed: false,
        exposure: "join",
        nowMs: now,
      });
    await expect(load(id(1))).resolves.toBe(true);
    await expect(load(id(1))).resolves.toBe(false);
    await expect(load(id(2))).resolves.toBe(true);
    await expect(load(id(3), "t3_two")).resolves.toBe(true);
    const report = await getStatisticsReport(
      store.redis,
      "ExampleSub",
      24,
      now,
    );
    expect(report.metrics.traffic.impressions.value).toBe(3);
    expect(report.metrics.traffic.viewingSessions.value).toBe(2);
    expect(
      JSON.stringify([
        ...store.hashes.entries(),
        ...store.buffers.keys(),
        ...store.strings.entries(),
      ]),
    ).not.toContain("private-user");
    expect(
      [...store.expirations.entries()]
        .filter(([key]) => !key.includes(":dedupe:"))
        .every(([, ttl]) => ttl === 2_592_000),
    ).toBe(true);
    expect(
      [...store.expirations.entries()]
        .filter(([key]) => key.includes(":dedupe:"))
        .every(([, ttl]) => ttl === 172_800),
    ).toBe(true);
  });

  it("counts the same visitor and post once per UTC hour", async () => {
    const store = createRedis();
    await recordStatisticsLoad(store.redis, {
      eventId: id(4),
      postId: "t3_one",
      visitorIdentity: "repeat-visitor",
      appTrackedSubscribed: false,
      exposure: "join",
      nowMs: now - 3_600_000,
    });
    await recordStatisticsLoad(store.redis, {
      eventId: id(5),
      postId: "t3_one",
      visitorIdentity: "repeat-visitor",
      appTrackedSubscribed: false,
      exposure: "join",
      nowMs: now,
    });
    await recordStatisticsLoad(store.redis, {
      eventId: id(6),
      postId: "t3_one",
      visitorIdentity: "repeat-visitor",
      appTrackedSubscribed: false,
      exposure: "join",
      nowMs: now,
    });

    const report = await getStatisticsReport(
      store.redis,
      "ExampleSub",
      24,
      now,
    );
    expect(report.metrics.traffic.impressions.value).toBe(3);
    expect(report.metrics.traffic.viewingSessions.value).toBe(2);
    expect(report.metrics.membership.joinEligibleSessions.value).toBe(2);
  });

  it("deduplicates the same event across a UTC midnight boundary", async () => {
    const store = createRedis();
    const beforeMidnight = Date.UTC(2026, 10, 2, 23, 59, 59);
    const afterMidnight = Date.UTC(2026, 10, 3, 0, 0, 1);
    const options = {
      eventId: id(7),
      postId: "t3_one",
      visitorIdentity: "midnight-visitor",
      appTrackedSubscribed: false,
      exposure: "join" as const,
    };
    await expect(
      recordStatisticsLoad(store.redis, {
        ...options,
        nowMs: beforeMidnight,
      }),
    ).resolves.toBe(true);
    await expect(
      recordStatisticsLoad(store.redis, {
        ...options,
        nowMs: afterMidnight,
      }),
    ).resolves.toBe(false);
  });

  it("tracks returning visitors, action families, unique sessions, and nullable rates", async () => {
    const store = createRedis(),
      { redis } = store;
    await recordStatisticsLoad(redis, {
      eventId: id(10),
      postId: "t3_goal",
      visitorIdentity: "returner",
      appTrackedSubscribed: false,
      exposure: "join",
      nowMs: now - 2 * 3_600_000,
    });
    await recordStatisticsLoad(redis, {
      eventId: id(11),
      postId: "t3_goal",
      visitorIdentity: "returner",
      appTrackedSubscribed: false,
      exposure: "join",
      nowMs: now,
    });
    await recordStatisticsLoad(redis, {
      eventId: id(12),
      postId: "t3_goal",
      visitorIdentity: "new",
      appTrackedSubscribed: false,
      exposure: "join",
      nowMs: now,
    });
    await recordStatisticsJoinClick(redis, {
      eventId: id(20),
      postId: "t3_goal",
      visitorIdentity: "returner",
      nowMs: now,
    });
    await recordStatisticsJoinClick(redis, {
      eventId: id(21),
      postId: "t3_goal",
      visitorIdentity: "returner",
      nowMs: now,
    });
    await recordStatisticsConfirmedJoin(redis, {
      attemptId: id(20),
      postId: "t3_goal",
      visitorIdentity: "returner",
      secondaryCtaEligible: true,
      nowMs: now,
    });
    await recordStatisticsCtaClick(redis, {
      eventId: id(40),
      postId: "t3_goal",
      visitorIdentity: "returner",
      label: "Discord",
      kind: "secondary",
      nowMs: now,
    });
    await recordStatisticsLoad(redis, {
      eventId: id(50),
      postId: "t3_cta",
      visitorIdentity: "new",
      appTrackedSubscribed: false,
      exposure: "cta_only",
      nowMs: now,
    });
    await recordStatisticsCtaClick(redis, {
      eventId: id(51),
      postId: "t3_cta",
      visitorIdentity: "new",
      label: "Read",
      kind: "cta_only",
      nowMs: now,
    });
    const report = await getStatisticsReport(redis, "ExampleSub", 24, now);
    expect(report.schemaVersion).toBe(2);
    expect(report.metrics.visitors.returning.value).toBe(1);
    expect(report.metrics.joins.clicks.value).toBe(2);
    expect(report.metrics.joins.uniqueClickSessions.value).toBe(1);
    expect(report.metrics.joins.clickSuccessRate.value).toBe(50);
    expect(report.metrics.joins.ctr.value).toBe(33.33);
    expect(report.metrics.ctas.clicks.value).toBe(1);
    expect(report.metrics.ctaOnly.clicks.value).toBe(1);
    expect(report.metrics.ctas.ctr.value).toBe(100);
    expect(report.metrics.ctaOnly.ctr.value).toBe(100);
    expect(report.metrics.interactions.ctr.value).toBeLessThanOrEqual(100);
    expect(report.metrics.ctas.byLabel[0]).toMatchObject({
      label: "Discord",
      clicks: { value: 1 },
      uniqueSessions: { value: 1 },
    });
  });

  it("repairs eligible denominators with validated interaction writes", async () => {
    const store = createRedis();
    await recordStatisticsJoinClick(store.redis, {
      eventId: id(60),
      postId: "t3_join",
      visitorIdentity: "joiner",
      nowMs: now,
    });
    await recordStatisticsCtaClick(store.redis, {
      eventId: id(61),
      postId: "t3_secondary",
      visitorIdentity: "subscriber",
      label: "Discord",
      kind: "secondary",
      nowMs: now,
    });
    await recordStatisticsCtaClick(store.redis, {
      eventId: id(62),
      postId: "t3_cta",
      visitorIdentity: "reader",
      label: "Read",
      kind: "cta_only",
      nowMs: now,
    });

    const report = await getStatisticsReport(
      store.redis,
      "ExampleSub",
      24,
      now,
    );
    expect(report.metrics.joins.ctr.value).toBe(100);
    expect(report.metrics.ctas.ctr.value).toBe(100);
    expect(report.metrics.ctaOnly.ctr.value).toBe(100);
    expect(report.metrics.interactions.ctr.value).toBe(100);
  });

  it("sums per-label CTA sessions across UTC hours", async () => {
    const store = createRedis();
    for (const [suffix, nowMs] of [
      [70, now - 3_600_000],
      [71, now],
    ] as const) {
      await recordStatisticsCtaClick(store.redis, {
        eventId: id(suffix),
        postId: "t3_goal",
        visitorIdentity: "same-subscriber",
        label: "Discord",
        kind: "secondary",
        nowMs,
      });
    }
    const report = await getStatisticsReport(
      store.redis,
      "ExampleSub",
      24,
      now,
    );
    expect(report.metrics.ctas.uniqueClickSessions.value).toBe(2);
    expect(report.metrics.ctas.eligibleSessions.value).toBe(2);
    expect(report.metrics.ctas.byLabel[0]?.uniqueSessions.value).toBe(2);
  });

  it("reports saturated bitmap buckets as unavailable", async () => {
    const store = createRedis();
    const hour = Math.floor(now / 3_600_000) * 3_600_000;
    store.buffers.set(
      `statistics:v2:sessions:all:${hour}`,
      Buffer.alloc(2_048, 0xff),
    );
    store.strings.set("statistics:v2:coverage:sessions", String(hour));

    const report = await getStatisticsReport(
      store.redis,
      "ExampleSub",
      24,
      now,
    );
    expect(report.metrics.traffic.viewingSessions.value).toBeNull();
  });

  it("represents unavailable comparisons and zero denominators explicitly", () => {
    expect(compareStatisticsValues(4, 0)).toMatchObject({
      value: 4,
      comparisonStatus: "new",
    });
    expect(compareStatisticsValues(null, null)).toEqual({
      value: null,
      previousValue: null,
      absoluteChange: null,
      percentChange: null,
      comparisonStatus: "unavailable",
    });
  });
});
