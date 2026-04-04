import { beforeEach, describe, expect, it, vi } from 'vitest';
import { crosspostWikiPages } from '../data/crosspostData';
import type { AppSettings } from '../../shared/types/api';

const mockContext: { subredditName?: string } = {};
const mockReddit = {
  getCurrentSubreddit: vi.fn(),
  getPostById: vi.fn(),
  getSubredditInfoById: vi.fn(),
  getNewPosts: vi.fn(),
  crosspost: vi.fn(),
};

type ZEntry = { member: string; score: number };
type SetOptions = {
  nx?: boolean;
  expiration?: Date;
};

class InMemoryRedis {
  private hashes = new Map<string, Map<string, string>>();
  private sortedSets = new Map<string, Map<string, number>>();
  private kv = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.kv.get(key);
  }

  async set(key: string, value: string, options?: SetOptions): Promise<string> {
    if (options?.nx && this.kv.has(key)) {
      return '';
    }
    this.kv.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.kv.delete(key);
    }
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

let redisMock: InMemoryRedis;
let redisGlobalMock: InMemoryRedis;
const safeGetWikiPageRevisionsMock = vi.fn();
const loggedEvents: Array<Record<string, unknown>> = [];

vi.mock('@devvit/web/server', () => ({
  reddit: mockReddit,
  redis: {
    get: (...args: [string]) => redisMock.get(...args),
    set: (...args: [string, string, SetOptions?]) => redisMock.set(...args),
    del: (...args: string[]) => redisMock.del(...args),
    hSet: (...args: [string, Record<string, string>]) => redisMock.hSet(...args),
    hGet: (...args: [string, string]) => redisMock.hGet(...args),
    hGetAll: (...args: [string]) => redisMock.hGetAll(...args),
    hDel: (...args: [string, string[]]) => redisMock.hDel(...args),
    zAdd: (...args: [string, ...ZEntry[]]) => redisMock.zAdd(...args),
    zRange: (...args: [string, number, number]) => redisMock.zRange(...args),
    zRem: (...args: [string, string[]]) => redisMock.zRem(...args),
    global: {
      get: (...args: [string]) => redisGlobalMock.get(...args),
      set: (...args: [string, string, SetOptions?]) =>
        redisGlobalMock.set(...args),
      del: (...args: string[]) => redisGlobalMock.del(...args),
      zAdd: (...args: [string, ...ZEntry[]]) => redisGlobalMock.zAdd(...args),
      zRange: (...args: [string, number, number]) => redisGlobalMock.zRange(...args),
      zRem: (...args: [string, string[]]) => redisGlobalMock.zRem(...args),
    },
  },
  context: mockContext,
}));

vi.mock('../utils/crosspostLogs', () => ({
  toErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  logCrosspostEvent: (payload: Record<string, unknown>) => {
    loggedEvents.push(payload);
  },
}));

vi.mock('../utils/redditUtils', () => ({
  safeGetWikiPageRevisions: (...args: unknown[]) =>
    safeGetWikiPageRevisionsMock(...args),
}));

import { onModAction, processCrosspostDispatchQueue } from './modAction';

const baseSettings: AppSettings = {
  promoSubreddit: 'SubGoal',
  crosspostAuthoritySubreddit: 'SubGoal',
  crosspostMaxSourcePostAgeMinutes: 10,
  crosspostIngestionEnabled: true,
  crosspostMaxRevisionAgeMinutes: 10,
  maxCrosspostsPerRun: 5,
  maxCrosspostsPerHour: 30,
};

