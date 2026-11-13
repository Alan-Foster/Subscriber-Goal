import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAppSettings } from "../settings";

const emptyCrosspostSummary = {
  status: "success" as const,
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
  promoSubreddit: "SubGoal",
  crosspostAuthoritySubreddit: "SubGoal",
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
  redis: {
    hGet: vi.fn(),
  },
  getAppSettings: vi.fn(),
  processCrosspostDispatchQueue: vi.fn(),
  countPendingCrossposts: vi.fn(),
  processSubscriberStatsMigrationBatch: vi.fn(),
  processPostKindMigrationBatch: vi.fn(),
  processLegacyAfterSubscribeActionMigrationBatch: vi.fn(),
  processNsfwAfterSubscribeActionMigrationBatch: vi.fn(),
  processRecentSubscriberIndexMigrationBatch: vi.fn(),
  processDueAutoCreateNextGoals: vi.fn(),
  processDueOnboardingSubscriberGoal: vi.fn(),
  processDueOnboardingReminder: vi.fn(),
  getQueuedUpdates: vi.fn(),
  queueUpdate: vi.fn(),
  cancelUpdates: vi.fn(),
  untrackPost: vi.fn(),
  cancelAutoCreateNextGoal: vi.fn(),
  getSubGoalData: vi.fn(),
  checkCompletionStatus: vi.fn(),
  repairAutoCreateNextGoal: vi.fn(),
  withCommunityGoalMutationLease: vi.fn(),
  applyTextFallback: vi.fn(),
  applyGoalPostFrameStyle: vi.fn(),
  removeSubscriberGoalPost: vi.fn(),
  observeDailySubscriberCount: vi.fn(),
  getLastKnownSubscriberCount: vi.fn(),
  ensureCommunityPostActivityBackfill: vi.fn(),
  processDueAppAccountHealthCheck: vi.fn(),
  processDueAppAccountRecovery: vi.fn(),
  processDueAppRepair: vi.fn(),
  retireSubscriberGoalPost: vi.fn(),
  getPostOperationalState: vi.fn(),
  savePostOperationalState: vi.fn(),
  clearPostOperationalState: vi.fn(),
  scheduleHighlightRepair: vi.fn(),
  processDueSourcePostDeletions: vi.fn(),
  queueConfirmedSourceDeletionCleanup: vi.fn(),
}));

vi.mock("@devvit/web/server", () => ({
  context: hoisted.context,
  reddit: hoisted.reddit,
  redis: hoisted.redis,
  scheduler: {},
}));

vi.mock("../settings", () => ({
  getAppSettings: hoisted.getAppSettings,
}));

