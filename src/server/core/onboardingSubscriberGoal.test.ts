import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAppSettings } from "../settings";

const hoisted = vi.hoisted(() => ({
  getTrackedPosts: vi.fn(),
  getQueuedUpdates: vi.fn(),
  cancelUpdates: vi.fn(),
  untrackPost: vi.fn(),
  createSubscriberGoal: vi.fn(),
  notifyStickyFailure: vi.fn(),
  getPostUrl: vi.fn(),
}));

vi.mock("../data/updaterData", () => ({
  getTrackedPosts: hoisted.getTrackedPosts,
  getQueuedUpdates: hoisted.getQueuedUpdates,
  cancelUpdates: hoisted.cancelUpdates,
  untrackPost: hoisted.untrackPost,
}));

vi.mock("./createSubscriberGoal", () => ({
  createSubscriberGoal: hoisted.createSubscriberGoal,
}));

vi.mock("../utils/stickyFailureNotifications", () => ({
  notifyStickyFailure: hoisted.notifyStickyFailure,
  getPostUrl: hoisted.getPostUrl,
}));

import {
  findExistingSubscriberGoal,
  initializeOnboardingSubscriberGoal,
  onboardingSubscriberGoalDelayMs,
  onboardingTinySubscriberThreshold,
  onboardingRecentPostPageSize,
  onboardingRecentPostScanLimit,
  onboardingSubscriberGoalStateKey,
  processDueOnboardingSubscriberGoal,
} from "./onboardingSubscriberGoal";
import { subscriberGoalPostRegistryKey } from "../data/subscriberGoalPostRegistry";

class InMemoryRedis {
  hashes = new Map<string, Map<string, string>>();
  sortedSets = new Map<string, Map<string, number>>();

  async hGetAll(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hSet(key: string, values: Record<string, string>): Promise<void> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(values)) {
      hash.set(field, value);
    }
    this.hashes.set(key, hash);
  }

  async hMGet(key: string, fields: string[]): Promise<(string | undefined)[]> {
    const hash = this.hashes.get(key);
    return fields.map((field) => hash?.get(field));
  }

  async hScan(key: string): Promise<{
    cursor: number;
    fieldValues: { field: string; value: string }[];
  }> {
    return {
      cursor: 0,
      fieldValues: [...(this.hashes.get(key)?.entries() ?? [])].map(
        ([field, value]) => ({ field, value }),
      ),
    };
  }

  async zAdd(
    key: string,
    ...entries: { member: string; score: number }[]
  ): Promise<void> {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    for (const entry of entries) set.set(entry.member, entry.score);
    this.sortedSets.set(key, set);
  }

  async zRange(key: string): Promise<{ member: string; score: number }[]> {
    return [...(this.sortedSets.get(key)?.entries() ?? [])].map(
      ([member, score]) => ({ member, score }),
    );
  }

  async zRem(key: string, members: string[]): Promise<void> {
    const set = this.sortedSets.get(key);
    for (const member of members) set?.delete(member);
  }
}

const settings: ServerAppSettings = {
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

const nowMs = Date.parse("2026-08-28T12:00:00.000Z");

function createReddit() {
  return {
    getCurrentSubreddit: vi.fn().mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 91,
      isNsfw: false,
    }),
    getAppUser: vi.fn().mockResolvedValue({ username: "subscriber-goal" }),
    getPostById: vi.fn(),
    getHotPosts: vi
      .fn()
      .mockReturnValue({ get: vi.fn().mockResolvedValue([]) }),
    getNewPosts: vi
      .fn()
      .mockReturnValue({ all: vi.fn().mockResolvedValue([]) }),
  };
}

