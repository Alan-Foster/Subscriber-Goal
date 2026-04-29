import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSubscriberStats,
  initializeSubscriberStatsMigration,
  processSubscriberStatsMigrationBatch,
  setNewSubscriber,
  subscriberStatsByUserIdKey,
  subscriberStatsKey,
  subscriberStatsMigrationStateKey,
} from './subscriberStats';

type ZEntry = { member: string; score: number };

class InMemoryRedis {
  private hashes = new Map<string, Map<string, string>>();
  private sortedSets = new Map<string, Map<string, number>>();
  zRangeCalls = 0;

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

  async hSetNX(key: string, field: string, value: string): Promise<number> {
    const current = this.hashes.get(key) ?? new Map<string, string>();
    if (current.has(field)) {
      this.hashes.set(key, current);
      return 0;
    }
    current.set(field, value);
    this.hashes.set(key, current);
    return 1;
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    const map = this.hashes.get(key) ?? new Map<string, string>();
    return Object.fromEntries(map.entries());
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

  async zRange(key: string, start: number, end: number): Promise<ZEntry[]> {
    this.zRangeCalls += 1;
    const sorted = this.sortedEntries(key);
    const normalizedEnd = end < 0 ? sorted.length - 1 : end;
    return sorted.slice(start, normalizedEnd + 1);
  }

  async zScan(
    key: string,
    cursor: number,
    _pattern?: string,
    count = 10
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

  private sortedEntries(key: string): ZEntry[] {
    const current = this.sortedSets.get(key) ?? new Map<string, number>();
    return [...current.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
  }
}

describe('subscriberStats direct lookup', () => {
  let redis: InMemoryRedis;

  beforeEach(() => {
    redis = new InMemoryRedis();
    vi.restoreAllMocks();
  });

  it('returns indexed stats from the user-id hash', async () => {
    await redis.hSet(subscriberStatsByUserIdKey, {
      t2_user: 't2_user:TestUser:123:456',
    });

    await expect(
      getSubscriberStats(
        redis as unknown as Parameters<typeof getSubscriberStats>[0],
        't2_user'
      )
    ).resolves.toEqual({
      id: 't2_user',
      username: 'TestUser',
      subscribers: 123,
      timestamp: 456,
    });
    expect(redis.zRangeCalls).toBe(0);
  });

  it('does not scan legacy subscriber_stats when the hash is missing', async () => {
    await redis.zAdd(subscriberStatsKey, {
      member: 't2_user:TestUser:123',
      score: 456,
    });

    await expect(
      getSubscriberStats(
        redis as unknown as Parameters<typeof getSubscriberStats>[0],
        't2_user'
      )
    ).resolves.toBeUndefined();
    expect(redis.zRangeCalls).toBe(0);
  });

  it('returns undefined for malformed indexed records', async () => {
    await redis.hSet(subscriberStatsByUserIdKey, {
      t2_user: 'bad-record',
    });

    await expect(
      getSubscriberStats(
        redis as unknown as Parameters<typeof getSubscriberStats>[0],
        't2_user'
      )
    ).resolves.toBeUndefined();
    expect(redis.zRangeCalls).toBe(0);
  });

  it('uses the direct index as the uniqueness gate for new subscribers', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    await redis.hSet(subscriberStatsByUserIdKey, {
      t2_user: 't2_user:TestUser:123:900',
    });

    await expect(
      setNewSubscriber(
        redis as unknown as Parameters<typeof setNewSubscriber>[0],
        't3_post',
        124,
        { id: 't2_user', username: 'TestUser' },
        true
      )
    ).resolves.toBe(false);

    expect(await redis.zCard(subscriberStatsKey)).toBe(0);
  });

  it('writes the direct index and legacy sorted set for a new subscriber', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    await expect(
      setNewSubscriber(
        redis as unknown as Parameters<typeof setNewSubscriber>[0],
        't3_post',
        124,
        { id: 't2_user', username: 'TestUser' },
        true
      )
    ).resolves.toBe(true);

    expect(await redis.hGet(subscriberStatsByUserIdKey, 't2_user')).toBe(
      't2_user:TestUser:124:1000'
    );
    expect(await redis.zRange(subscriberStatsKey, 0, -1)).toEqual([
      { member: 't2_user:TestUser:124', score: 1_000 },
    ]);
  });
});

describe('subscriberStats migration', () => {
  let redis: InMemoryRedis;

  beforeEach(() => {
    redis = new InMemoryRedis();
    vi.restoreAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('initializes migration state once with a delayed next run', async () => {
    await initializeSubscriberStatsMigration(
      redis as unknown as Parameters<typeof initializeSubscriberStatsMigration>[0],
      {
        nowMs: 1_000,
        cooldownMinMs: 5,
        cooldownMaxMs: 5,
      }
    );

    expect(await redis.hGetAll(subscriberStatsMigrationStateKey)).toMatchObject({
      version: 'user_id_hash_v1',
      status: 'pending',
      cursor: '0',
      nextRunAt: '1005',
    });

    await initializeSubscriberStatsMigration(
      redis as unknown as Parameters<typeof initializeSubscriberStatsMigration>[0],
      {
        nowMs: 2_000,
        cooldownMinMs: 5,
        cooldownMaxMs: 5,
      }
    );
    expect(await redis.hGet(subscriberStatsMigrationStateKey, 'nextRunAt')).toBe(
      '1005'
    );
  });

  it('backfills one bounded zScan batch and resumes from stored cursor', async () => {
    await redis.zAdd(
      subscriberStatsKey,
      { member: 't2_a:Alice:10', score: 100 },
      { member: 'malformed', score: 200 },
      { member: 't2_b:Bob:20:250', score: 300 }
    );
    await redis.hSet(subscriberStatsByUserIdKey, {
      t2_b: 't2_b:Bob:99:999',
    });
    await redis.hSet(subscriberStatsMigrationStateKey, {
      version: 'user_id_hash_v1',
      status: 'pending',
      cursor: '0',
      nextRunAt: '0',
      scannedTotal: '0',
      migratedTotal: '0',
      skippedMalformedTotal: '0',
      skippedExistingTotal: '0',
      lastRunAt: '0',
    });

    await processSubscriberStatsMigrationBatch(
      redis as unknown as Parameters<typeof processSubscriberStatsMigrationBatch>[0],
      {
        nowMs: 1_000,
        batchSize: 2,
        cooldownMinMs: 5,
        cooldownMaxMs: 5,
      }
    );

    expect(await redis.hGet(subscriberStatsByUserIdKey, 't2_a')).toBe(
      't2_a:Alice:10:100'
    );
    expect(await redis.hGetAll(subscriberStatsMigrationStateKey)).toMatchObject({
      status: 'running',
      cursor: '2',
      nextRunAt: '1005',
      scannedTotal: '2',
      migratedTotal: '1',
      skippedMalformedTotal: '1',
      skippedExistingTotal: '0',
    });
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('[subscriberStatsMigration] batch complete:')
    );

    await processSubscriberStatsMigrationBatch(
      redis as unknown as Parameters<typeof processSubscriberStatsMigrationBatch>[0],
      {
        nowMs: 1_005,
        batchSize: 2,
        cooldownMinMs: 5,
        cooldownMaxMs: 5,
      }
    );

    expect(await redis.hGet(subscriberStatsByUserIdKey, 't2_b')).toBe(
      't2_b:Bob:99:999'
    );
    expect(await redis.hGetAll(subscriberStatsMigrationStateKey)).toMatchObject({
      status: 'complete',
      cursor: '0',
      scannedTotal: '3',
      migratedTotal: '1',
      skippedMalformedTotal: '1',
      skippedExistingTotal: '1',
    });
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('[subscriberStatsMigration] complete:')
    );
  });

  it('does not run before nextRunAt and does not scan after completion', async () => {
    await redis.zAdd(subscriberStatsKey, { member: 't2_a:Alice:10', score: 100 });
    await redis.hSet(subscriberStatsMigrationStateKey, {
      version: 'user_id_hash_v1',
      status: 'pending',
      cursor: '0',
      nextRunAt: '2000',
      scannedTotal: '0',
      migratedTotal: '0',
      skippedMalformedTotal: '0',
      skippedExistingTotal: '0',
      lastRunAt: '0',
    });

    await processSubscriberStatsMigrationBatch(
      redis as unknown as Parameters<typeof processSubscriberStatsMigrationBatch>[0],
      {
        nowMs: 1_000,
        batchSize: 2,
      }
    );

    expect(await redis.hLen(subscriberStatsByUserIdKey)).toBe(0);

    await redis.hSet(subscriberStatsMigrationStateKey, {
      status: 'complete',
      nextRunAt: '0',
    });
    await processSubscriberStatsMigrationBatch(
      redis as unknown as Parameters<typeof processSubscriberStatsMigrationBatch>[0],
      {
        nowMs: 3_000,
        batchSize: 2,
      }
    );

    expect(await redis.hLen(subscriberStatsByUserIdKey)).toBe(0);
  });
});
