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
  cancelAllAutoCreateNextGoals: vi.fn(),
  cancelAutoCreateNextGoal: vi.fn(),
  getDueAutoCreateNextGoalPostIds: vi.fn(),
  getSubGoalData: vi.fn(),
  recordAutoCreateNextGoalFailure: vi.fn(),
  createSubscriberGoal: vi.fn(),
  notifyStickyFailure: vi.fn(),
  reddit: {
    getPostById: vi.fn(),
    getCurrentSubreddit: vi.fn()
  },
  redis: {}
}));

vi.mock('../data/subGoalData', () => ({
  cancelAllAutoCreateNextGoals: hoisted.cancelAllAutoCreateNextGoals,
  cancelAutoCreateNextGoal: hoisted.cancelAutoCreateNextGoal,
  getDueAutoCreateNextGoalPostIds: hoisted.getDueAutoCreateNextGoalPostIds,
  getSubGoalData: hoisted.getSubGoalData,
  recordAutoCreateNextGoalFailure: hoisted.recordAutoCreateNextGoalFailure
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
    hoisted.recordAutoCreateNextGoalFailure.mockResolvedValue({
      failureCount: 1,
      retryAt: 301_000
    });
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 5,
      recentSubscriber: '',
      completedTime: 1_000,
      subredditDisplayName: 'ExampleSub',
      colorTheme: 'purple',
      postHeight: 'short',
      autoCreateNextGoal: true,
      language: 'en',
      afterSubscribeAction: {
        type: 'link',
        buttonText: 'Join the Discord',
        url: 'https://discord.com/invite/example',
        colorTheme: 'pink'
      },
      afterSubscribePreset: 'discord'
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
    ).resolves.toEqual({
      due: 0,
      created: 0,
      skipped: 0,
      failed: 0,
      rescheduled: 0,
      exhausted: 0
    });

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
    ).resolves.toEqual({
      due: 1,
      created: 1,
      skipped: 0,
      failed: 0,
      rescheduled: 0,
      exhausted: 0
    });

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
        afterSubscribeAction: {
          type: 'link',
          buttonText: 'Join the Discord',
          url: 'https://discord.com/invite/example',
          colorTheme: 'pink'
        },
        afterSubscribePreset: 'discord',
        cancelPendingAutoCreateGoals: false
      }
    });
    expect(hoisted.cancelAllAutoCreateNextGoals).toHaveBeenCalledWith(hoisted.redis);
  });

  it('inherits the source goal language instead of re-detecting the subreddit language', async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(['t3_source']);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 5,
      recentSubscriber: '',
      completedTime: 1_000,
      subredditDisplayName: 'ExampleSub',
      colorTheme: 'purple',
      postHeight: 'short',
      autoCreateNextGoal: true,
      language: 'es',
      afterSubscribeAction: { type: 'disabled' },
      afterSubscribePreset: null
    });
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: 't5_example',
      name: 'examplesub',
      numberOfSubscribers: 12,
      isNsfw: false,
      language: 'de'
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
    ).resolves.toEqual({
      due: 1,
      created: 0,
      skipped: 1,
      failed: 0,
      rescheduled: 0,
      exhausted: 0
    });

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
    ).resolves.toEqual({
      due: 1,
      created: 0,
      skipped: 1,
      failed: 0,
      rescheduled: 0,
      exhausted: 0
    });

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
    ).resolves.toEqual({
      due: 1,
      created: 0,
      skipped: 1,
      failed: 0,
      rescheduled: 0,
      exhausted: 0
    });

    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(hoisted.redis, 't3_source');
  });

  it('reschedules a failed automatic creation', async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(['t3_source']);
    hoisted.createSubscriberGoal.mockRejectedValue(new Error('post failed'));

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<typeof processDueAutoCreateNextGoals>[0]['reddit'],
        redis: hoisted.redis as Parameters<typeof processDueAutoCreateNextGoals>[0]['redis'],
        appSettings: baseSettings
      })
    ).resolves.toEqual({
      due: 1,
      created: 0,
      skipped: 0,
      failed: 1,
      rescheduled: 1,
      exhausted: 0
    });

    expect(hoisted.recordAutoCreateNextGoalFailure).toHaveBeenCalledWith(
      hoisted.redis,
      't3_source',
      expect.any(Number)
    );
    expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
  });

  it('clears a failed automatic creation after retries are exhausted', async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(['t3_source']);
    hoisted.createSubscriberGoal.mockRejectedValue(new Error('post failed'));
    hoisted.recordAutoCreateNextGoalFailure.mockResolvedValue({
      failureCount: 6,
      retryAt: null
    });

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<typeof processDueAutoCreateNextGoals>[0]['reddit'],
        redis: hoisted.redis as Parameters<typeof processDueAutoCreateNextGoals>[0]['redis'],
        appSettings: baseSettings
      })
    ).resolves.toEqual({
      due: 1,
      created: 0,
      skipped: 0,
      failed: 1,
      rescheduled: 0,
      exhausted: 1
    });

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
    ).resolves.toEqual({
      due: 1,
      created: 1,
      skipped: 0,
      failed: 0,
      rescheduled: 0,
      exhausted: 0
    });

    expect(hoisted.notifyStickyFailure).toHaveBeenCalledWith({
      reddit: hoisted.reddit,
      subredditId: 't5_example',
      subredditName: 'examplesub',
      postTitle: 'Welcome to r/ExampleSub!',
      postUrl: 'https://reddit.com/r/examplesub/comments/next',
      errorMessage: 'sticky slots full'
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"auto_create_goal_degraded"')
    );
    warnSpy.mockRestore();
  });
});
