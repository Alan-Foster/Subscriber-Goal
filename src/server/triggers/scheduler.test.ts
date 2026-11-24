import { FakeRedisImpl } from "../testing/faultHarness";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAppSettings } from "../settings";
import { goalHealthThrottleKey } from "../core/goalHealth";

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
    getAppUser: vi.fn(),
  },
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    hGet: vi.fn(),
    hGetAll: vi.fn(),
    hSet: vi.fn(),
    del: vi.fn(),
  },
  getAppSettings: vi.fn(),
  processCrosspostDispatchQueue: vi.fn(),
  countPendingCrossposts: vi.fn(),
  processPostKindMigrationBatch: vi.fn(),
  processLegacyAfterSubscribeActionMigrationBatch: vi.fn(),
  dispatchAutomaticGoalRetryJob: vi.fn(),
  processDueOnboardingSubscriberGoal: vi.fn(),
  processDueOnboardingReminder: vi.fn(),
  getQueuedUpdates: vi.fn(),
  queueUpdate: vi.fn(),
  cancelUpdates: vi.fn(),
  untrackPost: vi.fn(),
  cancelAutoCreateNextGoal: vi.fn(),
  clearAutomaticSuccessorSuppression: vi.fn(),
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
  resolveAppAccountHealthGate: vi.fn(),
  resolveAppAccountRecoveryGate: vi.fn(),
  dispatchScheduledJobs: vi.fn(),
  retireSubscriberGoalPost: vi.fn(),
  getPostOperationalState: vi.fn(),
  savePostOperationalState: vi.fn(),
  clearPostOperationalState: vi.fn(),
  scheduleHighlightRepair: vi.fn(),
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