vi.mock("./modAction", () => ({
  isCrosspostAuthorityInstall: (
    appSettings: ServerAppSettings,
    subredditName: string,
  ): boolean =>
    subredditName.trim().replace(/^r\//i, "").toLowerCase() ===
    (appSettings.crosspostAuthoritySubreddit || appSettings.promoSubreddit)
      .trim()
      .replace(/^r\//i, "")
      .toLowerCase(),
  processCrosspostDispatchQueue: hoisted.processCrosspostDispatchQueue,
}));

vi.mock("../data/crosspostData", () => ({
  countPendingCrossposts: hoisted.countPendingCrossposts,
}));

vi.mock("../data/subscriberStats", () => ({
  processSubscriberStatsMigrationBatch:
    hoisted.processSubscriberStatsMigrationBatch,
}));

vi.mock("../data/subscriberDailyStats", () => ({
  observeDailySubscriberCount: hoisted.observeDailySubscriberCount,
  getLastKnownSubscriberCount: hoisted.getLastKnownSubscriberCount,
}));

vi.mock("../data/ctaActivity", () => ({
  ensureCommunityPostActivityBackfill:
    hoisted.ensureCommunityPostActivityBackfill,
}));

vi.mock("../data/postKindMigration", () => ({
  processPostKindMigrationBatch: hoisted.processPostKindMigrationBatch,
}));

vi.mock("../data/legacyAfterSubscribeActionMigration", () => ({
  processLegacyAfterSubscribeActionMigrationBatch:
    hoisted.processLegacyAfterSubscribeActionMigrationBatch,
}));
vi.mock("../data/nsfwAfterSubscribeActionMigration", () => ({
  processNsfwAfterSubscribeActionMigrationBatch:
    hoisted.processNsfwAfterSubscribeActionMigrationBatch,
}));

vi.mock("../data/subGoalData", () => ({
  autoCreateNextGoalSuccessorsKey: "auto_create_next_goal_v1_successors",
  cancelAutoCreateNextGoal: hoisted.cancelAutoCreateNextGoal,
  checkCompletionStatus: hoisted.checkCompletionStatus,
  getSubGoalData: hoisted.getSubGoalData,
  repairAutoCreateNextGoal: hoisted.repairAutoCreateNextGoal,
  processRecentSubscriberIndexMigrationBatch:
    hoisted.processRecentSubscriberIndexMigrationBatch,
}));

vi.mock("../data/updaterData", () => ({
  cancelUpdates: hoisted.cancelUpdates,
  getQueuedUpdates: hoisted.getQueuedUpdates,
  queueUpdate: hoisted.queueUpdate,
  untrackPost: hoisted.untrackPost,
}));

vi.mock("../data/subscriberGoalPostRegistry", () => ({
  removeSubscriberGoalPost: hoisted.removeSubscriberGoalPost,
}));

vi.mock("../utils/textFallback", () => ({
  applyTextFallback: hoisted.applyTextFallback,
}));

vi.mock("../core/autoCreateNextGoal", () => ({
  processDueAutoCreateNextGoals: hoisted.processDueAutoCreateNextGoals,
}));

vi.mock("../core/onboardingSubscriberGoal", () => ({
  onboardingSubscriberGoalStateKey: "onboarding_subscriber_goal_v4_state",
  processDueOnboardingSubscriberGoal:
    hoisted.processDueOnboardingSubscriberGoal,
}));
vi.mock("../core/communityGoalMutation", () => ({
  withCommunityGoalMutationLease: hoisted.withCommunityGoalMutationLease,
}));
vi.mock("../core/postRetirement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/postRetirement")>()),
  retireSubscriberGoalPost: hoisted.retireSubscriberGoalPost,
}));
vi.mock("../data/postOperationalState", () => ({
  getPostOperationalState: hoisted.getPostOperationalState,
  savePostOperationalState: hoisted.savePostOperationalState,
  clearPostOperationalState: hoisted.clearPostOperationalState,
}));
vi.mock("../data/highlightRepair", () => ({
  scheduleHighlightRepair: hoisted.scheduleHighlightRepair,
}));

vi.mock("../core/onboardingReminder", () => ({
  processDueOnboardingReminder: hoisted.processDueOnboardingReminder,
}));

vi.mock("../core/appAccountHealth", () => ({
  processDueAppAccountHealthCheck: hoisted.processDueAppAccountHealthCheck,
}));
vi.mock("../core/appAccountRecovery", () => ({
  processDueAppAccountRecovery: hoisted.processDueAppAccountRecovery,
}));

vi.mock("../core/appRepair", () => ({
  processDueAppRepair: hoisted.processDueAppRepair,
}));
vi.mock("../core/sourcePostDeletion", () => ({
  processDueSourcePostDeletions: hoisted.processDueSourcePostDeletions,
  queueConfirmedSourceDeletionCleanup:
    hoisted.queueConfirmedSourceDeletionCleanup,
}));

vi.mock("../core/post", () => ({
  applyGoalPostFrameStyle: hoisted.applyGoalPostFrameStyle,
}));

import { onPostsUpdaterJob } from "./scheduler";

