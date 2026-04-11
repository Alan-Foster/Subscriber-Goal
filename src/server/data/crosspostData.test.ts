import { describe, expect, it } from 'vitest';
import {
  countPendingCrossposts,
  crosspostListKey,
  getCrosspostPendingByRevisionKey,
  getCrosspostPendingByTimeKey,
  getCorrespondingPost,
  listDuePendingCrossposts,
  isProcessedRevision,
  processedRevisionsByTimeKey,
  processedRevisionsKey,
  removePendingCrosspost,
  removeCorrespondingPost,
  removeProcessedRevisions,
  storeCorrespondingPost,
  storeProcessedRevision,
  upsertPendingCrosspost,
} from './crosspostData';

type ZEntry = { member: string; score: number };

class InMemoryRedis {
  private hashes = new Map<string, Map<string, string>>();
  private sortedSets = new Map<string, Map<string, number>>();

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

describe('crosspostData bookkeeping primitives', () => {
  it('storeProcessedRevision writes hash and time index', async () => {
    const redis = new InMemoryRedis();
    await storeProcessedRevision(
      redis as unknown as Parameters<typeof storeProcessedRevision>[0],
      'rev_1',
      't3_source',
      123
    );

    expect(
      await isProcessedRevision(
        redis as unknown as Parameters<typeof isProcessedRevision>[0],
        'rev_1'
      )
    ).toBe(true);
    const byTime = await redis.zRange(processedRevisionsByTimeKey, 0, -1);
    expect(byTime).toEqual([{ member: 'rev_1', score: 123 }]);
  });

  it('removeProcessedRevisions removes from hash and time index', async () => {
    const redis = new InMemoryRedis();
    await storeProcessedRevision(
      redis as unknown as Parameters<typeof storeProcessedRevision>[0],
      'rev_1',
      't3_source',
      123
    );
    await removeProcessedRevisions(
      redis as unknown as Parameters<typeof removeProcessedRevisions>[0],
      ['rev_1']
    );

    expect(await redis.hGet(processedRevisionsKey, 'rev_1')).toBeUndefined();
    expect(await redis.zRange(processedRevisionsByTimeKey, 0, -1)).toEqual([]);
  });

  it('removeCorrespondingPost deletes source-to-crosspost mapping', async () => {
    const redis = new InMemoryRedis();
    await storeCorrespondingPost(
      redis as unknown as Parameters<typeof storeCorrespondingPost>[0],
      't3_source',
      't3_crosspost'
    );
    expect(
      await getCorrespondingPost(
        redis as unknown as Parameters<typeof getCorrespondingPost>[0],
        't3_source'
      )
    ).toBe('t3_crosspost');

    await removeCorrespondingPost(
      redis as unknown as Parameters<typeof removeCorrespondingPost>[0],
      't3_source'
    );

    expect(
      await getCorrespondingPost(
        redis as unknown as Parameters<typeof getCorrespondingPost>[0],
        't3_source'
      )
    ).toBeUndefined();
    expect(await redis.hGetAll(crosspostListKey)).toEqual({});
  });

  it('upsert/list/remove pending crossposts via due-time index', async () => {
    const redis = new InMemoryRedis();
    const targetSubreddit = 'SubGoal';
    await upsertPendingCrosspost(
      redis as unknown as Parameters<typeof upsertPendingCrosspost>[0],
      targetSubreddit,
      {
        revisionId: 'rev_pending_1',
        postId: 't3_source' as const,
        goal: 50,
        firstSeenMs: 1_000,
        nextAttemptMs: 2_000,
        attemptCount: 0,
        lastError: null,
        status: 'queued_for_crosspost',
      }
    );

    const dueAt1500 = await listDuePendingCrossposts(
      redis as unknown as Parameters<typeof listDuePendingCrossposts>[0],
      targetSubreddit,
      { nowMs: 1_500, limit: 10 }
    );
    expect(dueAt1500).toEqual([]);

    const dueAt2500 = await listDuePendingCrossposts(
      redis as unknown as Parameters<typeof listDuePendingCrossposts>[0],
      targetSubreddit,
      { nowMs: 2_500, limit: 10 }
    );
    expect(dueAt2500).toHaveLength(1);
    expect(dueAt2500[0]?.revisionId).toBe('rev_pending_1');

    expect(
      await countPendingCrossposts(
        redis as unknown as Parameters<typeof countPendingCrossposts>[0],
        targetSubreddit
      )
    ).toBe(1);

    await removePendingCrosspost(
      redis as unknown as Parameters<typeof removePendingCrosspost>[0],
      targetSubreddit,
      'rev_pending_1'
    );

    expect(
      await countPendingCrossposts(
        redis as unknown as Parameters<typeof countPendingCrossposts>[0],
        targetSubreddit
      )
    ).toBe(0);
    expect(
      await redis.hGet(getCrosspostPendingByRevisionKey(targetSubreddit), 'rev_pending_1')
    ).toBeUndefined();
    expect(await redis.zRange(getCrosspostPendingByTimeKey(targetSubreddit), 0, -1)).toEqual([]);
  });
});