vi.mock("../crosspost/bookkeeping", () => ({
  isCrosspostAuthorityInstall: (
    appSettings: ServerAppSettings,
    subredditName: string,
  ): boolean =>
    subredditName.trim().replace(/^r\//i, "").toLowerCase() ===
    (appSettings.crosspostAuthoritySubreddit || appSettings.promoSubreddit)
      .trim()
      .replace(/^r\//i, "")
      .toLowerCase(),
}));

vi.mock("../crosspost/dispatch", () => ({
  processCrosspostDispatchQueue: hoisted.processCrosspostDispatchQueue,
}));

vi.mock("../data/crosspostData", () => ({
  countPendingCrossposts: hoisted.countPendingCrossposts,
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
vi.mock("../data/subGoalData", () => ({
  autoCreateNextGoalSuccessorsKey: "auto_create_next_goal_v1_successors",
  cancelAutoCreateNextGoal: hoisted.cancelAutoCreateNextGoal,
  clearAutomaticSuccessorSuppression:
    hoisted.clearAutomaticSuccessorSuppression,
  checkCompletionStatus: hoisted.checkCompletionStatus,
  getSubGoalData: hoisted.getSubGoalData,
  repairAutoCreateNextGoal: hoisted.repairAutoCreateNextGoal,
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

vi.mock("../jobs/automaticGoalRetry", () => ({
  dispatchAutomaticGoalRetryJob: hoisted.dispatchAutomaticGoalRetryJob,
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

vi.mock("../jobs/onboarding", async () => ({
  dispatchOnboardingJob: (await import("../core/onboarding"))
    .processDueOnboarding,
}));

vi.mock("../core/onboardingWarning", () => ({
  processDueOnboardingReminder: hoisted.processDueOnboardingReminder,
}));

vi.mock("../jobs/appAccountHealth", () => ({
  resolveAppAccountHealthGate: hoisted.resolveAppAccountHealthGate,
}));
vi.mock("../jobs/appAccountRecovery", () => ({
  resolveAppAccountRecoveryGate: hoisted.resolveAppAccountRecoveryGate,
}));

vi.mock("../jobs/scheduled", () => ({
  dispatchScheduledJobs: hoisted.dispatchScheduledJobs,
}));
vi.mock("../core/sourcePostDeletion", () => ({
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
    hoisted.redis.get.mockReset();
    hoisted.redis.get.mockImplementation(async (key: string) =>
      key === goalHealthThrottleKey
        ? JSON.stringify({ checkedAt: Date.now() })
        : undefined,
    );
    hoisted.redis.set.mockReset();
    hoisted.redis.hGet.mockReset();
    hoisted.redis.hGetAll.mockReset();
    hoisted.redis.hSet.mockReset();
    hoisted.redis.del.mockReset();
    hoisted.reddit.getAppUser.mockReset();
    hoisted.getAppSettings.mockReset();
    hoisted.processCrosspostDispatchQueue.mockReset();
    hoisted.countPendingCrossposts.mockReset();
    hoisted.processPostKindMigrationBatch.mockReset();
    hoisted.processLegacyAfterSubscribeActionMigrationBatch.mockReset();
    hoisted.dispatchAutomaticGoalRetryJob.mockReset();
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
    hoisted.resolveAppAccountHealthGate.mockReset();
    hoisted.resolveAppAccountRecoveryGate.mockReset();
    hoisted.dispatchScheduledJobs.mockReset();
    hoisted.retireSubscriberGoalPost.mockReset();
    hoisted.getPostOperationalState.mockReset();
    hoisted.savePostOperationalState.mockReset();
    hoisted.clearPostOperationalState.mockReset();
    hoisted.scheduleHighlightRepair.mockReset();
    hoisted.queueConfirmedSourceDeletionCleanup.mockReset();
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
    hoisted.countPendingCrossposts.mockResolvedValue(0);
    hoisted.dispatchAutomaticGoalRetryJob.mockResolvedValue(undefined);
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
    hoisted.resolveAppAccountHealthGate.mockResolvedValue(undefined);
    hoisted.resolveAppAccountRecoveryGate.mockResolvedValue({
      status: "stale",
    });
    hoisted.dispatchScheduledJobs.mockResolvedValue(undefined);
  });

  it("skips crosspost ingestion and pending-depth lookup outside authority installs", async () => {
    hoisted.context.subredditName = "CorporateGifts";

    await onPostsUpdaterJob();

    expect(hoisted.processCrosspostDispatchQueue).not.toHaveBeenCalled();
    expect(hoisted.countPendingCrossposts).not.toHaveBeenCalled();
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
    expect(hoisted.processDueOnboardingSubscriberGoal).toHaveBeenCalledWith({
      reddit: hoisted.reddit,
      redis: expect.anything(),
      appSettings: baseSettings,
      nowMs: expect.any(Number),
      canStart: expect.any(Function),
    });
    expect(hoisted.processDueOnboardingReminder).toHaveBeenCalledWith({
      reddit: hoisted.reddit,
      redis: expect.anything(),
      nowMs: expect.any(Number),
      canStart: expect.any(Function),
    });
  });

  it("runs the legacy after-subscribe migration during an NSFW scheduler tick", async () => {
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      name: "CorporateGifts",
      type: "public",
      nsfw: true,
      numberOfSubscribers: 10,
    });
    await onPostsUpdaterJob();
    expect(
      hoisted.processLegacyAfterSubscribeActionMigrationBatch,
    ).toHaveBeenCalledOnce();
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

  it("continues independent work while permission-dependent queues wait, then resumes", async () => {
    hoisted.resolveAppAccountRecoveryGate.mockResolvedValue({
      status: "missing",
    });

    await onPostsUpdaterJob();

    expect(hoisted.resolveAppAccountRecoveryGate).toHaveBeenCalledOnce();
    expect(hoisted.observeDailySubscriberCount).toHaveBeenCalled();
    expect(hoisted.processDueOnboardingReminder).toHaveBeenCalled();
    expect(hoisted.resolveAppAccountHealthGate).not.toHaveBeenCalled();
    expect(hoisted.dispatchScheduledJobs).not.toHaveBeenCalled();
    expect(hoisted.processDueOnboardingSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.dispatchAutomaticGoalRetryJob).not.toHaveBeenCalled();
    expect(hoisted.getQueuedUpdates).toHaveBeenCalled();
    expect(hoisted.cancelUpdates).not.toHaveBeenCalled();
    expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();

    hoisted.resolveAppAccountRecoveryGate.mockResolvedValue({
      status: "healthy",
    });
    await onPostsUpdaterJob();
    expect(hoisted.dispatchScheduledJobs).toHaveBeenCalledOnce();
    expect(hoisted.dispatchScheduledJobs).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      baseSettings,
      expect.any(Number),
      expect.objectContaining({ name: "CorporateGifts" }),
    );
    expect(hoisted.processDueOnboardingSubscriberGoal).toHaveBeenCalledOnce();
    expect(hoisted.dispatchAutomaticGoalRetryJob).toHaveBeenCalledOnce();
  });

  it("defers runner work when earlier scheduler work spends the budget", async () => {
    const startedAt = Date.now();
    let now = startedAt;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    hoisted.resolveAppAccountHealthGate.mockImplementationOnce(async () => {
      now = startedAt + 20_000;
      return { healthy: true };
    });
    try {
      await onPostsUpdaterJob();
      expect(hoisted.resolveAppAccountHealthGate).toHaveBeenCalledOnce();
      expect(hoisted.dispatchScheduledJobs).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    "pending",
    "processing",
    "locked",
    "not_due",
    "insufficient_permissions",
    "verification_failed",
  ])(
    "defers posting during %s recovery while detecting goal completion",
    async (status) => {
      hoisted.resolveAppAccountRecoveryGate.mockResolvedValue({ status });
      hoisted.context.subredditName = "SubGoal";
      hoisted.getQueuedUpdates.mockResolvedValue(["t3_goal"]);
      hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_test",
        name: "SubGoal",
        numberOfSubscribers: 20,
      });
      hoisted.reddit.getPostById.mockResolvedValue({});
      hoisted.checkCompletionStatus.mockResolvedValue(1_000);
      await onPostsUpdaterJob();
      expect(hoisted.checkCompletionStatus).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "t3_goal",
      );
      expect(hoisted.applyTextFallback).toHaveBeenCalled();
      expect(hoisted.dispatchAutomaticGoalRetryJob).not.toHaveBeenCalled();
      expect(hoisted.processDueOnboardingSubscriberGoal).not.toHaveBeenCalled();
      expect(hoisted.dispatchScheduledJobs).not.toHaveBeenCalled();
      expect(hoisted.processCrosspostDispatchQueue).not.toHaveBeenCalled();
    },
  );

  it.each(["unknown", "unhealthy", "throw"])(
    "keeps dependent work queued for a %s health result",
    async (status) => {
      if (status === "throw")
        hoisted.resolveAppAccountHealthGate.mockRejectedValue(
          new Error("lookup failed"),
        );
      else
        hoisted.resolveAppAccountHealthGate.mockResolvedValue({
          status,
          healthy: false,
        });
      await onPostsUpdaterJob();
      expect(hoisted.dispatchScheduledJobs).not.toHaveBeenCalled();
      expect(hoisted.dispatchAutomaticGoalRetryJob).not.toHaveBeenCalled();
      expect(hoisted.observeDailySubscriberCount).toHaveBeenCalled();
    },
  );

  it.each(["posts", "all"])(
    "resumes gated work after exhausted health retries verify %s through the real health worker",
    async (permission) => {
      const health = await vi.importActual<
        typeof import("../core/appAccountHealth")
      >("../core/appAccountHealth");
      const { resolveAppAccountHealthGate } = await vi.importActual<
        typeof import("../jobs/appAccountHealth")
      >("../jobs/appAccountHealth");
      const redis = new FakeRedisImpl();
      await redis.hSet(health.appAccountHealthRetryStateKey, {
        status: "exhausted",
        attempts: "3",
        nextRunAt: "1000",
        subredditName: "CorporateGifts",
        lastError: "missing_posts_permission",
      });
      await redis.hSet(health.appAccountHealthStateKey, {
        status: "unhealthy",
      });
      await redis.hSet("app_account_recovery_v1_state", {
        status: "healthy",
        incidentToken: "existing",
      });
      hoisted.resolveAppAccountRecoveryGate.mockResolvedValue({
        status: "healthy",
      });
      hoisted.resolveAppAccountHealthGate.mockImplementation((args) =>
        resolveAppAccountHealthGate({ ...args, redis: redis as never }),
      );
      hoisted.reddit.getAppUser.mockResolvedValue({
        username: "subscriber-goal",
        getModPermissionsForSubreddit: async () => [permission],
      });
      const now = vi.spyOn(Date, "now").mockReturnValue(999);
      await onPostsUpdaterJob();
      expect(hoisted.reddit.getAppUser).not.toHaveBeenCalled();
      expect(hoisted.dispatchScheduledJobs).not.toHaveBeenCalled();
      expect(hoisted.dispatchAutomaticGoalRetryJob).not.toHaveBeenCalled();
      expect(hoisted.processDueOnboardingSubscriberGoal).not.toHaveBeenCalled();
      expect(hoisted.observeDailySubscriberCount).toHaveBeenCalledOnce();

      now.mockReturnValue(1000);
      await onPostsUpdaterJob();
      expect(hoisted.reddit.getAppUser).toHaveBeenCalledOnce();
      expect(await redis.hGetAll(health.appAccountHealthRetryStateKey)).toEqual(
        {},
      );
      expect(hoisted.scheduleHighlightRepair).toHaveBeenCalledOnce();
      expect(hoisted.dispatchScheduledJobs).toHaveBeenCalledOnce();
      expect(hoisted.dispatchAutomaticGoalRetryJob).toHaveBeenCalledOnce();
      expect(hoisted.processDueOnboardingSubscriberGoal).toHaveBeenCalledOnce();

      now.mockReturnValue(2000);
      await onPostsUpdaterJob();
      expect(hoisted.reddit.getAppUser).toHaveBeenCalledOnce();
      expect(hoisted.scheduleHighlightRepair).toHaveBeenCalledOnce();
      expect(hoisted.dispatchAutomaticGoalRetryJob).toHaveBeenCalledTimes(2);
    },
  );

  it("isolates aggregate observation failures from the remaining scheduler", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.context.subredditName = "CorporateGifts";
    hoisted.observeDailySubscriberCount.mockRejectedValue(
      new Error("redis unavailable"),
    );

    await expect(onPostsUpdaterJob()).resolves.toBeUndefined();

    expect(hoisted.processPostKindMigrationBatch).toHaveBeenCalledOnce();
    expect(hoisted.redis.hGetAll).not.toHaveBeenCalledWith(
      "subscriber_stats_migration_state",
    );
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(
        /scheduler_task_failed.*(?:subscriber_stats_migration|recent_subscriber_migration)/,
      ),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /scheduler_task_failed.*subscriber_daily_stats.*redis unavailable.*stack/,
      ),
    );
  });

  it("runs the health check after normal updater work and isolates diagnostic failures", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    hoisted.redis.get.mockImplementation(async (key: string) => {
      if (key === goalHealthThrottleKey)
        throw new Error("diagnostic read unavailable");
      return undefined;
    });

    await expect(onPostsUpdaterJob()).resolves.toBeUndefined();

    expect(hoisted.getQueuedUpdates).toHaveBeenCalledOnce();
    expect(hoisted.getQueuedUpdates).toHaveBeenCalledBefore(warning);
    expect(hoisted.dispatchAutomaticGoalRetryJob).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(
        /goal_health_check_failed.*diagnostic read unavailable/,
      ),
    );
    expect(hoisted.reddit.getCurrentSubreddit).toHaveBeenCalledOnce();
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
    expect(hoisted.processPostKindMigrationBatch).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /scheduler_task_failed.*subscriber_daily_stats.*reddit unavailable.*stack/,
      ),
    );
  });

  it.each(["dispatch", "pending_depth"])(
    "isolates crosspost %s failure and continues the same scheduler tick",
    async (phase) => {
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      hoisted.context.subredditName = "SubGoal";
      const failure = new Error(`crosspost ${phase} unavailable`);
      if (phase === "dispatch")
        hoisted.processCrosspostDispatchQueue.mockRejectedValue(failure);
      else hoisted.countPendingCrossposts.mockRejectedValue(failure);
      hoisted.getQueuedUpdates.mockResolvedValue(["t3_active"]);
      hoisted.reddit.getPostById.mockResolvedValue({ id: "t3_active" });

      await expect(onPostsUpdaterJob()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(
            `scheduler_task_failed.*crosspost_dispatch.*crosspost ${phase} unavailable.*stack`,
          ),
        ),
      );
      expect(
        hoisted.processCrosspostDispatchQueue,
      ).toHaveBeenCalledExactlyOnceWith(
        baseSettings,
        "scheduler_posts_updater",
        expect.any(Number),
      );
      expect(hoisted.countPendingCrossposts).toHaveBeenCalledTimes(
        phase === "dispatch" ? 0 : 1,
      );
      expect(hoisted.processPostKindMigrationBatch).toHaveBeenCalledOnce();
      expect(hoisted.processDueOnboardingSubscriberGoal).toHaveBeenCalledOnce();
      expect(hoisted.dispatchAutomaticGoalRetryJob).toHaveBeenCalledOnce();
      expect(hoisted.applyTextFallback).toHaveBeenCalledOnce();
      expect(hoisted.applyGoalPostFrameStyle).toHaveBeenCalledOnce();
      expect(hoisted.queueUpdate).toHaveBeenCalledWith(
        hoisted.redis,
        "t3_active",
        expect.any(Date),
      );
    },
  );

  it("skips crosspost dispatch and depth reads on a permission-gated authority tick", async () => {
    hoisted.context.subredditName = "SubGoal";
    hoisted.resolveAppAccountRecoveryGate.mockResolvedValue({
      status: "missing",
    });
    await onPostsUpdaterJob();
    expect(hoisted.processCrosspostDispatchQueue).not.toHaveBeenCalled();
    expect(hoisted.countPendingCrossposts).not.toHaveBeenCalled();
    expect(hoisted.processPostKindMigrationBatch).toHaveBeenCalledOnce();
  });

  it("runs crosspost ingestion from the authority install", async () => {
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    hoisted.context.subredditName = "SubGoal";
    hoisted.countPendingCrossposts.mockResolvedValue(1);

    await onPostsUpdaterJob();

    expect(hoisted.dispatchScheduledJobs).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      baseSettings,
      expect.any(Number),
      undefined,
    );
    expect(hoisted.processCrosspostDispatchQueue).toHaveBeenCalledWith(
      baseSettings,
      "scheduler_posts_updater",
      expect.any(Number),
    );
    expect(hoisted.countPendingCrossposts).toHaveBeenCalledWith(
      expect.anything(),
      "SubGoal",
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[crosspost\] scheduler ingestion summary: status=success.*pendingDepth=1 error=none/,
      ),
    );
  });

  it.each([
    "moderator",
    "automod_filtered",
    "reddit",
    "community_ops",
    "new_remover",
  ])(
    "pauses %s removal without losing queued work, then resumes when active",
    async (category) => {
      hoisted.context.subredditName = "CorporateGifts";
      hoisted.getQueuedUpdates.mockResolvedValue(["t3_removed"]);
      const post = {
        id: "t3_removed",
        removedByCategory: category as string | undefined,
      };
      hoisted.reddit.getPostById.mockResolvedValue(post);
      await onPostsUpdaterJob();
      expect(hoisted.retireSubscriberGoalPost).not.toHaveBeenCalled();
      expect(hoisted.cancelUpdates).not.toHaveBeenCalled();
      expect(hoisted.untrackPost).not.toHaveBeenCalled();
      expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
      expect(hoisted.removeSubscriberGoalPost).not.toHaveBeenCalled();
      expect(
        hoisted.queueConfirmedSourceDeletionCleanup,
      ).not.toHaveBeenCalled();
      expect(hoisted.applyTextFallback).not.toHaveBeenCalled();
      expect(hoisted.applyGoalPostFrameStyle).not.toHaveBeenCalled();
      expect(hoisted.queueUpdate).not.toHaveBeenCalled();
      post.removedByCategory = undefined;
      await onPostsUpdaterJob();
      expect(hoisted.applyTextFallback).toHaveBeenCalledOnce();
      expect(hoisted.applyGoalPostFrameStyle).toHaveBeenCalledOnce();
      expect(hoisted.queueUpdate).toHaveBeenCalledWith(
        expect.anything(),
        "t3_removed",
        expect.any(Date),
      );
      expect(hoisted.retireSubscriberGoalPost).not.toHaveBeenCalled();
    },
  );

  it.each(["moderator", "content_takedown"])(
    "rechecks %s-removed completed posts hourly while retaining queued work",
    async (category) => {
      let clock = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      const values = new Map<string, string>();
      hoisted.redis.get.mockImplementation(async (key: string) =>
        values.get(key),
      );
      hoisted.redis.set.mockImplementation(
        async (key: string, value: string) => {
          values.set(key, value);
        },
      );
      hoisted.redis.del.mockImplementation(async (key: string) => {
        values.delete(key);
      });
      hoisted.getQueuedUpdates.mockResolvedValue(["t3_removed"]);
      const goalData = await hoisted.getSubGoalData();
      hoisted.getSubGoalData.mockResolvedValue({
        ...goalData,
        completedTime: clock - 1,
      });
      const post = {
        id: "t3_removed",
        removedByCategory: category as string | undefined,
      };
      hoisted.reddit.getPostById.mockResolvedValue(post);
      await onPostsUpdaterJob();
      expect(hoisted.reddit.getPostById).toHaveBeenCalledTimes(1);
      expect(hoisted.redis.set).toHaveBeenCalledWith(
        "subscriber_goal_update_recheck_v1:t3_removed",
        String(clock + 3_600_000),
        { expiration: new Date(clock + 3_600_000) },
      );
      clock += 60_000;
      await onPostsUpdaterJob();
      expect(hoisted.reddit.getPostById).toHaveBeenCalledTimes(1);
      expect(hoisted.applyTextFallback).not.toHaveBeenCalled();
      expect(hoisted.cancelUpdates).not.toHaveBeenCalled();
      post.removedByCategory = undefined;
      clock += 3_540_000;
      await onPostsUpdaterJob();
      expect(hoisted.reddit.getPostById).toHaveBeenCalledTimes(2);
      expect(hoisted.applyTextFallback).toHaveBeenCalledOnce();
      expect(hoisted.redis.del).toHaveBeenCalledWith(
        "subscriber_goal_update_recheck_v1:t3_removed",
      );
      expect(hoisted.retireSubscriberGoalPost).not.toHaveBeenCalled();
    },
  );

  it("does not reconcile completion or update a filtered goal before checking removal", async () => {
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_filtered"]);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 5,
      completedTime: 0,
      postHeight: "regular",
    });
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_filtered",
      spam: true,
    });
    await onPostsUpdaterJob();
    expect(hoisted.checkCompletionStatus).not.toHaveBeenCalled();
    expect(hoisted.applyTextFallback).not.toHaveBeenCalled();
    expect(hoisted.retireSubscriberGoalPost).not.toHaveBeenCalled();
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

      if (_label === "disabled") {
        expect(hoisted.repairAutoCreateNextGoal).toHaveBeenCalledWith(
          expect.anything(),
          "t3_terminal",
          1_000,
        );
      } else {
        expect(hoisted.repairAutoCreateNextGoal).not.toHaveBeenCalled();
      }
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
    "clears %s successor suppression and repairs mandatory work",
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

      expect(hoisted.clearAutomaticSuccessorSuppression).toHaveBeenCalledWith(
        expect.anything(),
        "t3_suppressed",
      );
      expect(hoisted.repairAutoCreateNextGoal).toHaveBeenCalledWith(
        expect.anything(),
        "t3_suppressed",
        1_000,
      );
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
