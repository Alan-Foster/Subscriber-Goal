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
  checkCompletionStatus: hoisted.checkCompletionStatus,
  getSubGoalData: hoisted.getSubGoalData,
  processRecentSubscriberIndexMigrationBatch:
    hoisted.processRecentSubscriberIndexMigrationBatch,
}));

vi.mock('../data/updaterData', () => ({
  cancelUpdates: hoisted.cancelUpdates,
  getQueuedUpdates: hoisted.getQueuedUpdates,
  queueUpdate: hoisted.queueUpdate,
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
});