describe("onboarding subscriber goal", () => {
  let redis: InMemoryRedis;
  let reddit: ReturnType<typeof createReddit>;

  beforeEach(() => {
    redis = new InMemoryRedis();
    reddit = createReddit();
    hoisted.getTrackedPosts.mockReset();
    hoisted.getQueuedUpdates.mockReset();
    hoisted.cancelUpdates.mockReset();
    hoisted.untrackPost.mockReset();
    hoisted.createSubscriberGoal.mockReset();
    hoisted.notifyStickyFailure.mockReset();
    hoisted.getPostUrl.mockReset();
    hoisted.getTrackedPosts.mockResolvedValue([]);
    hoisted.getQueuedUpdates.mockResolvedValue([]);
    hoisted.createSubscriberGoal.mockResolvedValue({
      post: { id: "t3_created", title: "Welcome to r/ExampleSub!" },
      stickyResult: { status: "pinned" },
    });
  });

  it("re-arms 23 hours and 59 minutes after each install or upgrade lifecycle event", async () => {
    expect(onboardingSubscriberGoalDelayMs).toBe((23 * 60 + 59) * 60 * 1000);

    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "pending",
      lifecycleSource: "install",
      nextRunAt: String(nowMs + onboardingSubscriberGoalDelayMs),
    });

    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs: nowMs + 100,
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "pending",
      lifecycleSource: "upgrade",
      nextRunAt: String(nowMs + 100 + onboardingSubscriberGoalDelayMs),
    });

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + 100 + onboardingSubscriberGoalDelayMs - 1,
      }),
    ).resolves.toMatchObject({ status: "not_due" });
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("trusts an existing moderator-authored tracked goal before suppressing creation", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    hoisted.getTrackedPosts.mockResolvedValue(["t3_existing"]);
    reddit.getPostById.mockResolvedValue({
      id: "t3_existing",
      authorName: "community-mod",
      subredditId: "t5_example",
      postData: { postKind: "subscriber-goal-v1" },
      createdAt: new Date(nowMs),
    });

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingSubscriberGoalDelayMs,
      }),
    ).resolves.toMatchObject({
      status: "existing",
      postId: "t3_existing",
      existingSource: "tracked",
      lifecycleSource: "upgrade",
    });
    expect(reddit.getPostById).toHaveBeenCalledWith("t3_existing");
    expect(reddit.getHotPosts).not.toHaveBeenCalled();
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("recognizes a pinned Tiny post and a recent legacy app post", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    reddit.getHotPosts.mockReturnValue({
      get: vi.fn().mockResolvedValue([
        {
          id: "t3_tiny",
          authorName: "subscriber-goal",
          subredditId: "t5_example",
          stickied: true,
          postData: { postKind: "subscribe-only-v1" },
        },
      ]),
    });
    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingSubscriberGoalDelayMs,
      }),
    ).resolves.toMatchObject({
      status: "existing",
      postId: "t3_tiny",
      existingSource: "pinned",
    });

    redis = new InMemoryRedis();
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    reddit = createReddit();
    await redis.hSet("subscriber_goals", { t3_legacy_goal: "100" });
    reddit.getNewPosts.mockReturnValue({
      all: vi.fn().mockResolvedValue([
        {
          id: "t3_legacy",
          authorName: "subscriber-goal",
          subredditId: "t5_example",
          createdAt: new Date(nowMs + onboardingSubscriberGoalDelayMs - 10_000),
        },
      ]),
    });
    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingSubscriberGoalDelayMs,
      }),
    ).resolves.toMatchObject({
      status: "existing",
      postId: "t3_legacy",
      existingSource: "recent",
    });
    expect(reddit.getNewPosts).toHaveBeenCalledWith({
      subredditName: "ExampleSub",
      limit: onboardingRecentPostScanLimit,
      pageSize: onboardingRecentPostPageSize,
    });
  });

  it("prunes a missing tracked post and continues to a valid pinned post", async () => {
    hoisted.getTrackedPosts.mockResolvedValue(["t3_stale"]);
    reddit.getPostById.mockRejectedValue(new Error("post not found"));
    reddit.getHotPosts.mockReturnValue({
      get: vi.fn().mockResolvedValue([
        {
          id: "t3_pinned",
          authorName: "subscriber-goal",
          subredditId: "t5_example",
          stickied: true,
          postData: { postKind: "subscriber-goal-v1" },
        },
      ]),
    });

    await expect(
      findExistingSubscriberGoal(reddit as never, redis as never, nowMs),
    ).resolves.toMatchObject({
      postId: "t3_pinned",
      source: "pinned",
      trackedInspected: 1,
      stalePruned: 1,
      validated: 1,
    });
    expect(hoisted.cancelUpdates).toHaveBeenCalledWith(
      expect.anything(),
      "t3_stale",
    );
    expect(hoisted.untrackPost).toHaveBeenCalledWith(
      expect.anything(),
      "t3_stale",
    );
  });

  it("discovers and validates a persisted Tiny post created 24 hours earlier", async () => {
    await redis.hSet("subscriber_goals", {
      t3_tiny_post_kind: "subscribe-only-v1",
      t3_tiny_post_height: "tiny",
    });
    reddit.getPostById.mockResolvedValue({
      id: "t3_tiny",
      authorName: "subscriber-goal",
      subredditId: "t5_example",
      createdAt: new Date(nowMs - 24 * 60 * 60 * 1000),
      postData: { postKind: "subscribe-only-v1" },
    });

    await expect(
      findExistingSubscriberGoal(reddit as never, redis as never, nowMs),
    ).resolves.toMatchObject({
      postId: "t3_tiny",
      source: "persisted",
      persistedInspected: 1,
      validated: 1,
    });
    expect(await redis.zRange(subscriberGoalPostRegistryKey)).toContainEqual(
      expect.objectContaining({ member: "t3_tiny" }),
    );
  });

  it("validates a registered Tiny post without relying on updater tracking", async () => {
    await redis.zAdd(subscriberGoalPostRegistryKey, {
      member: "t3_registered_tiny",
      score: nowMs,
    });
    reddit.getPostById.mockResolvedValue({
      id: "t3_registered_tiny",
      authorName: "subscriber-goal",
      subredditId: "t5_example",
      postData: { postKind: "subscribe-only-v1" },
      createdAt: new Date(nowMs),
    });

    await expect(
      findExistingSubscriberGoal(reddit as never, redis as never, nowMs),
    ).resolves.toMatchObject({
      postId: "t3_registered_tiny",
      source: "registered",
      registeredInspected: 1,
      validated: 1,
    });
    expect(hoisted.getTrackedPosts).toHaveBeenCalled();
    expect(reddit.getHotPosts).not.toHaveBeenCalled();
  });

  it("does not classify an ordinary markerless app-authored post as a goal", async () => {
    reddit.getNewPosts.mockReturnValue({
      all: vi.fn().mockResolvedValue([
        {
          id: "t3_ordinary",
          authorName: "subscriber-goal",
          subredditId: "t5_example",
          createdAt: new Date(nowMs),
        },
      ]),
    });

    await expect(
      findExistingSubscriberGoal(reddit as never, redis as never, nowMs),
    ).resolves.not.toHaveProperty("postId");
  });

  it("fails closed on a transient candidate lookup error", async () => {
    await redis.zAdd(subscriberGoalPostRegistryKey, {
      member: "t3_candidate",
      score: nowMs,
    });
    reddit.getPostById.mockRejectedValue(new Error("reddit unavailable"));

    await expect(
      findExistingSubscriberGoal(reddit as never, redis as never, nowMs),
    ).rejects.toThrow("reddit unavailable");
    expect(reddit.getHotPosts).not.toHaveBeenCalled();
    expect(await redis.zRange(subscriberGoalPostRegistryKey)).toContainEqual(
      expect.objectContaining({ member: "t3_candidate" }),
    );
  });

  it("creates an English Red regular goal with the small-subreddit Blue CTA and then becomes terminal", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    reddit.getNewPosts.mockReturnValue({
      all: vi.fn().mockResolvedValue([
        {
          id: "t3_old_legacy",
          authorName: "subscriber-goal",
          subredditId: "t5_example",
          createdAt: new Date(
            nowMs + onboardingSubscriberGoalDelayMs - 25 * 60 * 60 * 1000 - 1,
          ),
        },
      ]),
    });

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingSubscriberGoalDelayMs,
      }),
    ).resolves.toMatchObject({
      status: "created",
      postId: "t3_created",
    });
    expect(hoisted.createSubscriberGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          goal: 100,
          colorTheme: "red",
          language: "en",
          postHeight: "regular",
          autoCreateNextGoal: true,
          crosspost: true,
          afterSubscribeAction: expect.objectContaining({
            type: "link",
            buttonText: "Create a New Post",
            url: "https://www.reddit.com/r/ExampleSub/submit/",
            colorTheme: "blue",
          }),
        }),
      }),
    );
    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingSubscriberGoalDelayMs + 60_000,
      }),
    ).resolves.toMatchObject({
      status: "complete",
      postId: "t3_created",
    });
    expect(hoisted.createSubscriberGoal).toHaveBeenCalledTimes(1);
  });

  it.each([999_999, onboardingTinySubscriberThreshold])(
    "keeps the regular onboarding goal at %i subscribers",
    async (numberOfSubscribers) => {
      await initializeOnboardingSubscriberGoal(redis as never, {
        lifecycleSource: "install",
        nowMs,
      });
      reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers,
        isNsfw: false,
      });

      await processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingSubscriberGoalDelayMs,
      });

      expect(hoisted.createSubscriberGoal).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            goal: numberOfSubscribers < 1_000_000 ? 1_000_000 : 1_500_000,
            postHeight: "regular",
            autoCreateNextGoal: true,
          }),
        }),
      );
    },
  );

  it("creates a Tiny onboarding post above one million subscribers", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: onboardingTinySubscriberThreshold + 1,
      isNsfw: false,
    });

    await processDueOnboardingSubscriberGoal({
      reddit: reddit as never,
      redis: redis as never,
      appSettings: settings,
      nowMs: nowMs + onboardingSubscriberGoalDelayMs,
    });

    expect(hoisted.createSubscriberGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          colorTheme: "red",
          language: "en",
          postHeight: "tiny",
          autoCreateNextGoal: false,
          crosspost: true,
          afterSubscribeAction: expect.objectContaining({
            type: "top-post-day",
            colorTheme: "blue",
          }),
        }),
      }),
    );
    const options = hoisted.createSubscriberGoal.mock.calls[0]?.[0]?.options;
    expect(options).not.toHaveProperty("goal");
  });

  it("records a terminal failure without retrying", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    hoisted.getTrackedPosts.mockRejectedValue(new Error("redis unavailable"));

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingSubscriberGoalDelayMs,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorMessage: "Error: redis unavailable",
    });
    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingSubscriberGoalDelayMs + 60_000,
      }),
    ).resolves.toMatchObject({
      status: "complete",
      errorMessage: "Error: redis unavailable",
    });
  });

  it("self-initializes absent or malformed state using the migration pattern", async () => {
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    await redis.hSet(onboardingSubscriberGoalStateKey, {
      version: "invalid",
      status: "pending",
    });

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs,
      }),
    ).resolves.toMatchObject({ status: "not_due" });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[onboardingSubscriberGoal] initialized: status=pending",
      ),
    );
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      version: "onboarding_subscriber_goal_v2",
      status: "pending",
    });
  });

  it("self-initializes an absent state before waiting for its one-time check", async () => {
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs,
      }),
    ).resolves.toMatchObject({ status: "not_due" });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      nextRunAt: String(nowMs + onboardingSubscriberGoalDelayMs),
      lifecycleSource: "unknown",
    });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[onboardingSubscriberGoal] initialized: status=pending",
      ),
    );
  });
});
