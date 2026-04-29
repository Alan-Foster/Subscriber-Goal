import { describe, expect, it } from 'vitest';
import {
  addRecentSubscriberPostIndex,
  eraseFromRecentSubscribers,
  getSubGoalData,
  processRecentSubscriberIndexMigrationBatch,
  recentSubscriberIndexMigrationStateKey,
  recentSubscriberPostsByUsernameKey,
  setSubGoalData,
  setSubredditDisplayNameForPost,
  subscriberGoalsKey,
  postColorThemeSuffix,
  postSubredditDisplayNameSuffix,
} from './subGoalData';
import { postsKey } from './updaterData';

type ZEntry = { member: string; score: number };

class InMemoryRedis {
  private hashes = new Map<string, Map<string, string>>();
  private sortedSets = new Map<string, Map<string, number>>();
  hGetAllCalls = 0;

  async hSet(key: string, fields: Record<string, string>): Promise<void> {
    const current = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(fields)) {
      current.set(field, value);
    }
    this.hashes.set(key, current);
  }

  async hMGet(
    key: string,
    fields: string[]
  ): Promise<Array<string | null>> {
    const map = this.hashes.get(key) ?? new Map<string, string>();
    return fields.map((field) => map.get(field) ?? null);
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    this.hGetAllCalls += 1;
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

  async zScan(
    key: string,
    cursor: number,
    _pattern?: string,
    count = 10
  ): Promise<{ cursor: number; members: ZEntry[] }> {
    const current = this.sortedSets.get(key) ?? new Map<string, number>();
    const sorted = [...current.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    const members = sorted.slice(cursor, cursor + count);
    const nextCursor =
      cursor + members.length >= sorted.length ? 0 : cursor + members.length;
    return { cursor: nextCursor, members };
  }
}

describe('subGoalData subreddit display name', () => {
  it('persists subreddit display name via setSubGoalData/getSubGoalData', async () => {
    const redis = new InMemoryRedis();
    await setSubGoalData(
      redis as unknown as Parameters<typeof setSubGoalData>[0],
      't3_post',
      {
        goal: 10,
        recentSubscriber: '',
        completedTime: 0,
        subredditDisplayName: 'Subscriber_Goal_Dev',
        colorTheme: 'red',
      }
    );

    const data = await getSubGoalData(
      redis as unknown as Parameters<typeof getSubGoalData>[0],
      't3_post'
    );
    expect(data.subredditDisplayName).toBe('Subscriber_Goal_Dev');
  });

  it('updates display name independently for a post', async () => {
    const redis = new InMemoryRedis();
    await setSubGoalData(
      redis as unknown as Parameters<typeof setSubGoalData>[0],
      't3_post',
      {
        goal: 10,
        recentSubscriber: '',
        completedTime: 0,
        subredditDisplayName: 'subscriber_goal_dev',
        colorTheme: 'red',
      }
    );

    await setSubredditDisplayNameForPost(
      redis as unknown as Parameters<typeof setSubredditDisplayNameForPost>[0],
      't3_post',
      'Subscriber_Goal_Dev'
    );

    const data = await getSubGoalData(
      redis as unknown as Parameters<typeof getSubGoalData>[0],
      't3_post'
    );
    expect(data.subredditDisplayName).toBe('Subscriber_Goal_Dev');
    expect(
      await redis.hGet(
        subscriberGoalsKey,
        `t3_post${postSubredditDisplayNameSuffix}`
      )
    ).toBe('Subscriber_Goal_Dev');
  });

  it('persists each supported color theme', async () => {
    const redis = new InMemoryRedis();
    for (const colorTheme of ['red', 'green', 'purple', 'blue'] as const) {
      await setSubGoalData(
        redis as unknown as Parameters<typeof setSubGoalData>[0],
        `t3_${colorTheme}`,
        {
          goal: 10,
          recentSubscriber: '',
          completedTime: 0,
          subredditDisplayName: 'subscriber_goal_dev',
          colorTheme,
        }
      );

      const data = await getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        `t3_${colorTheme}`
      );
      expect(data.colorTheme).toBe(colorTheme);
      expect(
        await redis.hGet(
          subscriberGoalsKey,
          `t3_${colorTheme}${postColorThemeSuffix}`
        )
      ).toBe(colorTheme);
    }
  });

  it('defaults missing or invalid color themes to red', async () => {
    const redis = new InMemoryRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_missing_goal: '10',
      t3_invalid_goal: '10',
      [`t3_invalid${postColorThemeSuffix}`]: 'orange',
    });

    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        't3_missing'
      )
    ).resolves.toMatchObject({ colorTheme: 'red' });
    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        't3_invalid'
      )
    ).resolves.toMatchObject({ colorTheme: 'red' });
  });

  it('clears indexed recent subscriber fields without scanning all goal records', async () => {
    const redis = new InMemoryRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_post_recent_subscriber: 'TestUser',
      t3_other_recent_subscriber: 'OtherUser',
    });
    await addRecentSubscriberPostIndex(
      redis as unknown as Parameters<typeof addRecentSubscriberPostIndex>[0],
      'TestUser',
      't3_post'
    );

    await eraseFromRecentSubscribers(
      redis as unknown as Parameters<typeof eraseFromRecentSubscribers>[0],
      'testuser'
    );

    expect(await redis.hGet(subscriberGoalsKey, 't3_post_recent_subscriber')).toBe(
      ''
    );
    expect(
      await redis.hGet(subscriberGoalsKey, 't3_other_recent_subscriber')
    ).toBe('OtherUser');
    expect(
      await redis.hGet(recentSubscriberPostsByUsernameKey, 'testuser')
    ).toBeUndefined();
    expect(redis.hGetAllCalls).toBe(0);
  });

  it('indexes recent subscribers from tracked posts in bounded migration batches', async () => {
    const redis = new InMemoryRedis();
    await redis.zAdd(
      postsKey,
      { member: 't3_a', score: 100 },
      { member: 't3_b', score: 200 }
    );
    await redis.hSet(subscriberGoalsKey, {
      t3_a_recent_subscriber: 'Alice',
      t3_b_recent_subscriber: '',
    });
    await redis.hSet(recentSubscriberIndexMigrationStateKey, {
      version: 'recent_subscriber_index_v1',
      status: 'pending',
      cursor: '0',
      nextRunAt: '0',
      scannedTotal: '0',
      indexedTotal: '0',
      lastRunAt: '0',
    });

    await processRecentSubscriberIndexMigrationBatch(
      redis as unknown as Parameters<
        typeof processRecentSubscriberIndexMigrationBatch
      >[0],
      {
        nowMs: 1_000,
        batchSize: 2,
        cooldownMinMs: 5,
        cooldownMaxMs: 5,
      }
    );

    expect(await redis.hGet(recentSubscriberPostsByUsernameKey, 'alice')).toBe(
      JSON.stringify(['t3_a'])
    );
    expect(await redis.hGetAll(recentSubscriberIndexMigrationStateKey)).toMatchObject(
      {
        status: 'complete',
        cursor: '0',
        scannedTotal: '2',
        indexedTotal: '1',
      }
    );
  });
});
