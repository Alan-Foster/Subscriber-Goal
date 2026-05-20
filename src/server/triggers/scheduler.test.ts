import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerAppSettings } from '../settings';

const emptyCrosspostSummary = {
  status: 'success' as const,
  revisionsFetched: 0,
  newPostsSeen: 0,
  crosspostsCreated: 0,
  crosspostsSkipped: 0,
  crosspostsFailed: 0,
  actionsMirrored: 0,
  actionsFailed: 0,
  crosspostsCreatedThisRun: 0,
  crosspostsBlockedByRunCap: 0,
  crosspostsBlockedByHourlyCap: 0,
  crosspostPersistenceFailedAfterCreate: 0,
  crosspostsSkippedBySourceCooldown: 0,
  crosspostsSkippedByInFlight: 0,
  crosspostsSkippedByExistingDetection: 0,
};

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
  crosspostPendingBatchSize: 25,
};

const hoisted = vi.hoisted(() => ({
  context: {
    subredditName: undefined as string | undefined,
  },
  reddit: {
    getCurrentSubreddit: vi.fn(),
    getPostById: vi.fn(),
  },
  getAppSettings: vi.fn(),
  processCrosspostDispatchQueue: vi.fn(),
  countPendingCrossposts: vi.fn(),
  processSubscriberStatsMigrationBatch: vi.fn(),
  processRecentSubscriberIndexMigrationBatch: vi.fn(),
  processDueAutoCreateNextGoals: vi.fn(),
  getQueuedUpdates: vi.fn(),
  queueUpdate: vi.fn(),
  cancelUpdates: vi.fn(),
  untrackPost: vi.fn(),
  cancelAutoCreateNextGoal: vi.fn(),
  getSubGoalData: vi.fn(),
  checkCompletionStatus: vi.fn(),
  applyTextFallback: vi.fn(),
}));

vi.mock('@devvit/web/server', () => ({
  context: hoisted.context,
  reddit: hoisted.reddit,
  redis: {},
}));

vi.mock('../settings', () => ({
  getAppSettings: hoisted.getAppSettings,
}));