describe("onPostsUpdaterJob crosspost scheduling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    hoisted.context.subredditName = undefined;
    hoisted.reddit.getCurrentSubreddit.mockReset();
    hoisted.reddit.getPostById.mockReset();
    hoisted.redis.hGet.mockReset();
    hoisted.getAppSettings.mockReset();
    hoisted.processCrosspostDispatchQueue.mockReset();
    hoisted.countPendingCrossposts.mockReset();
    hoisted.processSubscriberStatsMigrationBatch.mockReset();
    hoisted.processPostKindMigrationBatch.mockReset();
    hoisted.processLegacyAfterSubscribeActionMigrationBatch.mockReset();
    hoisted.processNsfwAfterSubscribeActionMigrationBatch.mockReset();
    hoisted.processRecentSubscriberIndexMigrationBatch.mockReset();
    hoisted.processDueAutoCreateNextGoals.mockReset();
    hoisted.processDueOnboardingSubscriberGoal.mockReset();
    hoisted.processDueOnboardingReminder.mockReset();
    hoisted.getQueuedUpdates.mockReset();
    hoisted.queueUpdate.mockReset();
    hoisted.cancelUpdates.mockReset();
    hoisted.untrackPost.mockReset();
    hoisted.cancelAutoCreateNextGoal.mockReset();
    hoisted.getSubGoalData.mockReset();
    hoisted.checkCompletionStatus.mockReset();
    hoisted.repairAutoCreateNextGoal.mockReset();
    hoisted.withCommunityGoalMutationLease.mockReset();
    hoisted.applyTextFallback.mockReset();
    hoisted.applyGoalPostFrameStyle.mockReset();
    hoisted.removeSubscriberGoalPost.mockReset();
    hoisted.observeDailySubscriberCount.mockReset();
    hoisted.getLastKnownSubscriberCount.mockReset();
    hoisted.processDueAppAccountHealthCheck.mockReset();
    hoisted.processDueAppAccountRecovery.mockReset();
    hoisted.processDueAppRepair.mockReset();
    hoisted.retireSubscriberGoalPost.mockReset();
    hoisted.getPostOperationalState.mockReset();
    hoisted.savePostOperationalState.mockReset();
    hoisted.clearPostOperationalState.mockReset();
    hoisted.scheduleHighlightRepair.mockReset();
    hoisted.processDueSourcePostDeletions.mockReset();
    hoisted.queueConfirmedSourceDeletionCleanup.mockReset();
    hoisted.processDueSourcePostDeletions.mockResolvedValue(undefined);
    hoisted.queueConfirmedSourceDeletionCleanup.mockResolvedValue("dispatched");
    hoisted.getPostOperationalState.mockResolvedValue(undefined);
    hoisted.retireSubscriberGoalPost.mockImplementation(
      async (_redis: unknown, postId: string) => {
        await hoisted.cancelUpdates(_redis, postId);
        await hoisted.untrackPost(_redis, postId);
        await hoisted.cancelAutoCreateNextGoal(_redis, postId);
        await hoisted.removeSubscriberGoalPost(_redis, postId);
      },
    );
    hoisted.getAppSettings.mockReturnValue(baseSettings);
    hoisted.processCrosspostDispatchQueue.mockResolvedValue(
      emptyCrosspostSummary,
    );
    hoisted.processPostKindMigrationBatch.mockResolvedValue({});
    hoisted.processLegacyAfterSubscribeActionMigrationBatch.mockResolvedValue(
      {},
    );
    hoisted.processNsfwAfterSubscribeActionMigrationBatch.mockResolvedValue({});
    hoisted.countPendingCrossposts.mockResolvedValue(0);
    hoisted.processSubscriberStatsMigrationBatch.mockResolvedValue(undefined);
    hoisted.processRecentSubscriberIndexMigrationBatch.mockResolvedValue(
      undefined,
    );
    hoisted.processDueAutoCreateNextGoals.mockResolvedValue({
      due: 0,
      created: 0,
      skipped: 0,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });
    hoisted.processDueOnboardingSubscriberGoal.mockResolvedValue({
      status: "not_due",
      trackedInspected: 0,
      highlightedInspected: 0,
      recentInspected: 0,
    });
    hoisted.processDueOnboardingReminder.mockResolvedValue({
      status: "not_due",
      trackedInspected: 0,
      highlightedInspected: 0,
      recentInspected: 0,
    });
    hoisted.getQueuedUpdates.mockResolvedValue([]);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 12,
      recentSubscriber: "",
      completedTime: 0,
      subredditDisplayName: "CorporateGifts",
      colorTheme: "red",
      postHeight: "regular",
      autoCreateNextGoal: true,
      language: "en",
    });
    hoisted.repairAutoCreateNextGoal.mockResolvedValue({
      status: "scheduled",
      runAt: 86_401_000,
      failureCount: 0,
    });
    hoisted.withCommunityGoalMutationLease.mockImplementation(
      async (_redis: unknown, operation: () => Promise<unknown>) => operation(),
    );
    hoisted.redis.hGet.mockResolvedValue(undefined);
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_test",
      name: "CorporateGifts",
      type: "public",
      numberOfSubscribers: 10,
    });
    hoisted.observeDailySubscriberCount.mockResolvedValue({
      growth: { count: 1, period: "week" },
    });
    hoisted.getLastKnownSubscriberCount.mockResolvedValue(null);
    hoisted.processDueAppAccountHealthCheck.mockResolvedValue(undefined);
    hoisted.processDueAppAccountRecovery.mockResolvedValue({ status: "stale" });
    hoisted.processDueAppRepair.mockResolvedValue("not_due");
  });

  it("skips crosspost ingestion and pending-depth lookup outside authority installs", async () => {
    hoisted.context.subredditName = "CorporateGifts";

    await onPostsUpdaterJob();

    expect(hoisted.processCrosspostDispatchQueue).not.toHaveBeenCalled();
    expect(hoisted.countPendingCrossposts).not.toHaveBeenCalled();
    expect(hoisted.processSubscriberStatsMigrationBatch).toHaveBeenCalled();
    expect(hoisted.observeDailySubscriberCount).toHaveBeenCalledWith(
      expect.anything(),
      10,
    );
    expect(
      hoisted.processLegacyAfterSubscribeActionMigrationBatch,
    ).toHaveBeenCalledWith(expect.anything(), {
      name: "CorporateGifts",
      type: "public",
    });
    expect(
      hoisted.processRecentSubscriberIndexMigrationBatch,
    ).toHaveBeenCalled();
    expect(hoisted.processDueOnboardingSubscriberGoal).toHaveBeenCalledWith({
      reddit: hoisted.reddit,
      redis: expect.anything(),
      appSettings: baseSettings,
    });
    expect(hoisted.processDueOnboardingReminder).toHaveBeenCalledWith({
      reddit: hoisted.reddit,
      redis: expect.anything(),
    });
  });

  it("records the aggregate total even with no queued posts", async () => {
    hoisted.context.subredditName = "CorporateGifts";

    await onPostsUpdaterJob();

    expect(hoisted.observeDailySubscriberCount).toHaveBeenCalledWith(
      expect.anything(),
      10,
    );
    expect(hoisted.getQueuedUpdates).toHaveBeenCalledOnce();
  });

  it("runs recovery before subreddit work and stops while access is missing", async () => {
    hoisted.processDueAppAccountRecovery.mockResolvedValue({
      status: "missing",
    });

    await onPostsUpdaterJob();

    expect(hoisted.processDueAppAccountRecovery).toHaveBeenCalledOnce();
    expect(hoisted.reddit.getCurrentSubreddit).not.toHaveBeenCalled();
    expect(hoisted.processDueAppAccountHealthCheck).not.toHaveBeenCalled();
    expect(hoisted.processDueAppRepair).not.toHaveBeenCalled();
    expect(hoisted.getQueuedUpdates).not.toHaveBeenCalled();
  });

  it("isolates aggregate observation failures from the remaining scheduler", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.observeDailySubscriberCount.mockRejectedValue(
      new Error("redis unavailable"),
    );

    await expect(onPostsUpdaterJob()).resolves.toBeUndefined();

    expect(hoisted.processSubscriberStatsMigrationBatch).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /scheduler_task_failed.*subscriber_daily_stats.*redis unavailable.*stack/,
      ),
    );
  });

  it("isolates the aggregate Reddit lookup when no posts need updating", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.reddit.getCurrentSubreddit.mockRejectedValue(
      new Error("reddit unavailable"),
    );

    await expect(onPostsUpdaterJob()).resolves.toBeUndefined();

    expect(hoisted.observeDailySubscriberCount).not.toHaveBeenCalled();
    expect(hoisted.processSubscriberStatsMigrationBatch).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /scheduler_task_failed.*subscriber_daily_stats.*reddit unavailable.*stack/,
      ),
    );
  });

  it("runs crosspost ingestion from the authority install", async () => {
    hoisted.context.subredditName = "SubGoal";

    await onPostsUpdaterJob();

    expect(hoisted.processCrosspostDispatchQueue).toHaveBeenCalledWith(
      baseSettings,
      "scheduler_posts_updater",
    );
    expect(hoisted.countPendingCrossposts).toHaveBeenCalledWith(
      expect.anything(),
      "SubGoal",
    );
  });

  it("cleans up moderator-removed posts without updating or requeueing", async () => {
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_removed"]);
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_removed",
      removedByCategory: "moderator",
    });

    await onPostsUpdaterJob();

    expect(hoisted.cancelUpdates).toHaveBeenCalledWith(
      expect.anything(),
      "t3_removed",
    );
    expect(hoisted.queueConfirmedSourceDeletionCleanup).not.toHaveBeenCalled();
    expect(hoisted.untrackPost).toHaveBeenCalledWith(
      expect.anything(),
      "t3_removed",
    );
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(
      expect.anything(),
      "t3_removed",
    );
    expect(hoisted.removeSubscriberGoalPost).toHaveBeenCalledWith(
      expect.anything(),
      "t3_removed",
    );
    expect(hoisted.applyTextFallback).not.toHaveBeenCalled();
    expect(hoisted.queueUpdate).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      "[updater] cleaned up inactive post: postId=t3_removed reason=removedByCategory:moderator",
    );
  });

  it("cleans up deleted posts without updating or requeueing", async () => {
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_deleted"]);
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_deleted",
      removedByCategory: "deleted",
    });

    await onPostsUpdaterJob();

    expect(hoisted.cancelUpdates).toHaveBeenCalledWith(
      expect.anything(),
      "t3_deleted",
    );
    expect(hoisted.queueConfirmedSourceDeletionCleanup).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      baseSettings,
      {
        postId: "t3_deleted",
        subredditId: "t5_test",
        subredditName: "CorporateGifts",
      },
    );
    expect(hoisted.untrackPost).toHaveBeenCalledWith(
      expect.anything(),
      "t3_deleted",
    );
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(
      expect.anything(),
      "t3_deleted",
    );
    expect(hoisted.applyTextFallback).not.toHaveBeenCalled();
    expect(hoisted.queueUpdate).not.toHaveBeenCalled();
  });

  it("updates and requeues active posts with no removedByCategory", async () => {
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_active"]);
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_active",
      removedByCategory: undefined,
    });

    await onPostsUpdaterJob();

    expect(hoisted.applyTextFallback).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t3_active" }),
      expect.objectContaining({
        goal: 12,
        subscribers: 10,
        subredditName: "CorporateGifts",
      }),
    );
    expect(hoisted.queueUpdate).toHaveBeenCalledWith(
      expect.anything(),
      "t3_active",
      expect.any(Date),
    );
    expect(hoisted.applyGoalPostFrameStyle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t3_active" }),
      "regular",
    );
    expect(hoisted.cancelUpdates).not.toHaveBeenCalled();
    expect(hoisted.untrackPost).not.toHaveBeenCalled();
    expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
  });

  it("skips rendering an archived goal while preserving completion checks", async () => {
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      name: "CorporateGifts",
      type: "public",
      numberOfSubscribers: 20,
    });
    hoisted.checkCompletionStatus.mockResolvedValue(1_000);
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_archived"]);
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_archived",
      archived: true,
      locked: false,
    });

    await onPostsUpdaterJob();

    expect(hoisted.checkCompletionStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "t3_archived",
    );
    expect(hoisted.applyTextFallback).not.toHaveBeenCalled();
    expect(hoisted.applyGoalPostFrameStyle).not.toHaveBeenCalled();
    expect(hoisted.savePostOperationalState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        postId: "t3_archived",
        archived: true,
      }),
    );
    expect(hoisted.cancelUpdates).toHaveBeenCalledWith(
      expect.anything(),
      "t3_archived",
    );
  });

  it("continues rendering a locked goal without unlocking it", async () => {
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_locked"]);
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_locked",
      archived: false,
      locked: true,
    });

    await onPostsUpdaterJob();

    expect(hoisted.applyTextFallback).toHaveBeenCalled();
    expect(hoisted.applyGoalPostFrameStyle).toHaveBeenCalled();
    expect(hoisted.savePostOperationalState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ locked: true, archived: false }),
    );
  });

  it("repairs short post frame styles for active queued posts", async () => {
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_short"]);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 12,
      recentSubscriber: "",
      completedTime: 0,
      subredditDisplayName: "CorporateGifts",
      colorTheme: "red",
      postHeight: "short",
      autoCreateNextGoal: true,
      language: "en",
    });
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_short",
      removedByCategory: undefined,
    });

    await onPostsUpdaterJob();

    expect(hoisted.applyGoalPostFrameStyle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t3_short" }),
      "short",
    );
    expect(hoisted.queueUpdate).toHaveBeenCalledWith(
      expect.anything(),
      "t3_short",
      expect.any(Date),
    );
  });

  it("cleans up missing posts returned as deleted/not-found errors", async () => {
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_missing"]);
    hoisted.reddit.getPostById.mockRejectedValue(
      Object.assign(new Error("post not found"), { status: 404 }),
    );

    await onPostsUpdaterJob();

    expect(hoisted.cancelUpdates).toHaveBeenCalledWith(
      expect.anything(),
      "t3_missing",
    );
    expect(hoisted.queueConfirmedSourceDeletionCleanup).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      baseSettings,
      {
        postId: "t3_missing",
        subredditId: "t5_test",
        subredditName: "CorporateGifts",
      },
    );
    expect(hoisted.untrackPost).toHaveBeenCalledWith(
      expect.anything(),
      "t3_missing",
    );
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(
      expect.anything(),
      "t3_missing",
    );
    expect(hoisted.queueUpdate).not.toHaveBeenCalled();
  });

  it("keeps transient post lookup errors queued for retry", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_retry"]);
    hoisted.reddit.getPostById.mockRejectedValue(
      new Error("503 Service Unavailable"),
    );

    await onPostsUpdaterJob();

    expect(hoisted.cancelUpdates).not.toHaveBeenCalled();
    expect(hoisted.untrackPost).not.toHaveBeenCalled();
    expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /scheduler_post_update_failed.*t3_retry.*503 Service Unavailable.*stack/,
      ),
    );
  });

  it("cleans up invalid post ids from queue and tracking", async () => {
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.getQueuedUpdates.mockResolvedValue(["bad_id"]);

    await onPostsUpdaterJob();

    expect(hoisted.cancelUpdates).toHaveBeenCalledWith(
      expect.anything(),
      "bad_id",
    );
    expect(hoisted.untrackPost).toHaveBeenCalledWith(
      expect.anything(),
      "bad_id",
    );
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(
      expect.anything(),
      "bad_id",
    );
    expect(hoisted.reddit.getPostById).not.toHaveBeenCalled();
  });

  it("renders and requeues posts with emergency goal data", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_no_goal"]);
    hoisted.reddit.getPostById.mockResolvedValue({ id: "t3_no_goal" });
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "subscriber-goal-v1",
      goal: 0,
      recentSubscriber: "",
      completedTime: 0,
      subredditDisplayName: "CorporateGifts",
      colorTheme: "red",
      postHeight: "regular",
      autoCreateNextGoal: true,
      language: "en",
    });

    await onPostsUpdaterJob();

    expect(hoisted.cancelUpdates).not.toHaveBeenCalled();
    expect(hoisted.untrackPost).not.toHaveBeenCalled();
    expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
    expect(hoisted.applyTextFallback).toHaveBeenCalledWith(
      { id: "t3_no_goal" },
      expect.objectContaining({ goal: 15, subscribers: 10 }),
    );
    expect(hoisted.queueUpdate).toHaveBeenCalledWith(
      expect.anything(),
      "t3_no_goal",
      expect.any(Date),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /subscriber_goal_emergency_fallback.*post_update.*t3_no_goal.*"recoveredGoal":15/,
      ),
    );
  });

  it("repairs successor work for a goal completed on the current tick before cleanup", async () => {
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      name: "CorporateGifts",
      type: "public",
      numberOfSubscribers: 12,
    });
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_completed_now"]);
    hoisted.reddit.getPostById.mockResolvedValue({ id: "t3_completed_now" });
    hoisted.checkCompletionStatus.mockResolvedValue(1_000);
    hoisted.getSubGoalData
      .mockResolvedValueOnce({
        goal: 12,
        completedTime: 0,
        autoCreateNextGoal: true,
        postHeight: "regular",
        colorTheme: "red",
        language: "en",
      })
      .mockResolvedValue({
        goal: 12,
        completedTime: 1_000,
        autoCreateNextGoal: true,
        postHeight: "regular",
        colorTheme: "red",
        language: "en",
      });

    await onPostsUpdaterJob();

    expect(hoisted.repairAutoCreateNextGoal).toHaveBeenCalledWith(
      expect.anything(),
      "t3_completed_now",
      1_000,
    );
    expect(hoisted.cancelUpdates).toHaveBeenCalledWith(
      expect.anything(),
      "t3_completed_now",
    );
  });

  it("keeps a completed source queued after repair failure and cleans it on a successful tick", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_stranded"]);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 12,
      completedTime: 1_000,
      autoCreateNextGoal: true,
      postHeight: "regular",
      colorTheme: "red",
      language: "en",
    });
    hoisted.reddit.getPostById.mockResolvedValue({ id: "t3_stranded" });
    hoisted.repairAutoCreateNextGoal
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockResolvedValueOnce({
        status: "scheduled",
        runAt: 86_401_000,
        failureCount: 0,
      });

    await onPostsUpdaterJob();
    expect(hoisted.cancelUpdates).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /scheduler_post_update_failed.*auto_successor_repair.*t3_stranded.*redis unavailable.*stack/,
      ),
    );

    await onPostsUpdaterJob();
    expect(hoisted.repairAutoCreateNextGoal).toHaveBeenCalledTimes(2);
    expect(hoisted.cancelUpdates).toHaveBeenCalledWith(
      expect.anything(),
      "t3_stranded",
    );
  });

  it("rechecks repaired work when completed-source cleanup fails", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_cleanup_retry"]);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 12,
      completedTime: 1_000,
      autoCreateNextGoal: true,
      postHeight: "regular",
      colorTheme: "red",
      language: "en",
    });
    hoisted.reddit.getPostById.mockResolvedValue({ id: "t3_cleanup_retry" });
    hoisted.cancelUpdates
      .mockRejectedValueOnce(new Error("cleanup unavailable"))
      .mockResolvedValueOnce(undefined);

    await onPostsUpdaterJob();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /scheduler_post_update_failed.*completed_update_cleanup.*t3_cleanup_retry.*cleanup unavailable.*stack/,
      ),
    );
    await onPostsUpdaterJob();

    expect(hoisted.repairAutoCreateNextGoal).toHaveBeenCalledTimes(2);
    expect(hoisted.cancelUpdates).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["disabled", false, undefined, undefined],
    ["superseded", true, "t3_successor", undefined],
    [
      "onboarding takeover",
      true,
      undefined,
      {
        intent: "orphaned_completed_goal",
        replacementSourcePostId: "t3_terminal",
        status: "pending",
      },
    ],
  ])(
    "respects %s completed-source decisions",
    async (_label, autoCreateNextGoal, successor, onboarding) => {
      hoisted.context.subredditName = "CorporateGifts";
      hoisted.getQueuedUpdates.mockResolvedValue(["t3_terminal"]);
      hoisted.getSubGoalData.mockResolvedValue({
        goal: 12,
        completedTime: 1_000,
        autoCreateNextGoal,
        postHeight: "regular",
        colorTheme: "red",
        language: "en",
      });
      hoisted.reddit.getPostById.mockResolvedValue({ id: "t3_terminal" });
      hoisted.redis.hGet.mockImplementation(
        async (key: string, field: string) => {
          if (key === "auto_create_next_goal_v1_successors") return successor;
          return onboarding?.[field as keyof typeof onboarding];
        },
      );

      await onPostsUpdaterJob();

      expect(hoisted.repairAutoCreateNextGoal).not.toHaveBeenCalled();
      expect(hoisted.cancelUpdates).toHaveBeenCalledWith(
        expect.anything(),
        "t3_terminal",
      );
    },
  );

  it("preserves exhausted successor state while cleaning the completed source", async () => {
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_exhausted"]);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 12,
      completedTime: 1_000,
      autoCreateNextGoal: true,
      postHeight: "regular",
      colorTheme: "red",
      language: "en",
    });
    hoisted.reddit.getPostById.mockResolvedValue({ id: "t3_exhausted" });
    hoisted.repairAutoCreateNextGoal.mockResolvedValue({
      status: "exhausted",
      failureCount: 6,
    });

    await onPostsUpdaterJob();

    expect(hoisted.cancelUpdates).toHaveBeenCalledWith(
      expect.anything(),
      "t3_exhausted",
    );
  });

  it.each(["onboarding_reconciliation", "unknown"])(
    "does not repair a completed source with %s successor suppression",
    async (automaticSuccessorSuppression) => {
      hoisted.context.subredditName = "CorporateGifts";
      hoisted.getQueuedUpdates.mockResolvedValue(["t3_suppressed"]);
      hoisted.getSubGoalData.mockResolvedValue({
        goal: 12,
        completedTime: 1_000,
        autoCreateNextGoal: true,
        automaticSuccessorSuppression,
        postHeight: "regular",
        colorTheme: "red",
        language: "en",
      });
      hoisted.reddit.getPostById.mockResolvedValue({ id: "t3_suppressed" });

      await onPostsUpdaterJob();

      expect(hoisted.repairAutoCreateNextGoal).not.toHaveBeenCalled();
      expect(hoisted.cancelUpdates).toHaveBeenCalledWith(
        expect.anything(),
        "t3_suppressed",
      );
    },
  );

  it("does not perform a stale repair after overlapping work maps a successor", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_overlap"]);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 12,
      completedTime: 1_000,
      autoCreateNextGoal: true,
      postHeight: "regular",
      colorTheme: "red",
      language: "en",
    });
    hoisted.reddit.getPostById.mockResolvedValue({ id: "t3_overlap" });
    hoisted.withCommunityGoalMutationLease
      .mockRejectedValueOnce(new Error("community mutation in progress"))
      .mockImplementationOnce(
        async (_redis: unknown, operation: () => Promise<unknown>) =>
          operation(),
      );

    await onPostsUpdaterJob();
    expect(hoisted.cancelUpdates).not.toHaveBeenCalled();

    hoisted.redis.hGet.mockImplementation(async (key: string) =>
      key === "auto_create_next_goal_v1_successors"
        ? "t3_newer_successor"
        : undefined,
    );
    await onPostsUpdaterJob();

    expect(hoisted.repairAutoCreateNextGoal).not.toHaveBeenCalled();
    expect(hoisted.cancelUpdates).toHaveBeenCalledOnce();
  });
});
