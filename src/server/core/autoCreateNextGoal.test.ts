import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerAppSettings } from '../settings';
import { processDueAutoCreateNextGoals } from './autoCreateNextGoal';

const baseSettings: ServerAppSettings = {
  promoSubreddit: 'SubGoal',
  crosspostAuthoritySubreddit: 'SubGoal',
  crosspostMaxSourcePostAgeMinutes: 10,
  crosspostIngestionEnabled: true,
  crosspostMaxRevisionAgeMinutes: 10,
  maxCrosspostsPerRun: 2,
  maxCrosspostsPerHour: 10,
  crosspostRetryWindowMinutes: 1440,
  crosspostRetryBaseDelaySeconds: 60,
  crosspostRetryMaxDelayMinutes: 30,
  crosspostPendingBatchSize: 25
};

const hoisted = vi.hoisted(() => ({
  cancelAutoCreateNextGoal: vi.fn(),
  getDueAutoCreateNextGoalPostIds: vi.fn(),
  getSubGoalData: vi.fn(),
  createSubscriberGoal: vi.fn(),
  notifyStickyFailure: vi.fn(),
  reddit: {
    getPostById: vi.fn(),
    getCurrentSubreddit: vi.fn()
  },
  redis: {}
}));

vi.mock('../data/subGoalData', () => ({
  cancelAutoCreateNextGoal: hoisted.cancelAutoCreateNextGoal,
  getDueAutoCreateNextGoalPostIds: hoisted.getDueAutoCreateNextGoalPostIds,
  getSubGoalData: hoisted.getSubGoalData
}));

vi.mock('./createSubscriberGoal', () => ({
  createSubscriberGoal: hoisted.createSubscriberGoal
}));

vi.mock('../utils/stickyFailureNotifications', () => ({
  getPostUrl: vi.fn((post: { permalink?: string; url?: string }) =>
    post.permalink ? `https://reddit.com${post.permalink}` : post.url
  ),
  notifyStickyFailure: hoisted.notifyStickyFailure
}));

