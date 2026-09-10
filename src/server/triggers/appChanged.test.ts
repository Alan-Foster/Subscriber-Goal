import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  context: {
    subredditName: undefined as string | undefined,
    subredditId: undefined as string | undefined,
  },
  getCurrentSubreddit: vi.fn(),
  ensureSavedSubredditDisplayName: vi.fn(),
  clearLegacySubscriberErasureTombstones: vi.fn(),
  initializeRecentSubscriberIndexMigration: vi.fn(),
  initializeSubscriberStatsMigration: vi.fn(),
  initializeOnboardingSubscriberGoal: vi.fn(),
  scheduleOnboardingReminder: vi.fn(),
  getTrackedPosts: vi.fn(),
  queueUpdates: vi.fn(),
  initializePostKindMigration: vi.fn(),
  initializeLegacyAfterSubscribeActionMigration: vi.fn(),
  processLegacyAfterSubscribeActionMigrationBatch: vi.fn(),
  getSubscriberGoalCandidatePostIds: vi.fn(),
  ensureSubscriberGoalPostFlair: vi.fn(),
  backfillSubscriberGoalPostFlair: vi.fn(),
  reconcileSubscriberGoalStickies: vi.fn(),
  ensureCommunityPostActivityBackfill: vi.fn(),
  rememberAppInstaller: vi.fn(),
  checkAppAccountHealth: vi.fn(),
  scheduleAppRepair: vi.fn(),
}));

vi.mock("@devvit/web/server", () => ({
  context: hoisted.context,
  reddit: {
    getCurrentSubreddit: hoisted.getCurrentSubreddit,
  },
  redis: {},
}));

vi.mock("../data/subredditDisplayNameData", () => ({
  ensureSavedSubredditDisplayName: hoisted.ensureSavedSubredditDisplayName,
}));

vi.mock("../data/subscriberStats", () => ({
  clearLegacySubscriberErasureTombstones:
    hoisted.clearLegacySubscriberErasureTombstones,
  initializeSubscriberStatsMigration:
    hoisted.initializeSubscriberStatsMigration,
}));

vi.mock("../data/subGoalData", () => ({
  initializeRecentSubscriberIndexMigration:
    hoisted.initializeRecentSubscriberIndexMigration,
}));

vi.mock("../core/onboardingSubscriberGoal", () => ({
  initializeOnboardingSubscriberGoal:
    hoisted.initializeOnboardingSubscriberGoal,
}));

vi.mock("../core/onboardingReminder", () => ({
  scheduleOnboardingReminder: hoisted.scheduleOnboardingReminder,
}));

vi.mock("../data/updaterData", () => ({
  getTrackedPosts: hoisted.getTrackedPosts,
  queueUpdates: hoisted.queueUpdates,
}));

vi.mock("../data/postKindMigration", () => ({
  initializePostKindMigration: hoisted.initializePostKindMigration,
}));

vi.mock("../data/legacyAfterSubscribeActionMigration", () => ({
  initializeLegacyAfterSubscribeActionMigration:
    hoisted.initializeLegacyAfterSubscribeActionMigration,
  processLegacyAfterSubscribeActionMigrationBatch:
    hoisted.processLegacyAfterSubscribeActionMigrationBatch,
}));

vi.mock("../data/subscriberGoalCandidates", () => ({
  getSubscriberGoalCandidatePostIds: hoisted.getSubscriberGoalCandidatePostIds,
}));

vi.mock("../core/subscriberGoalPostFlair", () => ({
  ensureSubscriberGoalPostFlair: hoisted.ensureSubscriberGoalPostFlair,
  backfillSubscriberGoalPostFlair: hoisted.backfillSubscriberGoalPostFlair,
}));

vi.mock("../utils/redditUtils", () => ({
  reconcileSubscriberGoalStickies: hoisted.reconcileSubscriberGoalStickies,
}));

vi.mock("../data/ctaActivity", () => ({
  ensureCommunityPostActivityBackfill:
    hoisted.ensureCommunityPostActivityBackfill,
}));

vi.mock("../core/appAccountHealth", () => ({
  rememberAppInstaller: hoisted.rememberAppInstaller,
  checkAppAccountHealth: hoisted.checkAppAccountHealth,
}));

vi.mock("../core/appRepair", () => ({
  scheduleAppRepair: hoisted.scheduleAppRepair,
}));

import { onAppChanged } from "./appChanged";

