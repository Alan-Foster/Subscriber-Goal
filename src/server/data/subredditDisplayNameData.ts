import type { RedisClient } from '../types';

export const subredditDisplayNameKey = 'subreddit_display_name';

export async function getSavedSubredditDisplayName(
  redis: RedisClient
): Promise<string | null> {
  const value = await redis.get(subredditDisplayNameKey);
  if (!value || value.length === 0) {
    return null;
  }
  return value;
}

export async function setSavedSubredditDisplayName(
  redis: RedisClient,
  subredditDisplayName: string
): Promise<void> {
  await redis.set(subredditDisplayNameKey, subredditDisplayName);
}

export async function ensureSavedSubredditDisplayName(
  redis: RedisClient,
  defaultSubredditName: string
): Promise<void> {
  const existing = await getSavedSubredditDisplayName(redis);
  if (existing) {
    return;
  }
  await setSavedSubredditDisplayName(redis, defaultSubredditName);
}