vi.mock('./modAction', () => ({
  isCrosspostAuthorityInstall: (
    appSettings: ServerAppSettings,
    subredditName: string
  ): boolean =>
    subredditName.trim().replace(/^r\//i, '').toLowerCase() ===
    (appSettings.crosspostAuthoritySubreddit || appSettings.promoSubreddit)
      .trim()
      .replace(/^r\//i, '')
      .toLowerCase(),
  processCrosspostDispatchQueue: hoisted.processCrosspostDispatchQueue,
}));

vi.mock('../data/crosspostData', () => ({
  countPendingCrossposts: hoisted.countPendingCrossposts,
}));

vi.mock('../data/subscriberStats', () => ({
  processSubscriberStatsMigrationBatch:
    hoisted.processSubscriberStatsMigrationBatch,
}));

vi.mock('../data/subGoalData', () => ({
  cancelAutoCreateNextGoal: hoisted.cancelAutoCreateNextGoal,
  checkCompletionStatus: hoisted.checkCompletionStatus,
  getSubGoalData: hoisted.getSubGoalData,
  processRecentSubscriberIndexMigrationBatch:
    hoisted.processRecentSubscriberIndexMigrationBatch,
}));

vi.mock('../data/updaterData', () => ({
  cancelUpdates: hoisted.cancelUpdates,
  getQueuedUpdates: hoisted.getQueuedUpdates,
  queueUpdate: hoisted.queueUpdate,
  untrackPost: hoisted.untrackPost,
}));

vi.mock('../utils/textFallback', () => ({
  applyTextFallback: hoisted.applyTextFallback,
}));

vi.mock('../core/autoCreateNextGoal', () => ({
  processDueAutoCreateNextGoals: hoisted.processDueAutoCreateNextGoals,
}));

import { onPostsUpdaterJob } from './scheduler';

describe('onPostsUpdaterJob crosspost scheduling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    hoisted.context.subredditName = undefined;
    hoisted.reddit.getCurrentSubreddit.mockReset();
    hoisted.reddit.getPostById.mockReset();
    hoisted.getAppSettings.mockReset();
    hoisted.processCrosspostDispatchQueue.mockReset();
    hoisted.countPendingCrossposts.mockReset();
    hoisted.processSubscriberStatsMigrationBatch.mockReset();
    hoisted.processRecentSubscriberIndexMigrationBatch.mockReset();
    hoisted.processDueAutoCreateNextGoals.mockReset();
    hoisted.getQueuedUpdates.mockReset();
    hoisted.queueUpdate.mockReset();
    hoisted.cancelUpdates.mockReset();
    hoisted.untrackPost.mockReset();
    hoisted.cancelAutoCreateNextGoal.mockReset();
    hoisted.getSubGoalData.mockReset();
    hoisted.checkCompletionStatus.mockReset();
    hoisted.applyTextFallback.mockReset();
    hoisted.getAppSettings.mockReturnValue(baseSettings);
    hoisted.processCrosspostDispatchQueue.mockResolvedValue(emptyCrosspostSummary);
    hoisted.countPendingCrossposts.mockResolvedValue(0);
    hoisted.processSubscriberStatsMigrationBatch.mockResolvedValue(undefined);
    hoisted.processRecentSubscriberIndexMigrationBatch.mockResolvedValue(undefined);
    hoisted.processDueAutoCreateNextGoals.mockResolvedValue({
      due: 0,
      created: 0,
      skipped: 0,
      failed: 0,
    });
    hoisted.getQueuedUpdates.mockResolvedValue([]);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 12,
      recentSubscriber: '',
      completedTime: 0,
      subredditDisplayName: 'CorporateGifts',
      colorTheme: 'red',
      autoCreateNextGoal: true,
      language: 'en',
    });
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      name: 'CorporateGifts',
      numberOfSubscribers: 10,
    });
  });

  it('skips crosspost ingestion and pending-depth lookup outside authority installs', async () => {
    hoisted.context.subredditName = 'CorporateGifts';

    await onPostsUpdaterJob();

    expect(hoisted.processCrosspostDispatchQueue).not.toHaveBeenCalled();
    expect(hoisted.countPendingCrossposts).not.toHaveBeenCalled();
    expect(hoisted.processSubscriberStatsMigrationBatch).toHaveBeenCalled();
    expect(hoisted.processRecentSubscriberIndexMigrationBatch).toHaveBeenCalled();
  });

  it('runs crosspost ingestion from the authority install', async () => {
    hoisted.context.subredditName = 'SubGoal';

    await onPostsUpdaterJob();

    expect(hoisted.processCrosspostDispatchQueue).toHaveBeenCalledWith(
      baseSettings,
      'scheduler_posts_updater'
    );
    expect(hoisted.countPendingCrossposts).toHaveBeenCalledWith(
      expect.anything(),
      'SubGoal'
    );
  });

  it('cleans up moderator-removed posts without updating or requeueing', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    hoisted.context.subredditName = 'CorporateGifts';
    hoisted.getQueuedUpdates.mockResolvedValue(['t3_removed']);
    hoisted.reddit.getPostById.mockResolvedValue({
      id: 't3_removed',
      removedByCategory: 'moderator',
    });

    await onPostsUpdaterJob();

    expect(hoisted.cancelUpdates).toHaveBeenCalledWith(
      expect.anything(),
      't3_removed'
    );
    expect(hoisted.untrackPost).toHaveBeenCalledWith(
      expect.anything(),
      't3_removed'
    );
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(
      expect.anything(),
      't3_removed'
    );
    expect(hoisted.applyTextFallback).not.toHaveBeenCalled();
    expect(hoisted.queueUpdate).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[updater] cleaned up inactive post: postId=t3_removed reason=removedByCategory:moderator'
    );
  });

  it('cleans up deleted posts without updating or requeueing', async () => {
    hoisted.context.subredditName = 'CorporateGifts';
    hoisted.getQueuedUpdates.mockResolvedValue(['t3_deleted']);
    hoisted.reddit.getPostById.mockResolvedValue({
      id: 't3_deleted',
      removedByCategory: 'deleted',
    });

    await onPostsUpdaterJob();

    expect(hoisted.cancelUpdates).toHaveBeenCalledWith(
      expect.anything(),
      't3_deleted'
    );
    expect(hoisted.untrackPost).toHaveBeenCalledWith(
      expect.anything(),
      't3_deleted'
    );
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(
      expect.anything(),
      't3_deleted'
    );
    expect(hoisted.applyTextFallback).not.toHaveBeenCalled();
    expect(hoisted.queueUpdate).not.toHaveBeenCalled();
  });

  it('updates and requeues active posts with no removedByCategory', async () => {
    hoisted.context.subredditName = 'CorporateGifts';
    hoisted.getQueuedUpdates.mockResolvedValue(['t3_active']);
    hoisted.reddit.getPostById.mockResolvedValue({
      id: 't3_active',
      removedByCategory: undefined,
    });

    await onPostsUpdaterJob();

    expect(hoisted.applyTextFallback).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't3_active' }),
      expect.objectContaining({
        goal: 12,
        subscribers: 10,
        subredditName: 'CorporateGifts',
      })
    );
    expect(hoisted.queueUpdate).toHaveBeenCalledWith(
      expect.anything(),
      't3_active',
      expect.any(Date)
    );
    expect(hoisted.cancelUpdates).not.toHaveBeenCalled();
    expect(hoisted.untrackPost).not.toHaveBeenCalled();
    expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
  });

  it('cleans up missing posts returned as deleted/not-found errors', async () => {
    hoisted.context.subredditName = 'CorporateGifts';
    hoisted.getQueuedUpdates.mockResolvedValue(['t3_missing']);
    hoisted.reddit.getPostById.mockRejectedValue(new Error('post not found'));

    await onPostsUpdaterJob();

    expect(hoisted.cancelUpdates).toHaveBeenCalledWith(
      expect.anything(),
      't3_missing'
    );
    expect(hoisted.untrackPost).toHaveBeenCalledWith(
      expect.anything(),
      't3_missing'
    );
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(
      expect.anything(),
      't3_missing'
    );
    expect(hoisted.queueUpdate).not.toHaveBeenCalled();
  });

  it('keeps transient post lookup errors queued for retry', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    hoisted.context.subredditName = 'CorporateGifts';
    hoisted.getQueuedUpdates.mockResolvedValue(['t3_retry']);
    hoisted.reddit.getPostById.mockRejectedValue(new Error('503 Service Unavailable'));

    await onPostsUpdaterJob();

    expect(hoisted.cancelUpdates).not.toHaveBeenCalled();
    expect(hoisted.untrackPost).not.toHaveBeenCalled();
    expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'Error updating post t3_retry: Error: 503 Service Unavailable'
    );
  });

  it('cleans up invalid post ids from queue and tracking', async () => {
    hoisted.context.subredditName = 'CorporateGifts';
    hoisted.getQueuedUpdates.mockResolvedValue(['bad_id']);

    await onPostsUpdaterJob();

    expect(hoisted.cancelUpdates).toHaveBeenCalledWith(expect.anything(), 'bad_id');
    expect(hoisted.untrackPost).toHaveBeenCalledWith(expect.anything(), 'bad_id');
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(
      expect.anything(),
      'bad_id'
    );
    expect(hoisted.reddit.getPostById).not.toHaveBeenCalled();
  });

  it('cleans up posts with missing goal data', async () => {
    hoisted.context.subredditName = 'CorporateGifts';
    hoisted.getQueuedUpdates.mockResolvedValue(['t3_no_goal']);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 0,
      recentSubscriber: '',
      completedTime: 0,
      subredditDisplayName: 'CorporateGifts',
      colorTheme: 'red',
      autoCreateNextGoal: true,
      language: 'en',
    });

    await onPostsUpdaterJob();

    expect(hoisted.cancelUpdates).toHaveBeenCalledWith(
      expect.anything(),
      't3_no_goal'
    );
    expect(hoisted.untrackPost).toHaveBeenCalledWith(
      expect.anything(),
      't3_no_goal'
    );
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(
      expect.anything(),
      't3_no_goal'
    );
    expect(hoisted.reddit.getPostById).not.toHaveBeenCalled();
  });
});
