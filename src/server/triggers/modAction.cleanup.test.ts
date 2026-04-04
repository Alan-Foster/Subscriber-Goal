import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@devvit/web/server', () => ({
  reddit: {},
  redis: {},
  context: {},
}));

import {
  cleanupCrosspostBookkeeping,
  crosspostBookkeepingCleanupLastRunKey,
} from './modAction';
import {
  crosspostListKey,
  processedRevisionsByTimeKey,
  processedRevisionsKey,
} from '../data/crosspostData';
import { postsKey } from '../data/updaterData';

type ZEntry = { member: string; score: number };

class InMemoryRedis {
  private hashes = new Map<string, Map<string, string>>();
  private sortedSets = new Map<string, Map<string, number>>();
  private kv = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.kv.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
  }

  async hSet(key: string, fields: Record<string, string>): Promise<void> {
    const current = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(fields)) {
      current.set(field, value);
    }
    this.hashes.set(key, current);
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    const map = this.hashes.get(key) ?? new Map<string, string>();
    return Object.fromEntries(map.entries());
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

  async zAdd(key: string, ...entries: ZEntry[]): Promise<void> {
    const current = this.sortedSets.get(key) ?? new Map<string, number>();
    for (const entry of entries) {
      current.set(entry.member, entry.score);
    }
    this.sortedSets.set(key, current);
  }

  async zRange(key: string, start: number, end: number): Promise<ZEntry[]> {
    const current = this.sortedSets.get(key) ?? new Map<string, number>();
    const sorted = [...current.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score);
    const normalizedEnd = end < 0 ? sorted.length - 1 : end;
    return sorted.slice(start, normalizedEnd + 1);
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
}

describe('cleanupCrosspostBookkeeping', () => {
  let redis: InMemoryRedis;

  beforeEach(() => {
    redis = new InMemoryRedis();
  });

  it('removes old processed revisions by age threshold', async () => {
    await redis.hSet(processedRevisionsKey, {
      rev_old: 't3_a',
      rev_new: 't3_b',
    });
    await redis.zAdd(
      processedRevisionsByTimeKey,
      { member: 'rev_old', score: 100 },
      { member: 'rev_new', score: 1900 }
    );

    await cleanupCrosspostBookkeeping(
      redis as unknown as Parameters<typeof cleanupCrosspostBookkeeping>[0],
      {
        nowMs: 2000,
        retentionMs: 500,
        maxEntries: 100,
        minIntervalMs: 0,
      }
    );

    const remaining = await redis.hGetAll(processedRevisionsKey);
    expect(remaining).toEqual({ rev_new: 't3_b' });
  });

  it('removes oldest excess processed revisions by max-count threshold', async () => {
    await redis.hSet(processedRevisionsKey, {
      rev_1: 't3_a',
      rev_2: 't3_b',
      rev_3: 't3_c',
    });
    await redis.zAdd(
      processedRevisionsByTimeKey,
      { member: 'rev_1', score: 1000 },
      { member: 'rev_2', score: 1001 },
      { member: 'rev_3', score: 1002 }
    );

    await cleanupCrosspostBookkeeping(
      redis as unknown as Parameters<typeof cleanupCrosspostBookkeeping>[0],
      {
        nowMs: 2000,
        retentionMs: 100000,
        maxEntries: 2,
        minIntervalMs: 0,
      }
    );

    const remaining = await redis.hGetAll(processedRevisionsKey);
    expect(remaining).toEqual({ rev_2: 't3_b', rev_3: 't3_c' });
  });

  it('respects interval gate and skips cleanup when called too soon', async () => {
    await redis.set(crosspostBookkeepingCleanupLastRunKey, '1900');
    await redis.hSet(processedRevisionsKey, { rev_old: 't3_a' });
    await redis.zAdd(processedRevisionsByTimeKey, {
      member: 'rev_old',
      score: 100,
    });

    await cleanupCrosspostBookkeeping(
      redis as unknown as Parameters<typeof cleanupCrosspostBookkeeping>[0],
      {
        nowMs: 2000,
        retentionMs: 100,
        maxEntries: 1,
        minIntervalMs: 500,
      }
    );

    expect(await redis.hGetAll(processedRevisionsKey)).toEqual({
      rev_old: 't3_a',
    });
  });

  it('removes stale mappings (invalid ids and untracked sources) and keeps valid mappings', async () => {
    await redis.zAdd(
      postsKey,
      { member: 't3_kept', score: 1 },
      { member: 't3_tracked', score: 2 }
    );
    await redis.hSet(crosspostListKey, {
      bad_source: 't3_crosspost1',
      t3_untracked: 't3_crosspost2',
      t3_tracked: 'not_a_thing_id',
      t3_comment_mapped: 't1_comment',
      t3_kept: 't3_crosspost3',
    });

    await cleanupCrosspostBookkeeping(
      redis as unknown as Parameters<typeof cleanupCrosspostBookkeeping>[0],
      {
        nowMs: 2000,
        retentionMs: 100000,
        maxEntries: 100,
        minIntervalMs: 0,
      }
    );

    expect(await redis.hGetAll(crosspostListKey)).toEqual({
      t3_kept: 't3_crosspost3',
    });
  });

  it('backfills hash-only processed revisions into the time index', async () => {
    await redis.hSet(processedRevisionsKey, {
      rev_hash_only: 't3_source',
    });

    await cleanupCrosspostBookkeeping(
      redis as unknown as Parameters<typeof cleanupCrosspostBookkeeping>[0],
      {
        nowMs: 5000,
        retentionMs: 100000,
        maxEntries: 100,
        minIntervalMs: 0,
      }
    );

    expect(await redis.hGetAll(processedRevisionsKey)).toEqual({
      rev_hash_only: 't3_source',
    });
    expect(await redis.zRange(processedRevisionsByTimeKey, 0, -1)).toEqual([
      { member: 'rev_hash_only', score: 5000 },
    ]);
  });

  it('removes time-index orphans that are missing from the hash', async () => {
    await redis.zAdd(processedRevisionsByTimeKey, {
      member: 'rev_orphan',
      score: 100,
    });

    await cleanupCrosspostBookkeeping(
      redis as unknown as Parameters<typeof cleanupCrosspostBookkeeping>[0],
      {
        nowMs: 2000,
        retentionMs: 100000,
        maxEntries: 100,
        minIntervalMs: 0,
      }
    );

    expect(await redis.zRange(processedRevisionsByTimeKey, 0, -1)).toEqual([]);
  });

  it('does not advance cleanup last-run marker when cleanup fails', async () => {
    class ThrowingRedis extends InMemoryRedis {
      async hGetAll(key: string): Promise<Record<string, string>> {
        if (key === crosspostListKey) {
          throw new Error('forced cleanup failure');
        }
        return await super.hGetAll(key);
      }
    }
    const throwingRedis = new ThrowingRedis();
    await throwingRedis.hSet(processedRevisionsKey, { rev_1: 't3_source' });
    await throwingRedis.zAdd(processedRevisionsByTimeKey, {
      member: 'rev_1',
      score: 100,
    });

    await expect(
      cleanupCrosspostBookkeeping(
        throwingRedis as unknown as Parameters<
          typeof cleanupCrosspostBookkeeping
        >[0],
        {
          nowMs: 2000,
          retentionMs: 100000,
          maxEntries: 100,
          minIntervalMs: 0,
        }
      )
    ).rejects.toThrow('forced cleanup failure');

    expect(
      await throwingRedis.get(crosspostBookkeepingCleanupLastRunKey)
    ).toBeUndefined();
  });
});
