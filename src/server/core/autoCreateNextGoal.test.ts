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
  reddit: {
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
      autoCreateNextGoal: true
    });
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      name: 'examplesub',
      numberOfSubscribers: 12,
      isNsfw: false
    });
    hoisted.createSubscriberGoal.mockResolvedValue({
      post: { id: 't3_next' },
      crosspostDispatchResult: { status: 'success' }
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
        autoCreateNextGoal: true,
        cancelPendingAutoCreateGoals: true
      }
    });
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(hoisted.redis, 't3_source');
  });

  it('disables crossposting for NSFW subreddits', async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(['t3_source']);
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
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

  it('skips stale due jobs whose source goal is not completed', async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(['t3_source']);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 5,
      recentSubscriber: '',
      completedTime: 0,
      subredditDisplayName: 'ExampleSub',
      colorTheme: 'purple',
      autoCreateNextGoal: true
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
});
