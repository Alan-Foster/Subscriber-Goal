import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  crosspostDeletionDueKey,
  crosspostDeletionMarkersKey,
  crosspostListKey,
  crosspostWikiPages,
  getCrosspostPendingByRevisionKey,
} from '../data/crosspostData';
import { postsKey } from '../data/updaterData';
import type { ServerAppSettings } from '../settings';

const hoisted = vi.hoisted(() => ({
  mockContext: {} as {
    subredditName?: string;
    subredditId?: string;
  },
  mockReddit: {
    getCurrentSubreddit: vi.fn(),
    getPostById: vi.fn(),
    getSubredditInfoById: vi.fn(),
    getNewPosts: vi.fn(),
    crosspost: vi.fn(),
  },
  safeGetWikiPageRevisionsMock: vi.fn(),
  loggedEvents: [] as Array<Record<string, unknown>>,
  redisState: {
    redisMock: undefined as unknown,
  },
  handleAppAccountModeratorAction: vi.fn(),
}));

const mockContext = hoisted.mockContext;
const mockReddit = hoisted.mockReddit;
const safeGetWikiPageRevisionsMock = hoisted.safeGetWikiPageRevisionsMock;
const loggedEvents = hoisted.loggedEvents;

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

  async hLen(key: string): Promise<number> {
    return this.hashes.get(key)?.size ?? 0;
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

  async zScore(key: string, member: string): Promise<number | undefined> {
    return this.sortedSets.get(key)?.get(member);
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

  async watch(..._keys: string[]): Promise<{
    multi(): Promise<void>;
    set(key: string, value: string, options?: SetOptions): Promise<string>;
    hSet(key: string, fields: Record<string, string>): Promise<void>;
    hDel(key: string, fields: string[]): Promise<void>;
    zRem(key: string, members: string[]): Promise<void>;
    exec(): Promise<string>;
  }> {
    return {
      multi: async (): Promise<void> => {
        return;
      },
      set: async (key: string, value: string, options?: SetOptions): Promise<string> => {
        return await this.set(key, value, options);
      },
      hSet: async (key: string, fields: Record<string, string>): Promise<void> => {
        await this.hSet(key, fields);
      },
      hDel: async (key: string, fields: string[]): Promise<void> => {
        await this.hDel(key, fields);
      },
      zRem: async (key: string, members: string[]): Promise<void> => {
        await this.zRem(key, members);
      },
      exec: async (): Promise<string> => {
        return 'OK';
      },
    };
  }
}

let redisMock: InMemoryRedis;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

vi.mock('@devvit/web/server', () => ({
  reddit: hoisted.mockReddit,
  redis: {
    get: (...args: [string]) =>
      (hoisted.redisState.redisMock as InMemoryRedis).get(...args),
    set: (...args: [string, string, SetOptions?]) =>
      (hoisted.redisState.redisMock as InMemoryRedis).set(...args),
    del: (...args: string[]) =>
      (hoisted.redisState.redisMock as InMemoryRedis).del(...args),
    hSet: (...args: [string, Record<string, string>]) =>
      (hoisted.redisState.redisMock as InMemoryRedis).hSet(...args),
    hGet: (...args: [string, string]) =>
      (hoisted.redisState.redisMock as InMemoryRedis).hGet(...args),
    hGetAll: (...args: [string]) =>
      (hoisted.redisState.redisMock as InMemoryRedis).hGetAll(...args),
    hLen: (...args: [string]) =>
      (hoisted.redisState.redisMock as InMemoryRedis).hLen(...args),
    hDel: (...args: [string, string[]]) =>
      (hoisted.redisState.redisMock as InMemoryRedis).hDel(...args),
    zAdd: (...args: [string, ...ZEntry[]]) =>
      (hoisted.redisState.redisMock as InMemoryRedis).zAdd(...args),
    zRange: (...args: [string, number, number]) =>
      (hoisted.redisState.redisMock as InMemoryRedis).zRange(...args),
    zScore: (...args: [string, string]) =>
      (hoisted.redisState.redisMock as InMemoryRedis).zScore(...args),
    zRem: (...args: [string, string[]]) =>
      (hoisted.redisState.redisMock as InMemoryRedis).zRem(...args),
    watch: (...args: string[]) =>
      (hoisted.redisState.redisMock as InMemoryRedis).watch(...args),
  },
  context: hoisted.mockContext,
  scheduler: {},
}));

vi.mock('../utils/crosspostLogs', () => ({
  toErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  logCrosspostEvent: (payload: Record<string, unknown>, level = 'info') => {
    hoisted.loggedEvents.push({ ...payload, __level: level });
  },
}));

vi.mock('../utils/redditUtils', () => ({
  safeGetWikiPageRevisions: (...args: unknown[]) =>
    hoisted.safeGetWikiPageRevisionsMock(...args),
}));

vi.mock('../core/appAccountHealth', () => ({
  appAccountHealthStateKey: 'app_account_health_v1_state',
  subscriberGoalAppUsername: 'subscriber-goal',
}));
vi.mock('../core/appAccountRecovery', () => ({
  handleAppAccountModeratorAction: hoisted.handleAppAccountModeratorAction,
}));

import { onModAction, processCrosspostDispatchQueue } from './modAction';

const baseSettings: ServerAppSettings = {
  promoSubreddit: 'SubGoal',
  crosspostAuthoritySubreddit: 'SubGoal',
  crosspostMaxSourcePostAgeMinutes: 10,
  crosspostIngestionEnabled: true,
  crosspostMaxRevisionAgeMinutes: 10,
  maxCrosspostsPerRun: 5,
  maxCrosspostsPerHour: 30,
  crosspostRetryWindowMinutes: 1440,
  crosspostRetryBaseDelaySeconds: 60,
  crosspostRetryMaxDelayMinutes: 30,
  crosspostPendingBatchSize: 25,
};

describe('processCrosspostDispatchQueue ingestion guards', () => {
  beforeEach(() => {
    redisMock = new InMemoryRedis();
    hoisted.redisState.redisMock = redisMock;
    mockContext.subredditName = undefined;
    mockContext.subredditId = undefined;
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
    hoisted.handleAppAccountModeratorAction.mockReset();
    hoisted.handleAppAccountModeratorAction.mockResolvedValue(undefined);
  });

  it.each([
    'removemoderator',
    'uninvitemoderator',
    'setpermissions',
    'addmoderator',
    'invitemoderator',
    'acceptmoderatorinvite',
  ])(
    'checks app-account health after %s targets the app',
    async (action) => {
      mockContext.subredditName = 'ExampleSub';
      mockContext.subredditId = 't5_example';

      await onModAction({
        action,
        targetUser: { name: 'subscriber-goal' },
      });

      expect(hoisted.handleAppAccountModeratorAction).toHaveBeenCalledWith({
        reddit: expect.anything(),
        redis: expect.anything(),
        scheduler: expect.anything(),
        action,
        subredditName: 'ExampleSub',
        subredditId: 't5_example',
      });
    },
  );

  it('ignores moderator permission changes for other accounts', async () => {
    mockContext.subredditName = 'ExampleSub';

    await onModAction({
      action: 'removemoderator',
      targetUser: { name: 'another-mod' },
    });

    expect(hoisted.handleAppAccountModeratorAction).not.toHaveBeenCalled();
  });

  it('records the removing moderator and event timestamp for recovery', async () => {
    mockContext.subredditName = 'ExampleSub';
    mockContext.subredditId = 't5_example';

    await onModAction({
      action: 'removemoderator',
      actionedAt: '2026-11-01T12:00:00.000Z',
      moderator: { name: 'RemovingMod' },
      targetUser: { name: 'subscriber-goal' },
    });

    expect(hoisted.handleAppAccountModeratorAction).toHaveBeenCalledWith({
      reddit: expect.anything(),
      redis: expect.anything(),
      scheduler: expect.anything(),
      action: 'removemoderator',
      actionedAt: '2026-11-01T12:00:00.000Z',
      moderatorName: 'RemovingMod',
      subredditName: 'ExampleSub',
      subredditId: 't5_example',
    });
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
          event.reason === 'non_authority' &&
          event.__level === 'info'
      )
    ).toBe(true);
  });

  it('logs unexpected new-post revisions only once across repeated runs', async () => {
    mockContext.subredditName = 'SubGoal';
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_redditArg: unknown, _subreddit: string, page: string) => ({
        ok: true,
        revisions:
          page === crosspostWikiPages.newPost
            ? [
                {
                  id: 'rev_create_page',
                  reason: 'Create Page',
                  dateMs: Date.now(),
                },
              ]
            : [],
        durationMs: 1,
      })
    );

    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');
    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');

    expect(
      consoleWarnSpy.mock.calls.filter(([message]) =>
        String(message).includes('unexpected_new_post_reason')
      )
    ).toHaveLength(1);
    consoleWarnSpy.mockRestore();
  });

  it('suppresses daisy-chain pass logs when a successful pass clears the backlog', async () => {
    mockContext.subredditName = 'SubGoal';
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_redditArg: unknown, _subreddit: string, _page: string) => ({
        ok: true,
        revisions: [],
        durationMs: 1,
      })
    );

    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');

    expect(
      consoleInfoSpy.mock.calls.some(([message]) =>
        String(message).includes('daisy-chain pass')
      )
    ).toBe(false);
    consoleInfoSpy.mockRestore();
  });

  it('skips ingestion when lock is held by another worker', async () => {
    mockContext.subredditName = 'SubGoal';
    await redisMock.set('crosspostIngestionLock:subgoal', 'held-by-other');

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
    expect(
      await redisMock.hGet(
        getCrosspostPendingByRevisionKey('SubGoal'),
        'rev_old'
      )
    ).toBeDefined();
  });

  it('expires retrying stale-source pending work after retry window', async () => {
    mockContext.subredditName = 'SubGoal';
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (page === crosspostWikiPages.newPost) {
          return {
            ok: true,
            revisions: [
              {
                id: 'rev_expire',
                reason: 'Post t3_expire with goal 100',
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
      id: 't3_expire',
      subredditId: 't5_source',
      subredditName: 'CorporateGifts',
      createdAt: new Date(Date.now() - 11 * 60 * 1000),
      nsfw: false,
    });

    const first = await processCrosspostDispatchQueue(
      {
        ...baseSettings,
        crosspostRetryWindowMinutes: 1,
      },
      'scheduler_posts_updater'
    );
    expect(first.crosspostsSkipped).toBeGreaterThan(0);
    const pendingKey = getCrosspostPendingByRevisionKey('SubGoal');
    const rawPending = await redisMock.hGet(pendingKey, 'rev_expire');
    expect(rawPending).toBeDefined();
    if (!rawPending) {
      throw new Error('expected pending crosspost payload');
    }
    const parsedPending = JSON.parse(rawPending) as {
      firstSeenMs: number;
      nextAttemptMs: number;
    };
    await redisMock.hSet(pendingKey, {
      rev_expire: JSON.stringify({
        ...(JSON.parse(rawPending) as Record<string, unknown>),
        firstSeenMs: parsedPending.firstSeenMs - 2 * 60 * 1000,
        nextAttemptMs: Date.now(),
      }),
    });
    await redisMock.zAdd('crosspostPendingByTime:subgoal', {
      member: 'rev_expire',
      score: Date.now(),
    });

    loggedEvents.length = 0;
    const second = await processCrosspostDispatchQueue(
      {
        ...baseSettings,
        crosspostRetryWindowMinutes: 1,
      },
      'scheduler_posts_updater'
    );
    expect(second.crosspostsSkipped).toBeGreaterThan(0);
    expect(await redisMock.hGet(pendingKey, 'rev_expire')).toBeUndefined();
    expect(
      loggedEvents.some(
        (event) =>
          event.event === 'crosspost_attempt_skipped' &&
          event.reason === 'source_post_too_old_retry_window_expired'
      )
    ).toBe(true);
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
                reason: 'Post t3_secs with goal 15000',
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
    expect(mockReddit.crosspost).toHaveBeenCalledWith({
      subredditName: baseSettings.promoSubreddit,
      title: 'Visit r/CorporateGifts, they are trying to reach 15k subscribers!',
      postId: 't3_secs',
      nsfw: false,
    });
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

  it('onModAction wikirevise only runs from r/SubGoal', async () => {
    mockContext.subredditName = 'SubGoal';
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

  it('enforces hourly cap using install history', async () => {
    mockContext.subredditName = 'SubGoal';
    await redisMock.zAdd(
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
    await redisMock.set('crosspostSourceCreateCooldown:t3_cool', '1');
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
    mockReddit.getSubredditInfoById.mockResolvedValue({ isNsfw: false });

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

  it('treats mapping persistence failure as unhealthy and retries reconciliation', async () => {
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

    expect(summary.crosspostsCreated).toBe(0);
    expect(summary.crosspostPersistenceFailedAfterCreate).toBe(1);
    expect(await redisMock.hGet('processedRevisions', 'rev_partial')).toBe(
      't3_partial'
    );
    expect(
      loggedEvents.some(
        (event) => event.event === 'crosspost_finalize_transaction_failed'
      )
    ).toBe(true);
    expect(
      loggedEvents.some(
        (event) => event.event === 'crosspost_persistence_failed_after_create'
      )
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

    const originalHSet = redisMock.hSet.bind(redisMock);
    const hSetSpy = vi
      .spyOn(redisMock, 'hSet')
      .mockImplementation(async (key, fields) => {
        if (key === 'crosspostList') {
          throw new Error('failed mapping write');
        }
        return originalHSet(key, fields);
      });
    const redisSetSpy = vi
      .spyOn(redisMock, 'set')
      .mockImplementation(async (key, value, options) => {
        if (key.startsWith('crosspostTerminalRevision:')) {
          throw new Error('failed terminal marker write');
        }
        return InMemoryRedis.prototype.set.call(redisMock, key, value, options);
      });

    const firstSummary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(firstSummary.crosspostsCreated).toBe(0);
    expect(firstSummary.crosspostPersistenceFailedAfterCreate).toBe(1);
    expect(
      hSetSpy.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' &&
          call[0] === getCrosspostPendingByRevisionKey('SubGoal')
      )
    ).toBe(true);
    expect(
      loggedEvents.some(
        (event) => event.event === 'crosspost_finalize_transaction_failed'
      )
    ).toBe(true);
    expect(
      loggedEvents.some(
        (event) => event.event === 'crosspost_persistence_failed_after_create'
      )
    ).toBe(true);
    expect(redisSetSpy).toHaveBeenCalled();

    loggedEvents.length = 0;
    const secondSummary = await processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );

    expect(secondSummary.crosspostsCreated).toBe(0);
    expect(mockReddit.crosspost).toHaveBeenCalledTimes(1);
    redisSetSpy.mockRestore();
  });

  it('skips when source create in-flight lock is held', async () => {
    mockContext.subredditName = 'SubGoal';
    await redisMock.set('crosspostCreateInFlight:t3_inflight', 'other-lock');
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
          event.event === 'crosspost_reconciliation_succeeded' &&
          event.reason === 'reconciliation_mapping_backfilled'
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

  it('durably acknowledges delete-before-create and blocks the delayed mirror', async () => {
    mockContext.subredditName = 'SubGoal';
    let exposeCreate = false;
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (page === crosspostWikiPages.action.delete) {
          return {
            ok: true,
            revisions: [
              { id: 'rev_delete_first', reason: 'Dispatch delete for t3_late' },
            ],
            durationMs: 1,
          };
        }
        if (exposeCreate && page === crosspostWikiPages.newPost) {
          return {
            ok: true,
            revisions: [
              {
                id: 'rev_create_late',
                reason: 'Post t3_late with goal 10',
                dateMs: Date.now(),
              },
            ],
            durationMs: 1,
          };
        }
        return { ok: true, revisions: [], durationMs: 1 };
      }
    );

    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');
    expect(await redisMock.hGet('processedRevisions', 'rev_delete_first')).toBe(
      't3_late'
    );
    expect(
      await redisMock.hGet(crosspostDeletionMarkersKey, 't3_late')
    ).toBeDefined();

    exposeCreate = true;
    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');

    expect(mockReddit.crosspost).not.toHaveBeenCalled();
    expect(
      await redisMock.hGet(crosspostDeletionMarkersKey, 't3_late')
    ).toBeDefined();
    expect(await redisMock.zScore(crosspostDeletionDueKey, 't3_late')).toBeUndefined();
  });

  it('re-arms cleanup after an in-flight create loses its first handoff write', async () => {
    mockContext.subredditName = 'SubGoal';
    let mode: 'create' | 'delete' | 'empty' = 'create';
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (mode === 'create' && page === crosspostWikiPages.newPost) {
          return {
            ok: true,
            revisions: [
              {
                id: 'rev_racing_create',
                reason: 'Post t3_racing with goal 10',
                dateMs: Date.now(),
              },
            ],
            durationMs: 1,
          };
        }
        if (mode === 'delete' && page === crosspostWikiPages.action.delete) {
          return {
            ok: true,
            revisions: [
              {
                id: 'rev_racing_delete',
                reason: 'Dispatch delete for t3_racing',
              },
            ],
            durationMs: 1,
          };
        }
        return { ok: true, revisions: [], durationMs: 1 };
      }
    );
    mockReddit.getPostById.mockImplementation(async (postId: string) =>
      postId === 't3_racing_mirror'
        ? {
            id: postId,
            subredditName: 'SubGoal',
            delete: deleteMirror,
          }
        : {
            id: 't3_racing',
            subredditId: 't5_source',
            subredditName: 'CorporateGifts',
            createdAt: new Date(Date.now() - 60_000),
            nsfw: false,
          }
    );
    mockReddit.getSubredditInfoById.mockResolvedValue({ isNsfw: false });
    const createGate = deferred<{ id: string }>();
    const deleteMirror = vi.fn(async () => undefined);
    mockReddit.crosspost.mockReturnValue(createGate.promise);

    const createRun = processCrosspostDispatchQueue(
      baseSettings,
      'scheduler_posts_updater'
    );
    await vi.waitFor(() => expect(mockReddit.crosspost).toHaveBeenCalledOnce());

    // Model both lock TTLs expiring while Reddit is still creating the mirror.
    await redisMock.del(
      'crosspostIngestionLock:subgoal',
      'crosspostCreateInFlight:t3_racing'
    );
    await redisMock.zAdd('crosspostPendingByTime:subgoal', {
      member: 'rev_racing_create',
      score: Date.now() + 60_000,
    });
    mode = 'delete';
    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');
    mode = 'empty';
    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');
    expect(await redisMock.zScore(crosspostDeletionDueKey, 't3_racing')).toBeUndefined();

    const originalZAdd = redisMock.zAdd.bind(redisMock);
    let failHandoff = true;
    vi.spyOn(redisMock, 'zAdd').mockImplementation(async (key, ...entries) => {
      if (key === crosspostDeletionDueKey && failHandoff) {
        failHandoff = false;
        throw new Error('cleanup handoff unavailable');
      }
      await originalZAdd(key, ...entries);
    });
    createGate.resolve({ id: 't3_racing_mirror' });
    await createRun;

    expect(deleteMirror).not.toHaveBeenCalled();
    expect(await redisMock.hGet(crosspostListKey, 't3_racing')).toBe(
      't3_racing_mirror'
    );
    await redisMock.zAdd('crosspostPendingByTime:subgoal', {
      member: 'rev_racing_create',
      score: 1,
    });
    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');
    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');

    expect(deleteMirror).toHaveBeenCalledOnce();
    expect(await redisMock.hGet(crosspostListKey, 't3_racing')).toBeUndefined();
  });

  it('uses one replay deletion for duplicate revisions and preserves the marker for a later mirror', async () => {
    mockContext.subredditName = 'SubGoal';
    let exposeDeletes = true;
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) =>
        exposeDeletes && page === crosspostWikiPages.action.delete
          ? {
              ok: true,
              revisions: [
                { id: 'rev_delete_a', reason: 'Dispatch delete for t3_dup' },
                { id: 'rev_delete_b', reason: 'Dispatch delete for t3_dup' },
              ],
              durationMs: 1,
            }
          : { ok: true, revisions: [], durationMs: 1 }
    );
    await redisMock.hSet(crosspostListKey, {
      t3_dup: 't3_dup_mirror',
      t3_other: 't3_other_mirror',
    });
    await redisMock.zAdd(
      postsKey,
      { member: 't3_dup', score: 1 },
      { member: 't3_other', score: 2 }
    );
    const deleteMirror = vi.fn(async () => undefined);
    mockReddit.getPostById.mockResolvedValue({
      id: 't3_dup_mirror',
      subredditName: 'SubGoal',
      delete: deleteMirror,
    });

    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');
    exposeDeletes = false;
    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');

    expect(deleteMirror).toHaveBeenCalledOnce();
    expect(await redisMock.hGet(crosspostListKey, 't3_other')).toBe(
      't3_other_mirror'
    );
    expect(await redisMock.hGet('processedRevisions', 'rev_delete_a')).toBe('t3_dup');
    expect(await redisMock.hGet('processedRevisions', 'rev_delete_b')).toBe('t3_dup');

    await redisMock.hSet(crosspostListKey, { t3_dup: 't3_later_mirror' });
    await redisMock.zAdd(crosspostDeletionDueKey, {
      member: 't3_dup',
      score: 1,
    });
    mockReddit.getPostById.mockResolvedValue({
      id: 't3_later_mirror',
      subredditName: 'SubGoal',
      delete: deleteMirror,
    });
    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');

    expect(deleteMirror).toHaveBeenCalledTimes(2);
    expect(
      await redisMock.hGet(crosspostDeletionMarkersKey, 't3_dup')
    ).toBeDefined();
  });

  it('leaves a delete revision retryable after marker persistence fails', async () => {
    mockContext.subredditName = 'SubGoal';
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) =>
        page === crosspostWikiPages.action.delete
          ? {
              ok: true,
              revisions: [
                { id: 'rev_marker_retry', reason: 'Dispatch delete for t3_retry' },
              ],
              durationMs: 1,
            }
          : { ok: true, revisions: [], durationMs: 1 }
    );
    const originalHSet = redisMock.hSet.bind(redisMock);
    let failMarker = true;
    vi.spyOn(redisMock, 'hSet').mockImplementation(async (key, fields) => {
      if (key === crosspostDeletionMarkersKey && failMarker) {
        failMarker = false;
        throw new Error('marker unavailable');
      }
      await originalHSet(key, fields);
    });

    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');
    expect(await redisMock.hGet('processedRevisions', 'rev_marker_retry')).toBeUndefined();
    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');

    expect(await redisMock.hGet('processedRevisions', 'rev_marker_retry')).toBe(
      't3_retry'
    );
  });

  it('retries a failed mirror deletion through the marker replay worker', async () => {
    mockContext.subredditName = 'SubGoal';
    safeGetWikiPageRevisionsMock.mockResolvedValue({
      ok: true,
      revisions: [],
      durationMs: 1,
    });
    await redisMock.hSet(crosspostDeletionMarkersKey, {
      t3_delete_retry: JSON.stringify({
        sourcePostId: 't3_delete_retry',
        firstRevisionId: 'rev_delete_retry',
        recordedAtMs: 1,
      }),
    });
    await redisMock.hSet(crosspostListKey, {
      t3_delete_retry: 't3_delete_retry_mirror',
    });
    await redisMock.zAdd(postsKey, {
      member: 't3_delete_retry',
      score: 1,
    });
    await redisMock.zAdd(crosspostDeletionDueKey, {
      member: 't3_delete_retry',
      score: 1,
    });
    const deleteMirror = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary delete failure'))
      .mockResolvedValueOnce(undefined);
    mockReddit.getPostById.mockResolvedValue({
      id: 't3_delete_retry_mirror',
      subredditName: 'SubGoal',
      delete: deleteMirror,
    });

    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');
    expect(deleteMirror).toHaveBeenCalledOnce();
    expect(await redisMock.hGet(crosspostListKey, 't3_delete_retry')).toBe(
      't3_delete_retry_mirror'
    );

    await redisMock.zAdd(crosspostDeletionDueKey, {
      member: 't3_delete_retry',
      score: 1,
    });
    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');

    expect(deleteMirror).toHaveBeenCalledTimes(2);
    expect(
      await redisMock.hGet(crosspostListKey, 't3_delete_retry')
    ).toBeUndefined();
  });

  it('preserves ordinary remove and approve mirroring', async () => {
    mockContext.subredditName = 'SubGoal';
    safeGetWikiPageRevisionsMock.mockImplementation(
      async (_reddit: unknown, _subredditName: string, page: string) => {
        if (page === crosspostWikiPages.action.remove) {
          return {
            ok: true,
            revisions: [
              { id: 'rev_remove', reason: 'Dispatch remove for t3_remove' },
            ],
            durationMs: 1,
          };
        }
        if (page === crosspostWikiPages.action.approve) {
          return {
            ok: true,
            revisions: [
              { id: 'rev_approve', reason: 'Dispatch approve for t3_approve' },
            ],
            durationMs: 1,
          };
        }
        return { ok: true, revisions: [], durationMs: 1 };
      }
    );
    await redisMock.hSet(crosspostListKey, {
      t3_remove: 't3_remove_mirror',
      t3_approve: 't3_approve_mirror',
    });
    await redisMock.zAdd(
      postsKey,
      { member: 't3_remove', score: 1 },
      { member: 't3_approve', score: 2 }
    );
    const remove = vi.fn(async () => undefined);
    const approve = vi.fn(async () => undefined);
    mockReddit.getPostById.mockImplementation(async (postId: string) => ({
      id: postId,
      subredditName: 'SubGoal',
      remove,
      approve,
    }));

    await processCrosspostDispatchQueue(baseSettings, 'scheduler_posts_updater');

    expect(remove).toHaveBeenCalledWith(false);
    expect(approve).toHaveBeenCalledOnce();
    expect(await redisMock.hGet('processedRevisions', 'rev_remove')).toBe(
      't3_remove'
    );
    expect(await redisMock.hGet('processedRevisions', 'rev_approve')).toBe(
      't3_approve'
    );
  });
});
