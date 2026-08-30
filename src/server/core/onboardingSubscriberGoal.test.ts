import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAppSettings } from "../settings";

const hoisted = vi.hoisted(() => ({
  getTrackedPosts: vi.fn(),
  getQueuedUpdates: vi.fn(),
  createSubscriberGoal: vi.fn(),
  notifyStickyFailure: vi.fn(),
  getPostUrl: vi.fn(),
}));

vi.mock("../data/updaterData", () => ({
  getTrackedPosts: hoisted.getTrackedPosts,
  getQueuedUpdates: hoisted.getQueuedUpdates,
}));

vi.mock("./createSubscriberGoal", () => ({
  createSubscriberGoal: hoisted.createSubscriberGoal,
}));

vi.mock("../utils/stickyFailureNotifications", () => ({
  notifyStickyFailure: hoisted.notifyStickyFailure,
  getPostUrl: hoisted.getPostUrl,
}));

import {
  initializeOnboardingSubscriberGoal,
  onboardingSubscriberGoalDelayMs,
  onboardingRecentPostPageSize,
  onboardingRecentPostScanLimit,
  onboardingSubscriberGoalStateKey,
  processDueOnboardingSubscriberGoal,
} from "./onboardingSubscriberGoal";

class InMemoryRedis {
  hashes = new Map<string, Map<string, string>>();

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

  it("arms once for the configured delay and remains not due before then", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs: nowMs + 100,
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "pending",
      lifecycleSource: "install",
      nextRunAt: String(nowMs + onboardingSubscriberGoalDelayMs),
    });

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingSubscriberGoalDelayMs - 1,
      }),
    ).resolves.toMatchObject({ status: "not_due" });
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("records an existing tracked post without scanning or creating", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    hoisted.getTrackedPosts.mockResolvedValue(["t3_existing"]);

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

  it("creates the requested English Red regular goal and then becomes terminal", async () => {
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
            nowMs + onboardingSubscriberGoalDelayMs - 2 * 60 * 60 * 1000 - 1,
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
            type: "top-post-day",
            colorTheme: "red",
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
