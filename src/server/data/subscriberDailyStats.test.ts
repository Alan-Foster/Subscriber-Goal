import { describe, expect, it } from "vitest";
import {
  getUtcDayStartMs,
  observeDailySubscriberCount,
  subscriberDailyStatsKey,
  subscriberDailyStatsVersion,
} from "./subscriberDailyStats";

class InMemoryRedis {
  private hashes = new Map<string, Map<string, string>>();

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key)?.entries() ?? []);
  }

  async hSet(key: string, fields: Record<string, string>): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    let added = 0;
    for (const [field, value] of Object.entries(fields)) {
      if (!hash.has(field)) added += 1;
      hash.set(field, value);
    }
    this.hashes.set(key, hash);
    return added;
  }

  async hSetNX(key: string, field: string, value: string): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    if (hash.has(field)) return 0;
    hash.set(field, value);
    this.hashes.set(key, hash);
    return 1;
  }

  async hDel(key: string, fields: string[]): Promise<void> {
    const hash = this.hashes.get(key);
    fields.forEach((field) => hash?.delete(field));
  }
}

const asRedis = (redis: InMemoryRedis) =>
  redis as unknown as Parameters<typeof observeDailySubscriberCount>[0];

describe("subscriberDailyStats", () => {
  it("uses the first observation as the UTC-day baseline", async () => {
    const redis = new InMemoryRedis();
    const nowMs = Date.UTC(2026, 7, 31, 12);

    expect(getUtcDayStartMs(nowMs)).toBe(Date.UTC(2026, 7, 31));
    await expect(
      observeDailySubscriberCount(asRedis(redis), 1_000, { nowMs }),
    ).resolves.toMatchObject({
      baselineSubscribers: 1_000,
      latestSubscribers: 1_000,
      newSubscribersToday: 0,
    });
    await expect(
      observeDailySubscriberCount(asRedis(redis), 1_025, { nowMs: nowMs + 1 }),
    ).resolves.toMatchObject({
      baselineSubscribers: 1_000,
      latestSubscribers: 1_025,
      newSubscribersToday: 25,
    });
    await expect(redis.hGetAll(subscriberDailyStatsKey)).resolves.toMatchObject(
      {
        version: subscriberDailyStatsVersion,
        utcDayStartMs: String(Date.UTC(2026, 7, 31)),
        baselineSubscribers: "1000",
        latestSubscribers: "1025",
        observedAtMs: String(nowMs + 1),
      },
    );
  });

  it("establishes a new baseline at exactly UTC midnight", async () => {
    const redis = new InMemoryRedis();
    const beforeMidnight = Date.UTC(2026, 7, 31, 23, 59, 59, 999);
    const midnight = Date.UTC(2026, 8, 1);

    await observeDailySubscriberCount(asRedis(redis), 500, {
      nowMs: beforeMidnight,
    });
    await expect(
      observeDailySubscriberCount(asRedis(redis), 507, { nowMs: midnight }),
    ).resolves.toMatchObject({
      utcDayStartMs: midnight,
      baselineSubscribers: 507,
      newSubscribersToday: 0,
    });
  });

  it("clamps losses and supports the subscribe response's optimistic count", async () => {
    const redis = new InMemoryRedis();
    const nowMs = Date.UTC(2026, 7, 31, 12);
    await observeDailySubscriberCount(asRedis(redis), 100, { nowMs });

    await expect(
      observeDailySubscriberCount(asRedis(redis), 98, { nowMs: nowMs + 1 }),
    ).resolves.toMatchObject({ newSubscribersToday: 0 });
    await expect(
      observeDailySubscriberCount(asRedis(redis), 104, {
        nowMs: nowMs + 2,
        displayedSubscribers: 105,
      }),
    ).resolves.toMatchObject({
      latestSubscribers: 104,
      newSubscribersToday: 5,
    });
  });

  it("recovers a malformed baseline", async () => {
    const redis = new InMemoryRedis();
    const nowMs = Date.UTC(2026, 7, 31, 12);
    await redis.hSet(subscriberDailyStatsKey, {
      [`baseline:${getUtcDayStartMs(nowMs)}`]: "not-a-number",
    });

    await expect(
      observeDailySubscriberCount(asRedis(redis), 700, { nowMs }),
    ).resolves.toMatchObject({
      baselineSubscribers: 700,
      newSubscribersToday: 0,
    });
  });

  it("uses one recovery baseline across concurrent malformed-state repairs", async () => {
    const redis = new InMemoryRedis();
    const nowMs = Date.UTC(2026, 7, 31, 12);
    await redis.hSet(subscriberDailyStatsKey, {
      [`baseline:${getUtcDayStartMs(nowMs)}`]: "not-a-number",
    });

    const observations = await Promise.all([
      observeDailySubscriberCount(asRedis(redis), 700, { nowMs }),
      observeDailySubscriberCount(asRedis(redis), 701, { nowMs }),
    ]);

    expect(
      new Set(observations.map((value) => value.baselineSubscribers)).size,
    ).toBe(1);
  });

  it("keeps one baseline across concurrent observations", async () => {
    const redis = new InMemoryRedis();
    const nowMs = Date.UTC(2026, 7, 31, 12);
    const observations = await Promise.all([
      observeDailySubscriberCount(asRedis(redis), 800, { nowMs }),
      observeDailySubscriberCount(asRedis(redis), 801, { nowMs }),
    ]);

    expect(
      new Set(observations.map((value) => value.baselineSubscribers)).size,
    ).toBe(1);
  });
});
