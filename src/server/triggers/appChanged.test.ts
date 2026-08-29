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
  getTrackedPosts: vi.fn(),
  queueUpdates: vi.fn(),
  initializePostKindMigration: vi.fn(),
  initializeLegacyAfterSubscribeActionMigration: vi.fn(),
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
}));

import { onAppChanged } from "./appChanged";

describe("onAppChanged", () => {
  beforeEach(() => {
    hoisted.context.subredditName = undefined;
    hoisted.context.subredditId = undefined;
    hoisted.getCurrentSubreddit.mockReset();
    hoisted.ensureSavedSubredditDisplayName.mockReset();
    hoisted.clearLegacySubscriberErasureTombstones.mockReset();
    hoisted.initializeRecentSubscriberIndexMigration.mockReset();
    hoisted.initializeSubscriberStatsMigration.mockReset();
    hoisted.getTrackedPosts.mockReset();
    hoisted.queueUpdates.mockReset();
    hoisted.initializePostKindMigration.mockReset();
    hoisted.initializeLegacyAfterSubscribeActionMigration.mockReset();
    hoisted.getTrackedPosts.mockResolvedValue([]);
    hoisted.clearLegacySubscriberErasureTombstones.mockResolvedValue(0);
    hoisted.initializeSubscriberStatsMigration.mockResolvedValue(undefined);
    hoisted.initializeRecentSubscriberIndexMigration.mockResolvedValue(
      undefined,
    );
    hoisted.initializePostKindMigration.mockResolvedValue(undefined);
    hoisted.initializeLegacyAfterSubscribeActionMigration.mockResolvedValue(
      undefined,
    );
  });

  it("skips gracefully when lifecycle trigger has no subreddit context", async () => {
    await expect(onAppChanged()).resolves.toBeUndefined();

    expect(hoisted.getCurrentSubreddit).not.toHaveBeenCalled();
    expect(hoisted.ensureSavedSubredditDisplayName).not.toHaveBeenCalled();
    expect(
      hoisted.clearLegacySubscriberErasureTombstones,
    ).not.toHaveBeenCalled();
    expect(hoisted.initializeSubscriberStatsMigration).not.toHaveBeenCalled();
    expect(
      hoisted.initializeRecentSubscriberIndexMigration,
    ).not.toHaveBeenCalled();
    expect(hoisted.queueUpdates).not.toHaveBeenCalled();
  });

  it("uses subredditName from context without calling reddit.getCurrentSubreddit", async () => {
    hoisted.context.subredditName = "SubGoal";

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
    expect(
      hoisted.initializeRecentSubscriberIndexMigration,
    ).toHaveBeenCalledWith(expect.anything());
    expect(hoisted.initializePostKindMigration).toHaveBeenCalledWith(
      expect.anything(),
      [],
    );
    expect(
      hoisted.initializeLegacyAfterSubscribeActionMigration,
    ).toHaveBeenCalledWith(expect.anything(), []);
  });

  it("falls back safely when subreddit fetch fails", async () => {
    hoisted.context.subredditId = "t5_abc";
    hoisted.getCurrentSubreddit.mockRejectedValue(new Error("no context"));

    await expect(onAppChanged()).resolves.toBeUndefined();

    expect(hoisted.getCurrentSubreddit).toHaveBeenCalledTimes(1);
    expect(hoisted.ensureSavedSubredditDisplayName).not.toHaveBeenCalled();
  });
});
