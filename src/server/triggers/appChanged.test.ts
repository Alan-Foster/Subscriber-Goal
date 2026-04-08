import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  context: {
    subredditName: undefined as string | undefined,
    subredditId: undefined as string | undefined,
  },
  getCurrentSubreddit: vi.fn(),
  ensureSavedSubredditDisplayName: vi.fn(),
  getTrackedPosts: vi.fn(),
  queueUpdates: vi.fn(),
}));

vi.mock('@devvit/web/server', () => ({
  context: hoisted.context,
  reddit: {
    getCurrentSubreddit: hoisted.getCurrentSubreddit,
  },
  redis: {},
}));

vi.mock('../data/subredditDisplayNameData', () => ({
  ensureSavedSubredditDisplayName: hoisted.ensureSavedSubredditDisplayName,
}));

vi.mock('../data/updaterData', () => ({
  getTrackedPosts: hoisted.getTrackedPosts,
  queueUpdates: hoisted.queueUpdates,
}));

import { onAppChanged } from './appChanged';

describe('onAppChanged', () => {
  beforeEach(() => {
    hoisted.context.subredditName = undefined;
    hoisted.context.subredditId = undefined;
    hoisted.getCurrentSubreddit.mockReset();
    hoisted.ensureSavedSubredditDisplayName.mockReset();
    hoisted.getTrackedPosts.mockReset();
    hoisted.queueUpdates.mockReset();
    hoisted.getTrackedPosts.mockResolvedValue([]);
  });

  it('skips gracefully when lifecycle trigger has no subreddit context', async () => {
    await expect(onAppChanged()).resolves.toBeUndefined();

    expect(hoisted.getCurrentSubreddit).not.toHaveBeenCalled();
    expect(hoisted.ensureSavedSubredditDisplayName).not.toHaveBeenCalled();
    expect(hoisted.queueUpdates).not.toHaveBeenCalled();
  });

  it('uses subredditName from context without calling reddit.getCurrentSubreddit', async () => {
    hoisted.context.subredditName = 'SubGoal';

    await expect(onAppChanged()).resolves.toBeUndefined();

    expect(hoisted.getCurrentSubreddit).not.toHaveBeenCalled();
    expect(hoisted.ensureSavedSubredditDisplayName).toHaveBeenCalledWith(
      expect.anything(),
      'SubGoal'
    );
  });

  it('falls back safely when subreddit fetch fails', async () => {
    hoisted.context.subredditId = 't5_abc';
    hoisted.getCurrentSubreddit.mockRejectedValue(new Error('no context'));

    await expect(onAppChanged()).resolves.toBeUndefined();

    expect(hoisted.getCurrentSubreddit).toHaveBeenCalledTimes(1);
    expect(hoisted.ensureSavedSubredditDisplayName).not.toHaveBeenCalled();
  });
});