describe('processCrosspostDispatchQueue ingestion guards', () => {
  beforeEach(() => {
    redisMock = new InMemoryRedis();
    redisGlobalMock = new InMemoryRedis();
    mockContext.subredditName = undefined;
    (
      mockContext as {
        settings?: { getAll<T>(): Promise<Partial<T>> };
      }
    ).settings = undefined;
    mockReddit.getCurrentSubreddit.mockReset();
    mockReddit.getPostById.mockReset();
    mockReddit.getSubredditInfoById.mockReset();
    mockReddit.getNewPosts.mockReset();
    mockReddit.crosspost.mockReset();
    mockReddit.getNewPosts.mockReturnValue({
      get: vi.fn().mockResolvedValue([]),
    });
    safeGetWikiPageRevisionsMock.mockReset();
    loggedEvents.length = 0;
  });

  it('skips ingestion when running outside authority subreddit', async () => {
    mockContext.subredditName = 'CorporateGifts';

    const summary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(summary).toEqual({
      status: 'success',
      revisionsFetched: 0,
      newPostsSeen: 0,
      crosspostsCreated: 0,
      crosspostsSkipped: 0,
      crosspostsFailed: 0,
      actionsMirrored: 0,
      actionsFailed: 0,
      crosspostsCreatedThisRun: 0,
      crosspostsBlockedByRunCap: 0,
      crosspostsBlockedByHourlyCap: 0,
      crosspostPersistencePartial: 0,
      crosspostPersistenceFailedAfterCreate: 0,
      crosspostsSkippedBySourceCooldown: 0,
      crosspostsSkippedByInFlight: 0,
      crosspostsSkippedByExistingDetection: 0,
    });
    expect(safeGetWikiPageRevisionsMock).not.toHaveBeenCalled();
    expect(
      loggedEvents.some(
        (event) =>
          event.event === 'crosspost_retry_skipped' &&
          event.reason === 'non_authority'
      )
    ).toBe(true);
  });

  it('skips ingestion when lock is held by another worker', async () => {
    mockContext.subredditName = 'SubGoal';
    await redisGlobalMock.set('crosspostIngestionLock:subgoal', 'held-by-other');

    const summary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(summary).toEqual({
      status: 'success',
      revisionsFetched: 0,
      newPostsSeen: 0,
      crosspostsCreated: 0,
      crosspostsSkipped: 0,
      crosspostsFailed: 0,
      actionsMirrored: 0,
      actionsFailed: 0,
      crosspostsCreatedThisRun: 0,
      crosspostsBlockedByRunCap: 0,
      crosspostsBlockedByHourlyCap: 0,
      crosspostPersistencePartial: 0,
      crosspostPersistenceFailedAfterCreate: 0,
      crosspostsSkippedBySourceCooldown: 0,
      crosspostsSkippedByInFlight: 0,
      crosspostsSkippedByExistingDetection: 0,
    });
    expect(safeGetWikiPageRevisionsMock).not.toHaveBeenCalled();
    expect(
      loggedEvents.some(
        (event) =>
          event.event === 'crosspost_retry_skipped' &&
          event.reason === 'lock_held'
      )
    ).toBe(true);
  });

  it('terminally skips stale source posts older than freshness window', async () => {
    mockContext.subredditName = 'SubGoal';
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (page === crosspostWikiPages.newPost) {
          return {
            ok: true,
            revisions: [
              {
                id: 'rev_old',
                reason: 'Post t3_abc123 with goal 100',
                dateMs: Date.now(),
              },
            ],
            durationMs: 1,
          };
        }
        return {
          ok: true,
          revisions: [],
          durationMs: 1,
        };
      }
    );
    mockReddit.getPostById.mockResolvedValue({
      id: 't3_abc123',
      subredditId: 't5_source',
      subredditName: 'CorporateGifts',
      createdAt: new Date(Date.now() - 11 * 60 * 1000),
      nsfw: false,
    });

    const summary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(summary.crosspostsCreated).toBe(0);
    expect(summary.crosspostsSkipped).toBe(1);
    expect(summary.crosspostsFailed).toBe(0);
    expect(mockReddit.crosspost).not.toHaveBeenCalled();
    expect(mockReddit.getSubredditInfoById).not.toHaveBeenCalled();
    expect(await redisMock.hGet('processedRevisions', 'rev_old')).toBe(
      't3_abc123'
    );
  });

  it('treats seconds timestamps as valid and eligible for freshness checks', async () => {
    mockContext.subredditName = 'SubGoal';
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (page === crosspostWikiPages.newPost) {
          return {
            ok: true,
            revisions: [
              {
                id: 'rev_secs',
                reason: 'Post t3_secs with goal 100',
                dateMs: Date.now(),
              },
            ],
            durationMs: 1,
          };
        }
        return { ok: true, revisions: [], durationMs: 1 };
      }
    );
    const secondsAgoFiveMinutes = Math.floor((Date.now() - 5 * 60 * 1000) / 1000);
    mockReddit.getPostById.mockResolvedValue({
      id: 't3_secs',
      subredditId: 't5_source',
      subredditName: 'CorporateGifts',
      createdAt: secondsAgoFiveMinutes,
      nsfw: false,
    });
    mockReddit.getSubredditInfoById.mockResolvedValue({ isNsfw: false });
    mockReddit.crosspost.mockResolvedValue({ id: 't3_crossed' });

    const summary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(summary.crosspostsCreated).toBe(1);
    expect(summary.crosspostsSkipped).toBe(0);
  });

  it('terminally skips when source post age is unknown/unparseable', async () => {
    mockContext.subredditName = 'SubGoal';
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (page === crosspostWikiPages.newPost) {
          return {
            ok: true,
            revisions: [
              {
                id: 'rev_unknown',
                reason: 'Post t3_unknown with goal 100',
                dateMs: Date.now(),
              },
            ],
            durationMs: 1,
          };
        }
        return { ok: true, revisions: [], durationMs: 1 };
      }
    );
    mockReddit.getPostById.mockResolvedValue({
      id: 't3_unknown',
      subredditId: 't5_source',
      subredditName: 'CorporateGifts',
      createdAt: 'not-a-date',
      nsfw: false,
    });

    const summary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(summary.crosspostsCreated).toBe(0);
    expect(summary.crosspostsSkipped).toBe(1);
    expect(summary.crosspostsFailed).toBe(0);
    expect(mockReddit.crosspost).not.toHaveBeenCalled();
    expect(
      loggedEvents.some(
        (event) =>
          event.event === 'crosspost_attempt_skipped' &&
          event.reason === 'source_post_age_unknown'
      )
    ).toBe(true);
    expect(await redisMock.hGet('processedRevisions', 'rev_unknown')).toBe(
      't3_unknown'
    );
  });

  it('onModAction wikirevise follows authority subreddit, not promo subreddit', async () => {
    mockContext.subredditName = 'AuthorityHub';
    (
      mockContext as {
        settings?: { getAll<T>(): Promise<Partial<T>> };
      }
    ).settings = {
      getAll: async () => ({
        promoSubreddit: 'SubGoal',
        crosspostAuthoritySubreddit: 'AuthorityHub',
      }),
    };
    safeGetWikiPageRevisionsMock.mockResolvedValue({
      ok: true,
      revisions: [],
      durationMs: 1,
    });

    await onModAction({ action: 'wikirevise' });

    expect(safeGetWikiPageRevisionsMock).toHaveBeenCalled();
  });

  it('skips when ingestion is disabled', async () => {
    mockContext.subredditName = 'SubGoal';

    const summary = await processCrosspostDispatchQueue(
      {
        ...baseSettings,
        crosspostIngestionEnabled: false,
      },
      'scheduler_posts_updater'
    );

    expect(summary.crosspostsCreated).toBe(0);
    expect(summary.crosspostsSkipped).toBe(0);
    expect(safeGetWikiPageRevisionsMock).not.toHaveBeenCalled();
    expect(
      loggedEvents.some(
        (event) =>
          event.event === 'crosspost_retry_skipped' &&
          event.reason === 'ingestion_disabled'
      )
    ).toBe(true);
  });

  it('skips and processes when revision age is unknown', async () => {
    mockContext.subredditName = 'SubGoal';
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (page === crosspostWikiPages.newPost) {
          return {
            ok: true,
            revisions: [{ id: 'rev_unknown_age', reason: 'Post t3_u1 with goal 10' }],
            durationMs: 1,
          };
        }
        return { ok: true, revisions: [], durationMs: 1 };
      }
    );

    const summary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(summary.crosspostsCreated).toBe(0);
    expect(summary.crosspostsSkipped).toBe(1);
    expect(await redisMock.hGet('processedRevisions', 'rev_unknown_age')).toBe(
      't3_u1'
    );
    expect(
      loggedEvents.some(
        (event) =>
          event.event === 'crosspost_attempt_skipped' &&
          event.reason === 'revision_age_unknown'
      )
    ).toBe(true);
  });

  it('enforces per-run cap and marks overflow revisions processed', async () => {
    mockContext.subredditName = 'SubGoal';
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (page === crosspostWikiPages.newPost) {
          return {
            ok: true,
            revisions: [
              { id: 'rev_run_1', reason: 'Post t3_run1 with goal 10', dateMs: Date.now() },
              { id: 'rev_run_2', reason: 'Post t3_run2 with goal 10', dateMs: Date.now() },
              { id: 'rev_run_3', reason: 'Post t3_run3 with goal 10', dateMs: Date.now() },
            ],
            durationMs: 1,
          };
        }
        return { ok: true, revisions: [], durationMs: 1 };
      }
    );
    mockReddit.getPostById.mockImplementation(async (postId: string) => ({
      id: postId,
      subredditId: 't5_source',
      subredditName: 'CorporateGifts',
      createdAt: new Date(Date.now() - 60_000),
      nsfw: false,
    }));
    mockReddit.getSubredditInfoById.mockResolvedValue({ isNsfw: false });
    mockReddit.crosspost.mockImplementation(async ({ postId }: { postId: string }) => ({
      id: `t3_cross_${postId}`,
    }));

    const summary = await processCrosspostDispatchQueue(
      {
        ...baseSettings,
        maxCrosspostsPerRun: 2,
      },
      'scheduler_posts_updater'
    );

    expect(summary.crosspostsCreated).toBe(2);
    expect(summary.crosspostsBlockedByRunCap).toBe(1);
    expect(await redisMock.hGet('processedRevisions', 'rev_run_3')).toBe('t3_run3');
    expect(
      loggedEvents.some(
        (event) =>
          event.event === 'crosspost_attempt_skipped' &&
          event.reason === 'crosspost_cap_per_run_reached'
      )
    ).toBe(true);
  });

  it('enforces hourly cap using global history', async () => {
    mockContext.subredditName = 'SubGoal';
    await redisGlobalMock.zAdd(
      'crosspostHourlyCreationHistory:subgoal',
      { member: 'old_1', score: Date.now() - 5000 },
      { member: 'old_2', score: Date.now() - 4000 }
    );
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (page === crosspostWikiPages.newPost) {
          return {
            ok: true,
            revisions: [
              { id: 'rev_hourly', reason: 'Post t3_hourly with goal 10', dateMs: Date.now() },
            ],
            durationMs: 1,
          };
        }
        return { ok: true, revisions: [], durationMs: 1 };
      }
    );

    const summary = await processCrosspostDispatchQueue(
      {
        ...baseSettings,
        maxCrosspostsPerHour: 2,
      },
      'scheduler_posts_updater'
    );

    expect(summary.crosspostsCreated).toBe(0);
    expect(summary.crosspostsBlockedByHourlyCap).toBe(1);
    expect(await redisMock.hGet('processedRevisions', 'rev_hourly')).toBe(
      't3_hourly'
    );
    expect(
      loggedEvents.some(
        (event) =>
          event.event === 'crosspost_attempt_skipped' &&
          event.reason === 'crosspost_cap_hourly_reached'
      )
    ).toBe(true);
  });

  it('skips and processes when source post is under create cooldown', async () => {
    mockContext.subredditName = 'SubGoal';
    await redisGlobalMock.set('crosspostSourceCreateCooldown:t3_cool', '1');
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (page === crosspostWikiPages.newPost) {
          return {
            ok: true,
            revisions: [{ id: 'rev_cool', reason: 'Post t3_cool with goal 10', dateMs: Date.now() }],
            durationMs: 1,
          };
        }
        return { ok: true, revisions: [], durationMs: 1 };
      }
    );
    mockReddit.getPostById.mockResolvedValue({
      id: 't3_cool',
      subredditId: 't5_source',
      subredditName: 'CorporateGifts',
      createdAt: new Date(Date.now() - 60_000),
      nsfw: false,
    });

    const summary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(summary.crosspostsCreated).toBe(0);
    expect(summary.crosspostsSkippedBySourceCooldown).toBe(1);
    expect(mockReddit.crosspost).not.toHaveBeenCalled();
    expect(await redisMock.hGet('processedRevisions', 'rev_cool')).toBe('t3_cool');
    expect(
      loggedEvents.some(
        (event) =>
          event.event === 'crosspost_attempt_skipped' &&
          event.reason === 'source_post_recently_crossposted'
      )
    ).toBe(true);
  });

  it('records partial persistence when mapping write fails after create', async () => {
    mockContext.subredditName = 'SubGoal';
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (page === crosspostWikiPages.newPost) {
          return {
            ok: true,
            revisions: [{ id: 'rev_partial', reason: 'Post t3_partial with goal 10', dateMs: Date.now() }],
            durationMs: 1,
          };
        }
        return { ok: true, revisions: [], durationMs: 1 };
      }
    );
    mockReddit.getPostById.mockResolvedValue({
      id: 't3_partial',
      subredditId: 't5_source',
      subredditName: 'CorporateGifts',
      createdAt: new Date(Date.now() - 60_000),
      nsfw: false,
    });
    mockReddit.getSubredditInfoById.mockResolvedValue({ isNsfw: false });
    mockReddit.crosspost.mockResolvedValue({ id: 't3_cross_partial' });

    const originalHSet = redisMock.hSet.bind(redisMock);
    vi.spyOn(redisMock, 'hSet').mockImplementation(async (key, fields) => {
      if (key === 'crosspostList') {
        throw new Error('failed mapping write');
      }
      return originalHSet(key, fields);
    });

    const summary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(summary.crosspostsCreated).toBe(1);
    expect(summary.crosspostPersistencePartial).toBe(1);
    expect(summary.crosspostPersistenceFailedAfterCreate).toBe(0);
    expect(await redisMock.hGet('processedRevisions', 'rev_partial')).toBe(
      't3_partial'
    );
    expect(
      loggedEvents.some((event) => event.event === 'crosspost_persistence_partial')
    ).toBe(true);

    await redisMock.hDel('processedRevisions', ['rev_partial']);
    const secondSummary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(secondSummary.crosspostsCreated).toBe(0);
    expect(mockReddit.crosspost).toHaveBeenCalledTimes(1);
  });

  it('marks terminal revision fallback when all persistence fails after create', async () => {
    mockContext.subredditName = 'SubGoal';
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (page === crosspostWikiPages.newPost) {
          return {
            ok: true,
            revisions: [{ id: 'rev_total_fail', reason: 'Post t3_total with goal 10', dateMs: Date.now() }],
            durationMs: 1,
          };
        }
        return { ok: true, revisions: [], durationMs: 1 };
      }
    );
    mockReddit.getPostById.mockResolvedValue({
      id: 't3_total',
      subredditId: 't5_source',
      subredditName: 'CorporateGifts',
      createdAt: new Date(Date.now() - 60_000),
      nsfw: false,
    });
    mockReddit.getSubredditInfoById.mockResolvedValue({ isNsfw: false });
    mockReddit.crosspost.mockResolvedValue({ id: 't3_cross_total' });

    vi.spyOn(redisMock, 'hSet').mockImplementation(async () => {
      throw new Error('failed hash write');
    });
    vi.spyOn(redisMock, 'zAdd').mockImplementation(async () => {
      throw new Error('failed zset write');
    });
    const redisGlobalSetSpy = vi
      .spyOn(redisGlobalMock, 'set')
      .mockImplementation(async (key, value, options) => {
        if (key.startsWith('crosspostTerminalRevision:')) {
          throw new Error('failed terminal marker write');
        }
        return InMemoryRedis.prototype.set.call(redisGlobalMock, key, value, options);
      });
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const firstSummary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(firstSummary.crosspostsCreated).toBe(1);
    expect(firstSummary.crosspostPersistenceFailedAfterCreate).toBe(1);
    expect(
      loggedEvents.some(
        (event) => event.event === 'crosspost_persistence_failed_after_create'
      )
    ).toBe(true);
    expect(redisGlobalSetSpy).toHaveBeenCalled();
    expect(
      consoleErrorSpy.mock.calls.some((call) =>
        call.some(
          (arg) =>
            typeof arg === 'string' &&
            arg.includes('terminal dedupe mark failed')
        )
      )
    ).toBe(true);

    loggedEvents.length = 0;
    const secondSummary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(secondSummary.crosspostsCreated).toBe(0);
    expect(mockReddit.crosspost).toHaveBeenCalledTimes(1);
    redisGlobalSetSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('skips when source create in-flight lock is held', async () => {
    mockContext.subredditName = 'SubGoal';
    await redisGlobalMock.set('crosspostCreateInFlight:t3_inflight', 'other-lock');
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (page === crosspostWikiPages.newPost) {
          return {
            ok: true,
            revisions: [
              {
                id: 'rev_inflight',
                reason: 'Post t3_inflight with goal 10',
                dateMs: Date.now(),
              },
            ],
            durationMs: 1,
          };
        }
        return { ok: true, revisions: [], durationMs: 1 };
      }
    );
    mockReddit.getPostById.mockResolvedValue({
      id: 't3_inflight',
      subredditId: 't5_source',
      subredditName: 'CorporateGifts',
      createdAt: new Date(Date.now() - 60_000),
      nsfw: false,
    });
    mockReddit.getSubredditInfoById.mockResolvedValue({ isNsfw: false });

    const summary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(summary.crosspostsCreated).toBe(0);
    expect(summary.crosspostsSkippedByInFlight).toBe(1);
    expect(mockReddit.crosspost).not.toHaveBeenCalled();
    expect(
      loggedEvents.some(
        (event) =>
          event.event === 'crosspost_attempt_skipped' &&
          event.reason === 'source_create_inflight'
      )
    ).toBe(true);
  });

  it('detects existing target crosspost and skips duplicate creation', async () => {
    mockContext.subredditName = 'SubGoal';
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (page === crosspostWikiPages.newPost) {
          return {
            ok: true,
            revisions: [
              {
                id: 'rev_existing',
                reason: 'Post t3_existing with goal 10',
                dateMs: Date.now(),
              },
            ],
            durationMs: 1,
          };
        }
        return { ok: true, revisions: [], durationMs: 1 };
      }
    );
    mockReddit.getPostById.mockResolvedValue({
      id: 't3_existing',
      subredditId: 't5_source',
      subredditName: 'CorporateGifts',
      createdAt: new Date(Date.now() - 60_000),
      nsfw: false,
    });
    mockReddit.getSubredditInfoById.mockResolvedValue({ isNsfw: false });
    mockReddit.getNewPosts.mockReturnValue({
      get: vi.fn().mockResolvedValue([
        {
          id: 't3_existing_crosspost',
          url: 'https://reddit.com/r/corporategifts/comments/existing/title/',
          title: 'Visit r/corporategifts, they are trying to reach 10 subscribers!',
          body: '',
        },
      ]),
    });

    const summary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(summary.crosspostsCreated).toBe(0);
    expect(summary.crosspostsSkippedByExistingDetection).toBe(1);
    expect(mockReddit.crosspost).not.toHaveBeenCalled();
    expect(await redisMock.hGet('crosspostList', 't3_existing')).toBe(
      't3_existing_crosspost'
    );
    expect(
      loggedEvents.some(
        (event) =>
          event.event === 'crosspost_attempt_skipped' &&
          event.reason === 'existing_crosspost_detected'
      )
    ).toBe(true);
  });

  it('treats INVALID_CROSSPOST_THING root_post_id as terminal skip and processes revision', async () => {
    mockContext.subredditName = 'SubGoal';
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (page === crosspostWikiPages.newPost) {
          return {
            ok: true,
            revisions: [
              {
                id: 'rev_invalid_crosspost_thing',
                reason: 'Post t3_invalidroot with goal 10',
                dateMs: Date.now(),
              },
            ],
            durationMs: 1,
          };
        }
        return { ok: true, revisions: [], durationMs: 1 };
      }
    );
    mockReddit.getPostById.mockResolvedValue({
      id: 't3_invalidroot',
      subredditId: 't5_source',
      subredditName: 'CorporateGifts',
      createdAt: new Date(Date.now() - 60_000),
      nsfw: false,
    });
    mockReddit.getSubredditInfoById.mockResolvedValue({ isNsfw: false });
    mockReddit.crosspost.mockRejectedValue(
      new Error(
        "INVALID_CROSSPOST_THING: Your crosspost includes a link that isn't working. Double-check it and try again.: root_post_id"
      )
    );

    const summary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(summary.crosspostsSkipped).toBe(1);
    expect(summary.crosspostsFailed).toBe(0);
    expect(await redisMock.hGet('processedRevisions', 'rev_invalid_crosspost_thing')).toBe(
      't3_invalidroot'
    );
    expect(
      loggedEvents.some(
        (event) =>
          event.event === 'crosspost_attempt_skipped' &&
          event.reason === 'source_not_crosspostable'
      )
    ).toBe(true);
  });
});
