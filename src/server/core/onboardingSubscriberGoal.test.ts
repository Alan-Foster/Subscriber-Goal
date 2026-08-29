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
  values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean },
  ): Promise<void> {
    if (options?.nx && this.values.has(key)) {
      return;
    }
    this.values.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
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

  it("arms once for one hour and remains not due before then", async () => {
    await expect(
      initializeOnboardingSubscriberGoal(redis as never, {
        lifecycleSource: "install",
        nowMs,
      }),
    ).resolves.toMatchObject({ outcome: "armed" });
    await expect(
      initializeOnboardingSubscriberGoal(redis as never, {
        lifecycleSource: "upgrade",
        nowMs: nowMs + 100,
      }),
    ).resolves.toMatchObject({ outcome: "existing" });
    expect(
      JSON.parse((await redis.get(onboardingSubscriberGoalStateKey))!),
    ).toMatchObject({
      status: "pending",
      lifecycleSource: "install",
      dueAt: nowMs + onboardingSubscriberGoalDelayMs,
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
      shouldLog: true,
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
      shouldLog: true,
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
      status: "already_terminal",
      terminalStatus: "created",
      shouldLog: false,
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
      status: "already_terminal",
      terminalStatus: "failed",
      shouldLog: false,
    });
  });

  it("turns malformed state into one terminal diagnostic failure", async () => {
    await redis.set(onboardingSubscriberGoalStateKey, "not-json");

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs,
      }),
    ).resolves.toMatchObject({ status: "failed", shouldLog: true });
    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + 60_000,
      }),
    ).resolves.toMatchObject({
      status: "already_terminal",
      terminalStatus: "failed",
      shouldLog: false,
    });
  });
});