describe("onAppChanged", () => {
  beforeEach(() => {
    hoisted.context.subredditName = undefined;
    hoisted.context.subredditId = undefined;
    hoisted.getCurrentSubreddit.mockReset();
    hoisted.getCurrentSubreddit.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "public",
    });
    hoisted.ensureSavedSubredditDisplayName.mockReset();
    hoisted.clearLegacySubscriberErasureTombstones.mockReset();
    hoisted.initializeRecentSubscriberIndexMigration.mockReset();
    hoisted.initializeSubscriberStatsMigration.mockReset();
    hoisted.initializeOnboardingSubscriberGoal.mockReset();
    hoisted.scheduleOnboardingReminder.mockReset();
    hoisted.getTrackedPosts.mockReset();
    hoisted.queueUpdates.mockReset();
    hoisted.initializePostKindMigration.mockReset();
    hoisted.initializeLegacyAfterSubscribeActionMigration.mockReset();
    hoisted.processLegacyAfterSubscribeActionMigrationBatch.mockReset();
    hoisted.getSubscriberGoalCandidatePostIds.mockReset();
    hoisted.ensureSubscriberGoalPostFlair.mockReset();
    hoisted.backfillSubscriberGoalPostFlair.mockReset();
    hoisted.reconcileSubscriberGoalStickies.mockReset();
    hoisted.ensureCommunityPostActivityBackfill.mockReset();
    hoisted.rememberAppInstaller.mockReset();
    hoisted.checkAppAccountHealth.mockReset();
    hoisted.scheduleAppRepair.mockReset();
    hoisted.ensureCommunityPostActivityBackfill.mockResolvedValue(undefined);
    hoisted.rememberAppInstaller.mockResolvedValue(undefined);
    hoisted.checkAppAccountHealth.mockResolvedValue({ healthy: true });
    hoisted.scheduleAppRepair.mockResolvedValue(undefined);
    hoisted.getTrackedPosts.mockResolvedValue([]);
    hoisted.clearLegacySubscriberErasureTombstones.mockResolvedValue(0);
    hoisted.initializeSubscriberStatsMigration.mockResolvedValue(undefined);
    hoisted.initializeOnboardingSubscriberGoal.mockResolvedValue(undefined);
    hoisted.scheduleOnboardingReminder.mockResolvedValue(undefined);
    hoisted.initializeRecentSubscriberIndexMigration.mockResolvedValue(
      undefined,
    );
    hoisted.initializePostKindMigration.mockResolvedValue(undefined);
    hoisted.initializeLegacyAfterSubscribeActionMigration.mockResolvedValue(
      undefined,
    );
    hoisted.processLegacyAfterSubscribeActionMigrationBatch.mockResolvedValue(
      {},
    );
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue([]);
    hoisted.ensureSubscriberGoalPostFlair.mockResolvedValue({ id: "flair_1" });
    hoisted.backfillSubscriberGoalPostFlair.mockResolvedValue({
      applied: 0,
      failed: [],
    });
    hoisted.reconcileSubscriberGoalStickies.mockResolvedValue({
      unstickied: [],
      failed: [],
    });
  });

  it("skips gracefully when lifecycle trigger has no subreddit context", async () => {
    await expect(onAppChanged()).resolves.toBeUndefined();

    expect(hoisted.getCurrentSubreddit).not.toHaveBeenCalled();
    expect(hoisted.ensureSavedSubredditDisplayName).not.toHaveBeenCalled();
    expect(
      hoisted.clearLegacySubscriberErasureTombstones,
    ).not.toHaveBeenCalled();
    expect(hoisted.initializeSubscriberStatsMigration).not.toHaveBeenCalled();
    expect(hoisted.initializeOnboardingSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.scheduleOnboardingReminder).not.toHaveBeenCalled();
    expect(
      hoisted.initializeRecentSubscriberIndexMigration,
    ).not.toHaveBeenCalled();
    expect(hoisted.queueUpdates).not.toHaveBeenCalled();
  });

  it("uses subredditName from context and resolves the subreddit for lifecycle repairs", async () => {
    hoisted.context.subredditName = "SubGoal";
    hoisted.getCurrentSubreddit.mockResolvedValue({
      id: "t5_subgoal",
      name: "SubGoal",
      type: "public",
    });

    await expect(onAppChanged()).resolves.toBeUndefined();

    expect(hoisted.getCurrentSubreddit).not.toHaveBeenCalled();
    expect(hoisted.ensureSavedSubredditDisplayName).toHaveBeenCalledWith(
      expect.anything(),
      "SubGoal",
    );
    expect(hoisted.clearLegacySubscriberErasureTombstones).toHaveBeenCalledWith(
      expect.anything(),
    );
    expect(hoisted.initializeSubscriberStatsMigration).toHaveBeenCalledWith(
      expect.anything(),
    );
    expect(hoisted.initializeOnboardingSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.scheduleOnboardingReminder).not.toHaveBeenCalled();
    expect(
      hoisted.initializeRecentSubscriberIndexMigration,
    ).toHaveBeenCalledWith(expect.anything());
    expect(hoisted.scheduleAppRepair).toHaveBeenCalledWith(expect.anything());
    expect(hoisted.initializePostKindMigration).not.toHaveBeenCalled();
    expect(hoisted.initializeLegacyAfterSubscribeActionMigration).not.toHaveBeenCalled();
    expect(
      hoisted.processLegacyAfterSubscribeActionMigrationBatch,
    ).not.toHaveBeenCalled();
  });

  it("initializes onboarding only for installations", async () => {
    hoisted.context.subredditName = "SubGoal";

    await onAppChanged({
      lifecycleSource: "install",
      installerUsername: "InstallingMod",
    });

    expect(hoisted.initializeOnboardingSubscriberGoal).toHaveBeenCalledWith(
      expect.anything(),
      { lifecycleSource: "install" },
    );
    expect(hoisted.scheduleOnboardingReminder).toHaveBeenCalledWith(
      expect.anything(),
      { lifecycleSource: "install" },
    );
    expect(hoisted.rememberAppInstaller).toHaveBeenCalledWith(
      expect.anything(),
      "InstallingMod",
    );
    expect(hoisted.scheduleAppRepair).toHaveBeenCalledWith(expect.anything());
    expect(hoisted.ensureSubscriberGoalPostFlair).not.toHaveBeenCalled();
    expect(hoisted.reconcileSubscriberGoalStickies).not.toHaveBeenCalled();
  });

  it("preserves onboarding state during upgrades", async () => {
    hoisted.context.subredditName = "SubGoal";

    await onAppChanged({ lifecycleSource: "upgrade" });

    expect(hoisted.initializeOnboardingSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.scheduleOnboardingReminder).not.toHaveBeenCalled();
    expect(hoisted.scheduleAppRepair).toHaveBeenCalled();
    expect(
      hoisted.processLegacyAfterSubscribeActionMigrationBatch,
    ).not.toHaveBeenCalled();
  });

  it("defers discovery and migrations to the scheduler repair job", async () => {
    hoisted.context.subredditName = "SubGoal";
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValueOnce([
      "t3_registered",
    ]);
    hoisted.getTrackedPosts.mockResolvedValue(["t3_tracked"]);

    await onAppChanged({ lifecycleSource: "upgrade" });

    expect(hoisted.scheduleAppRepair).toHaveBeenCalledOnce();
    expect(hoisted.getSubscriberGoalCandidatePostIds).not.toHaveBeenCalled();
    expect(hoisted.getTrackedPosts).not.toHaveBeenCalled();
  });

  it("does not perform Reddit repair work synchronously", async () => {
    hoisted.context.subredditName = "SubGoal";
    hoisted.ensureSubscriberGoalPostFlair.mockRejectedValue(
      new Error("flair permission denied"),
    );

    await expect(
      onAppChanged({ lifecycleSource: "upgrade" }),
    ).resolves.toBeUndefined();

    expect(hoisted.scheduleAppRepair).toHaveBeenCalled();
    expect(hoisted.reconcileSubscriberGoalStickies).not.toHaveBeenCalled();
    expect(hoisted.initializePostKindMigration).not.toHaveBeenCalled();
  });

  it("continues independent initialization after an early phase fails", async () => {
    hoisted.context.subredditName = "SubGoal";
    hoisted.ensureSavedSubredditDisplayName.mockRejectedValue(
      new Error("redis temporarily unavailable"),
    );

    await expect(
      onAppChanged({ lifecycleSource: "install" }),
    ).resolves.toBeUndefined();

    expect(hoisted.clearLegacySubscriberErasureTombstones).toHaveBeenCalled();
    expect(hoisted.initializeSubscriberStatsMigration).toHaveBeenCalled();
    expect(hoisted.initializeOnboardingSubscriberGoal).toHaveBeenCalled();
    expect(
      hoisted.initializeLegacyAfterSubscribeActionMigration,
    ).not.toHaveBeenCalled();
  });

  it("throws when the durable repair marker cannot be written", async () => {
    hoisted.context.subredditName = "SubGoal";
    hoisted.scheduleAppRepair.mockRejectedValue(new Error("redis unavailable"));

    await expect(onAppChanged({ lifecycleSource: "upgrade" })).rejects.toThrow(
      "redis unavailable",
    );
    expect(hoisted.ensureSavedSubredditDisplayName).not.toHaveBeenCalled();
  });

  it("requests a lifecycle retry when subreddit resolution fails", async () => {
    hoisted.context.subredditId = "t5_abc";
    hoisted.getCurrentSubreddit.mockRejectedValue(new Error("no context"));

    await expect(onAppChanged()).rejects.toThrow("no context");

    expect(hoisted.getCurrentSubreddit).toHaveBeenCalledTimes(1);
    expect(hoisted.ensureSavedSubredditDisplayName).not.toHaveBeenCalled();
  });
});
