import { describe, expect, it, vi } from 'vitest';
import { getSubredditIcon } from './redditUtils';

describe('getSubredditIcon', () => {
  it('returns subreddit style icon when available', async () => {
    const reddit = {
      getSubredditStyles: vi.fn(async () => ({
        icon: 'https://example.com/icon.png',
      })),
    };

    const icon = await getSubredditIcon(
      reddit as unknown as Parameters<typeof getSubredditIcon>[0],
      't5_abc123'
    );

    expect(icon).toBe('https://example.com/icon.png');
    expect(reddit.getSubredditStyles).toHaveBeenCalledWith('t5_abc123');
  });

  it('returns local fallback when style icon is missing', async () => {
    const reddit = {
      getSubredditStyles: vi.fn(async () => ({
        icon: undefined,
      })),
    };

    const icon = await getSubredditIcon(
      reddit as unknown as Parameters<typeof getSubredditIcon>[0],
      't5_abc123'
    );

    expect(icon).toBe('/reddit_temp_logo.jpg');
    expect(reddit.getSubredditStyles).toHaveBeenCalledWith('t5_abc123');
  });

  it('returns local fallback for invalid subreddit id', async () => {
    const reddit = {
      getSubredditStyles: vi.fn(),
    };

    const icon = await getSubredditIcon(
      reddit as unknown as Parameters<typeof getSubredditIcon>[0],
      'not_a_subreddit_id'
    );

    expect(icon).toBe('/reddit_temp_logo.jpg');
    expect(reddit.getSubredditStyles).not.toHaveBeenCalled();
  });
});
