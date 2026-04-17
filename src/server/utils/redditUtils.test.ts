import { describe, expect, it, vi } from 'vitest';
import { getSubredditIcon, safeGetWikiPageRevisions } from './redditUtils';
import * as crosspostLogs from './crosspostLogs';

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

describe('safeGetWikiPageRevisions', () => {
  it('does not emit routine start or success crosspost logs on successful fetch', async () => {
    const logSpy = vi.spyOn(crosspostLogs, 'logCrosspostEvent');
    const listing = {
      get: vi.fn(async () => [
        {
          id: 'rev_1',
          reason: 'Post t3_abc123 with goal 69',
          date: 1_776_433_730,
        },
      ]),
    };
    const reddit = {
      getWikiPageRevisions: vi.fn(() => listing),
    };

    const result = await safeGetWikiPageRevisions(
      reddit as unknown as Parameters<typeof safeGetWikiPageRevisions>[0],
      'PythiaSpeaks',
      'post'
    );

    expect(result.ok).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('normalizes numeric revision dates expressed in seconds to milliseconds', async () => {
    const listing = {
      get: vi.fn(async () => [
        {
          id: 'rev_1',
          reason: 'Post t3_abc123 with goal 69',
          date: 1_776_433_730,
        },
      ]),
    };
    const reddit = {
      getWikiPageRevisions: vi.fn(() => listing),
    };

    const result = await safeGetWikiPageRevisions(
      reddit as unknown as Parameters<typeof safeGetWikiPageRevisions>[0],
      'PythiaSpeaks',
      'post'
    );

    expect(result.ok).toBe(true);
    expect(result.revisions).toEqual([
      {
        id: 'rev_1',
        reason: 'Post t3_abc123 with goal 69',
        dateMs: 1_776_433_730_000,
      },
    ]);
  });

  it('emits an error crosspost log when wiki fetch fails', async () => {
    const logSpy = vi.spyOn(crosspostLogs, 'logCrosspostEvent');
    const listing = {
      get: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const reddit = {
      getWikiPageRevisions: vi.fn(() => listing),
    };

    const result = await safeGetWikiPageRevisions(
      reddit as unknown as Parameters<typeof safeGetWikiPageRevisions>[0],
      'PythiaSpeaks',
      'post'
    );

    expect(result.ok).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'wiki_fetch_failed',
        targetSubreddit: 'PythiaSpeaks',
        page: 'post',
        reason: 'fetch_wiki_revisions',
        errorMessage: 'boom',
      }),
      'error'
    );
    logSpy.mockRestore();
  });
});