describe('processDueAutoCreateNextGoals', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue([]);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 5,
      recentSubscriber: '',
      completedTime: 1_000,
      subredditDisplayName: 'ExampleSub',
      colorTheme: 'purple',
      postHeight: 'short',
      autoCreateNextGoal: true,
      language: 'en'
    });
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: 't5_example',
      name: 'examplesub',
      numberOfSubscribers: 12,
      isNsfw: false
    });
    hoisted.reddit.getPostById.mockResolvedValue({
      id: 't3_source',
      removedByCategory: undefined
    });
    hoisted.createSubscriberGoal.mockResolvedValue({
      post: {
        id: 't3_next',
        title: 'Welcome to r/ExampleSub!',
        permalink: '/r/examplesub/comments/next'
      },
      crosspostDispatchResult: { status: 'success' },
      stickyResult: { status: 'pinned', verifiedStickied: true }
    });
  });

  it('does not create a goal before any job is due', async () => {
    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<typeof processDueAutoCreateNextGoals>[0]['reddit'],
        redis: hoisted.redis as Parameters<typeof processDueAutoCreateNextGoals>[0]['redis'],
        appSettings: baseSettings,
        nowMs: 10
      })
    ).resolves.toEqual({ due: 0, created: 0, skipped: 0, failed: 0 });

    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it('creates the next default milestone and carries display settings forward', async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(['t3_source']);

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<typeof processDueAutoCreateNextGoals>[0]['reddit'],
        redis: hoisted.redis as Parameters<typeof processDueAutoCreateNextGoals>[0]['redis'],
        appSettings: baseSettings,
        nowMs: 86_401_000
      })
    ).resolves.toEqual({ due: 1, created: 1, skipped: 0, failed: 0 });

    expect(hoisted.createSubscriberGoal).toHaveBeenCalledWith({
      reddit: hoisted.reddit,
      redis: hoisted.redis,
      appSettings: baseSettings,
      options: {
        title: 'Welcome to r/ExampleSub!',
        goal: 15,
        subredditDisplayName: 'ExampleSub',
        crosspost: true,
        colorTheme: 'purple',
        postHeight: 'short',
        autoCreateNextGoal: true,
        language: 'en',
        cancelPendingAutoCreateGoals: true
      }
    });
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(hoisted.redis, 't3_source');
  });

  it('disables crossposting for NSFW subreddits', async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(['t3_source']);
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: 't5_example',
      name: 'examplesub',
      numberOfSubscribers: 12,
      isNsfw: true
    });

    await processDueAutoCreateNextGoals({
      reddit: hoisted.reddit as Parameters<typeof processDueAutoCreateNextGoals>[0]['reddit'],
      redis: hoisted.redis as Parameters<typeof processDueAutoCreateNextGoals>[0]['redis'],
      appSettings: baseSettings
    });

    expect(hoisted.createSubscriberGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ crosspost: false })
      })
    );
  });

  it('inherits Spanish and uses the localized default title', async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(['t3_source']);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 5,
      recentSubscriber: '',
      completedTime: 1_000,
      subredditDisplayName: 'ExampleSub',
      colorTheme: 'blue',
      postHeight: 'regular',
      autoCreateNextGoal: true,
      language: 'es'
    });

    await processDueAutoCreateNextGoals({
      reddit: hoisted.reddit as Parameters<typeof processDueAutoCreateNextGoals>[0]['reddit'],
      redis: hoisted.redis as Parameters<typeof processDueAutoCreateNextGoals>[0]['redis'],
      appSettings: baseSettings
    });

    expect(hoisted.createSubscriberGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          title: '¡Bienvenido a r/ExampleSub!',
          language: 'es'
        })
      })
    );
  });

  it('skips stale due jobs whose source goal is not completed', async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(['t3_source']);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 5,
      recentSubscriber: '',
      completedTime: 0,
      subredditDisplayName: 'ExampleSub',
      colorTheme: 'purple',
      postHeight: 'regular',
      autoCreateNextGoal: true,
      language: 'en'
    });

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<typeof processDueAutoCreateNextGoals>[0]['reddit'],
        redis: hoisted.redis as Parameters<typeof processDueAutoCreateNextGoals>[0]['redis'],
        appSettings: baseSettings
      })
    ).resolves.toEqual({ due: 1, created: 0, skipped: 1, failed: 0 });

    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(hoisted.redis, 't3_source');
  });

  it('skips due jobs whose source post has been removed', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(['t3_source']);
    hoisted.reddit.getPostById.mockResolvedValue({
      id: 't3_source',
      removedByCategory: 'moderator'
    });

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<typeof processDueAutoCreateNextGoals>[0]['reddit'],
        redis: hoisted.redis as Parameters<typeof processDueAutoCreateNextGoals>[0]['redis'],
        appSettings: baseSettings
      })
    ).resolves.toEqual({ due: 1, created: 0, skipped: 1, failed: 0 });

    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(hoisted.redis, 't3_source');
    expect(infoSpy).toHaveBeenCalledWith(
      '[autoCreateNextGoal] skipping inactive source post: sourcePostId=t3_source reason=removedByCategory:moderator'
    );
  });

  it('skips due jobs whose source post is missing', async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(['t3_source']);
    hoisted.reddit.getPostById.mockRejectedValue(new Error('post has been deleted'));

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<typeof processDueAutoCreateNextGoals>[0]['reddit'],
        redis: hoisted.redis as Parameters<typeof processDueAutoCreateNextGoals>[0]['redis'],
        appSettings: baseSettings
      })
    ).resolves.toEqual({ due: 1, created: 0, skipped: 1, failed: 0 });

    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(hoisted.redis, 't3_source');
  });

  it('clears the due job after a failed single attempt', async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(['t3_source']);
    hoisted.createSubscriberGoal.mockRejectedValue(new Error('post failed'));

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<typeof processDueAutoCreateNextGoals>[0]['reddit'],
        redis: hoisted.redis as Parameters<typeof processDueAutoCreateNextGoals>[0]['redis'],
        appSettings: baseSettings
      })
    ).resolves.toEqual({ due: 1, created: 0, skipped: 0, failed: 1 });

    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(hoisted.redis, 't3_source');
  });

  it('notifies moderators when an auto-created goal cannot be pinned', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(['t3_source']);
    hoisted.createSubscriberGoal.mockResolvedValue({
      post: {
        id: 't3_next',
        title: 'Welcome to r/ExampleSub!',
        permalink: '/r/examplesub/comments/next'
      },
      crosspostDispatchResult: { status: 'success' },
      stickyResult: {
        status: 'not_pinned',
        errorMessage: 'sticky slots full',
        verifiedStickied: false
      }
    });

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<typeof processDueAutoCreateNextGoals>[0]['reddit'],
        redis: hoisted.redis as Parameters<typeof processDueAutoCreateNextGoals>[0]['redis'],
        appSettings: baseSettings
      })
    ).resolves.toEqual({ due: 1, created: 1, skipped: 0, failed: 0 });

    expect(hoisted.notifyStickyFailure).toHaveBeenCalledWith({
      reddit: hoisted.reddit,
      subredditId: 't5_example',
      subredditName: 'examplesub',
      postTitle: 'Welcome to r/ExampleSub!',
      postUrl: 'https://reddit.com/r/examplesub/comments/next',
      errorMessage: 'sticky slots full'
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '[autoCreateNextGoal] created next goal but failed to pin it: sourcePostId=t3_source postId=t3_next subreddit=examplesub error=sticky slots full'
    );
    warnSpy.mockRestore();
  });
});
