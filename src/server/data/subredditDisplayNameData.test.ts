import { describe, expect, it } from 'vitest';
import {
  ensureSavedSubredditDisplayName,
  getSavedSubredditDisplayName,
  setSavedSubredditDisplayName,
  subredditDisplayNameKey,
} from './subredditDisplayNameData';

class InMemoryRedis {
  private kv = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.kv.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
  }
}

describe('subredditDisplayNameData', () => {
  it('stores and retrieves saved display name', async () => {
    const redis = new InMemoryRedis();
    await setSavedSubredditDisplayName(
      redis as unknown as Parameters<typeof setSavedSubredditDisplayName>[0],
      'Subscriber_Goal_Dev'
    );

    expect(
      await getSavedSubredditDisplayName(
        redis as unknown as Parameters<typeof getSavedSubredditDisplayName>[0]
      )
    ).toBe('Subscriber_Goal_Dev');
    expect(await redis.get(subredditDisplayNameKey)).toBe(
      'Subscriber_Goal_Dev'
    );
  });

  it('returns null when no saved value exists', async () => {
    const redis = new InMemoryRedis();
    expect(
      await getSavedSubredditDisplayName(
        redis as unknown as Parameters<typeof getSavedSubredditDisplayName>[0]
      )
    ).toBeNull();
  });

  it('initializes default display name only when missing', async () => {
    const redis = new InMemoryRedis();
    await ensureSavedSubredditDisplayName(
      redis as unknown as Parameters<typeof ensureSavedSubredditDisplayName>[0],
      'subscriber_goal_dev'
    );
    expect(await redis.get(subredditDisplayNameKey)).toBe('subscriber_goal_dev');

    await setSavedSubredditDisplayName(
      redis as unknown as Parameters<typeof setSavedSubredditDisplayName>[0],
      'Subscriber_Goal_Dev'
    );
    await ensureSavedSubredditDisplayName(
      redis as unknown as Parameters<typeof ensureSavedSubredditDisplayName>[0],
      'subscriber_goal_dev'
    );
    expect(await redis.get(subredditDisplayNameKey)).toBe('Subscriber_Goal_Dev');
  });
});
