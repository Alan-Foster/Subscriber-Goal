import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  checkAppAccountHealth: vi.fn(),
  ensureSubscriberGoalPostFlair: vi.fn(),
  backfillSubscriberGoalPostFlair: vi.fn(),
  ensureCommunityPostActivityBackfill: vi.fn(),
  initializeLegacyAfterSubscribeActionMigration: vi.fn(),
  initializePostKindMigration: vi.fn(),
  getSubscriberGoalCandidatePostIds: vi.fn(),
  getTrackedPosts: vi.fn(),
  queueUpdates: vi.fn(),
  reconcileSubscriberGoalStickies: vi.fn(),
}));

vi.mock("./appAccountHealth", () => ({
  checkAppAccountHealth: hoisted.checkAppAccountHealth,
}));
vi.mock("./subscriberGoalPostFlair", () => ({
  ensureSubscriberGoalPostFlair: hoisted.ensureSubscriberGoalPostFlair,
  backfillSubscriberGoalPostFlair: hoisted.backfillSubscriberGoalPostFlair,
}));
vi.mock("../data/ctaActivity", () => ({
  ensureCommunityPostActivityBackfill: hoisted.ensureCommunityPostActivityBackfill,
}));
vi.mock("../data/legacyAfterSubscribeActionMigration", () => ({
  initializeLegacyAfterSubscribeActionMigration:
    hoisted.initializeLegacyAfterSubscribeActionMigration,
}));
vi.mock("../data/postKindMigration", () => ({
  initializePostKindMigration: hoisted.initializePostKindMigration,
}));
vi.mock("../data/subscriberGoalCandidates", () => ({
  getSubscriberGoalCandidatePostIds: hoisted.getSubscriberGoalCandidatePostIds,
}));
vi.mock("../data/updaterData", () => ({
  getTrackedPosts: hoisted.getTrackedPosts,
  queueUpdates: hoisted.queueUpdates,
}));
vi.mock("../utils/redditUtils", () => ({
  reconcileSubscriberGoalStickies: hoisted.reconcileSubscriberGoalStickies,
}));

import {
  appRepairStateKey,
  processDueAppRepair,
  scheduleAppRepair,
} from "./appRepair";

class TestRedis {
  values = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async set(key: string, value: string, options?: { nx?: boolean }): Promise<void> {
    if (options?.nx && this.values.has(key)) return;
    this.values.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.values.delete(key);
    this.hashes.delete(key);
  }
  async hGetAll(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }
  async hSet(key: string, fields: Record<string, string>): Promise<void> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    Object.entries(fields).forEach(([field, value]) => hash.set(field, value));
    this.hashes.set(key, hash);
  }
}

describe("scheduled app repair", () => {
  let redis: TestRedis;
  const reddit = {
    getCurrentSubreddit: vi.fn(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    redis = new TestRedis();
    reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      type: "public",
    });
    hoisted.checkAppAccountHealth.mockResolvedValue({ status: "healthy" });
    hoisted.ensureSubscriberGoalPostFlair.mockResolvedValue({ id: "flair_1" });
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue(["t3_registered"]);
    hoisted.getTrackedPosts.mockResolvedValue(["t3_tracked"]);
  });

  it("discovers candidates before initializing migrations", async () => {
    await scheduleAppRepair(redis as never, 100, 0);

    await expect(
      processDueAppRepair({ reddit: reddit as never, redis: redis as never, nowMs: 100 }),
    ).resolves.toBe("complete");

    expect(hoisted.initializePostKindMigration).toHaveBeenCalledWith(
      expect.anything(),
      ["t3_tracked"],
    );
    expect(hoisted.initializeLegacyAfterSubscribeActionMigration).toHaveBeenCalledWith(
      expect.anything(),
      ["t3_registered"],
      { name: "ExampleSub", type: "public" },
    );
    expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({ status: "complete" });
  });

  it("retries discovery failures without completing empty migrations", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    hoisted.getSubscriberGoalCandidatePostIds.mockRejectedValue(
      new Error("registry unavailable"),
    );
    await scheduleAppRepair(redis as never, 100, 0);

    await expect(
      processDueAppRepair({ reddit: reddit as never, redis: redis as never, nowMs: 100 }),
    ).resolves.toBe("retry");

    expect(hoisted.initializePostKindMigration).not.toHaveBeenCalled();
    expect(hoisted.initializeLegacyAfterSubscribeActionMigration).not.toHaveBeenCalled();
    expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
      status: "pending",
      attempts: "1",
    });
  });

  it("does nothing until lifecycle initialization creates the repair marker", async () => {
    await expect(
      processDueAppRepair({ reddit: reddit as never, redis: redis as never, nowMs: 100 }),
    ).resolves.toBe("not_due");
    expect(reddit.getCurrentSubreddit).not.toHaveBeenCalled();
  });
});
