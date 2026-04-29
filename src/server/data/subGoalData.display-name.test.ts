import { describe, expect, it } from 'vitest';
import {
  getSubGoalData,
  setSubGoalData,
  setSubredditDisplayNameForPost,
  subscriberGoalsKey,
  postColorThemeSuffix,
  postSubredditDisplayNameSuffix,
} from './subGoalData';

class InMemoryRedis {
  private hashes = new Map<string, Map<string, string>>();

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
});
