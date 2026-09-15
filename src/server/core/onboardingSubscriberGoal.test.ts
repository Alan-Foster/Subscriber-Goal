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
  initializeOnboardingSubscriberGoal as initializeRawOnboardingSubscriberGoal,
  onboardingMinimumSubscriberCount,
  onboardingSubscriberGoalDelayMs,
  onboardingUpgradeStaggerMaxMinutes,
  onboardingUpgradeStaggerMinMinutes,
  onboardingTinySubscriberThreshold,
  onboardingRecentPostPageSize,
  onboardingRecentPostScanLimit,
  onboardingSubscriberGoalStateKey,
  processDueOnboardingSubscriberGoal,
  scheduleOnboardingSubscriberGoalAfterWarning,
  selectOnboardingUpgradeStaggerMinutes,
} from "./onboardingSubscriberGoal";
import {
  onboardingReminderStateKey,
  processDueOnboardingReminder,
  scheduleOnboardingReminder,
} from "./onboardingReminder";
import { subscriberGoalPostRegistryKey } from "../data/subscriberGoalPostRegistry";

class InMemoryRedis {
  hashes = new Map<string, Map<string, string>>();
  sortedSets = new Map<string, Map<string, number>>();
  values = new Map<string, string>();

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean },
  ): Promise<void> {
    if (options?.nx && this.values.has(key)) return;
    this.values.set(key, value);
  }

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

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

async function initializeOnboardingSubscriberGoal(
  redis: never,
  options: { lifecycleSource: "install" | "upgrade"; nowMs: number },
): Promise<void> {
  await initializeRawOnboardingSubscriberGoal(redis, options);
  const raw = await (redis as unknown as InMemoryRedis).hGetAll(
    onboardingSubscriberGoalStateKey,
  );
  const sentAt = options.nowMs - Number(raw.creationStaggerMinutes) * 60 * 1000;
  await scheduleOnboardingSubscriberGoalAfterWarning(redis, sentAt);
}

const nowMs = Date.parse("2026-08-28T12:00:00.000Z");

function createReddit() {
  return {
    getCurrentSubreddit: vi.fn().mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 91,
      type: "public",
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
    modMail: { createModNotification: vi.fn().mockResolvedValue(undefined) },
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

  it("does not re-arm an existing onboarding lifecycle state", async () => {
    expect(onboardingSubscriberGoalDelayMs).toBe(24 * 60 * 60 * 1000);

    await initializeRawOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "awaiting_warning",
      lifecycleSource: "install",
      nextRunAt: "",
    });

    await initializeRawOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs: nowMs + 100,
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "awaiting_warning",
      lifecycleSource: "install",
      nextRunAt: "",
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

  it("selects inclusive upgrade stagger boundaries", () => {
    expect(selectOnboardingUpgradeStaggerMinutes(0)).toBe(
      onboardingUpgradeStaggerMinMinutes,
    );
    expect(selectOnboardingUpgradeStaggerMinutes(1)).toBe(
      onboardingUpgradeStaggerMaxMinutes,
    );
  });

  it("persists one upgrade stagger without redrawing it", async () => {
    await initializeRawOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    const first = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    const staggerMinutes = Number(first.creationStaggerMinutes);

    expect(staggerMinutes).toBeGreaterThanOrEqual(
      onboardingUpgradeStaggerMinMinutes,
    );
    expect(staggerMinutes).toBeLessThanOrEqual(
      onboardingUpgradeStaggerMaxMinutes,
    );
    expect(first.status).toBe("awaiting_warning");
    expect(first.nextRunAt).toBe("");

    await initializeRawOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs: nowMs + 60_000,
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toEqual(first);
  });

  it("keeps installs non-runnable until the warning succeeds", async () => {
    await initializeRawOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });

    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "awaiting_warning",
      nextRunAt: "",
    });
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

    const upgradeState = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: Number(upgradeState.nextRunAt),
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
    const upgradeState = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    reddit = createReddit();
    await redis.hSet("subscriber_goals", { t3_legacy_goal: "100" });
    reddit.getNewPosts.mockReturnValue({
      all: vi.fn().mockResolvedValue([
        {
          id: "t3_legacy",
          authorName: "subscriber-goal",
          subredditId: "t5_example",
          createdAt: new Date(Number(upgradeState.nextRunAt) - 10_000),
        },
      ]),
    });
    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: Number(upgradeState.nextRunAt),
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
          operationId: `onboarding:onboarding_subscriber_goal_v4:${nowMs}`,
          afterSubscribeAction: expect.objectContaining({
            type: "top-post-day",
            buttonText: "View the Top Post Today",
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

  it.each([0, 3, onboardingMinimumSubscriberCount - 1])(
    "does not automatically create an onboarding goal at %i subscribers",
    async (numberOfSubscribers) => {
      await initializeOnboardingSubscriberGoal(redis as never, {
        lifecycleSource: "install",
        nowMs,
      });
      reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers,
        type: "public",
        isNsfw: false,
      });

      await expect(
        processDueOnboardingSubscriberGoal({
          reddit: reddit as never,
          redis: redis as never,
          appSettings: settings,
          nowMs: nowMs + onboardingSubscriberGoalDelayMs,
        }),
      ).resolves.toMatchObject({
        status: "ineligible",
        eligibilitySubscriberCount: numberOfSubscribers,
      });
      expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
      await expect(
        redis.hGetAll(onboardingSubscriberGoalStateKey),
      ).resolves.toMatchObject({
        status: "complete",
        resultStatus: "ineligible",
        eligibilitySubscriberCount: String(numberOfSubscribers),
      });
    },
  );

  it("uses the subreddit language for an automatically created onboarding goal", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 50,
      type: "public",
      isNsfw: false,
      language: "es",
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
          title: "¡Bienvenido a r/ExampleSub!",
          language: "es",
          afterSubscribeAction: expect.objectContaining({
            type: "top-post-day",
            buttonText: "Ver la publicación destacada de hoy",
          }),
        }),
      }),
    );
  });

  it("falls back to English when the subreddit language is unsupported", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 50,
      type: "public",
      isNsfw: false,
      language: "ja",
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
          title: "Welcome to r/ExampleSub!",
          language: "en",
          afterSubscribeAction: expect.objectContaining({
            type: "top-post-day",
            buttonText: "View the Top Post Today",
          }),
        }),
      }),
    );
  });

  it.each(["restricted", "private", undefined])(
    "does not create an onboarding goal for a %s subreddit",
    async (type) => {
      await initializeOnboardingSubscriberGoal(redis as never, {
        lifecycleSource: "install",
        nowMs,
      });
      reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers: 50,
        type,
        isNsfw: false,
      });

      await expect(
        processDueOnboardingSubscriberGoal({
          reddit: reddit as never,
          redis: redis as never,
          appSettings: settings,
          nowMs: nowMs + onboardingSubscriberGoalDelayMs,
        }),
      ).resolves.toMatchObject({
        status: "ineligible",
        eligibilitySubscriberCount: 50,
      });

      expect(reddit.getAppUser).not.toHaveBeenCalled();
      expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    },
  );

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
        type: "public",
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
      type: "public",
      isNsfw: false,
      language: "es",
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
          language: "es",
          postHeight: "tiny",
          autoCreateNextGoal: false,
          crosspost: true,
          afterSubscribeAction: expect.objectContaining({
            type: "top-post-day",
            buttonText: "Ver la publicación destacada de hoy",
            colorTheme: "blue",
          }),
        }),
      }),
    );
    const options = hoisted.createSubscriberGoal.mock.calls[0]?.[0]?.options;
    expect(options).not.toHaveProperty("goal");
  });

  it("schedules a bounded retry after a transient failure", async () => {
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
      status: "not_due",
    });
  });

  it("allows only one overlapping automatic creation", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });

    const results = await Promise.all([
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingSubscriberGoalDelayMs,
      }),
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingSubscriberGoalDelayMs,
      }),
    ]);

    expect(hoisted.createSubscriberGoal).toHaveBeenCalledOnce();
    expect(results.map((result) => result.status).sort()).toEqual([
      "created",
      "not_due",
    ]);
  });

  it("recovers a processing state after its prior lock expires", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    await redis.hSet(onboardingSubscriberGoalStateKey, {
      status: "processing",
      startedAt: String(nowMs),
    });

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingSubscriberGoalDelayMs,
      }),
    ).resolves.toMatchObject({ status: "created" });
    expect(hoisted.createSubscriberGoal).toHaveBeenCalledOnce();
  });

  it("does not arm onboarding from malformed state", async () => {
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
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      version: "invalid",
      status: "pending",
    });
  });

  it("does not arm onboarding when lifecycle state is absent", async () => {
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
    ).resolves.toEqual({});
  });

  it("arms creation from the actual successful modmail time", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    await initializeRawOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    await scheduleOnboardingReminder(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({ status: "awaiting_warning", nextRunAt: "" });

    const sentAt = nowMs + 60_000;
    await expect(
      processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: sentAt,
      }),
    ).resolves.toMatchObject({ status: "sent" });

    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "pending",
      reminderSentAt: String(sentAt),
      nextRunAt: String(sentAt + 24 * 60 * 60 * 1000 + 60_000),
    });
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
  });

  it("repairs a sent reminder without sending duplicate modmail", async () => {
    await initializeRawOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    const goal = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    const sentAt = nowMs + 5 * 60_000;
    await redis.hSet(onboardingReminderStateKey, {
      version: "onboarding_reminder_v3",
      status: "complete",
      armedAt: String(nowMs),
      nextRunAt: String(sentAt),
      lifecycleSource: "upgrade",
      reminderStaggerMinutes: "5",
      sentAt: String(sentAt),
      completedAt: String(sentAt),
      result: "sent",
    });

    await processDueOnboardingReminder({
      reddit: reddit as never,
      redis: redis as never,
      nowMs: sentAt + 60_000,
    });

    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "pending",
      nextRunAt: String(
        sentAt +
          24 * 60 * 60 * 1000 +
          Number(goal.creationStaggerMinutes) * 60_000,
      ),
    });
    expect(reddit.modMail.createModNotification).not.toHaveBeenCalled();
  });

  it("never arms creation while modmail is failing", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    await initializeRawOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    await scheduleOnboardingReminder(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    reddit.modMail.createModNotification.mockRejectedValue(
      new Error("modmail unavailable"),
    );

    await expect(
      processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: nowMs + 60_000,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({ status: "awaiting_warning", nextRunAt: "" });
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("skips a community that drops below 50 after its warning", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    await initializeRawOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    await scheduleOnboardingReminder(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    const sentAt = nowMs + 60_000;
    await processDueOnboardingReminder({
      reddit: reddit as never,
      redis: redis as never,
      nowMs: sentAt,
    });
    reddit.getAppUser.mockClear();
    reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 49,
      type: "public",
      isNsfw: false,
    });
    const goal = await redis.hGetAll(onboardingSubscriberGoalStateKey);

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: Number(goal.nextRunAt),
      }),
    ).resolves.toMatchObject({
      status: "ineligible",
      eligibilitySubscriberCount: 49,
    });
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("skips a community that becomes restricted after its warning", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    await initializeRawOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    await scheduleOnboardingReminder(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    const sentAt = nowMs + 60_000;
    await processDueOnboardingReminder({
      reddit: reddit as never,
      redis: redis as never,
      nowMs: sentAt,
    });
    reddit.getAppUser.mockClear();
    reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 91,
      type: "restricted",
      isNsfw: false,
    });
    const goal = await redis.hGetAll(onboardingSubscriberGoalStateKey);

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: Number(goal.nextRunAt),
      }),
    ).resolves.toMatchObject({
      status: "ineligible",
      eligibilitySubscriberCount: 91,
    });
    expect(reddit.getAppUser).not.toHaveBeenCalled();
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it.each([
    ["onboarding_subscriber_goal_v3_state", "onboarding_subscriber_goal_v3"],
    ["onboarding_subscriber_goal_v2_state", "onboarding_subscriber_goal_v2"],
  ] as const)(
    "lazily migrates pending %s work and preserves its operation identity",
    async (legacyKey, legacyVersion) => {
      await redis.hSet(legacyKey, {
        version: legacyVersion,
        status: "processing",
        armedAt: String(nowMs),
        nextRunAt: String(nowMs - 1),
        lifecycleSource: "upgrade",
        attempts: "3",
      });

      await processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs,
      });
      const migrated = await redis.hGetAll(onboardingSubscriberGoalStateKey);
      expect(migrated).toMatchObject({
        status: "awaiting_warning",
        migratedFromVersion: legacyVersion,
        legacyAttempts: "3",
        nextRunAt: "",
      });
      expect(migrated.operationId).toBe(
        legacyVersion.endsWith("v3")
          ? `onboarding:onboarding_subscriber_goal_v3:${nowMs}`
          : `onboarding:${nowMs}`,
      );
    },
  );

  it("migrates legacy v1 JSON work", async () => {
    await redis.set(
      "onboarding_subscriber_goal_v1",
      JSON.stringify({
        status: "pending",
        armedAt: nowMs,
        lifecycleSource: "upgrade",
        attempts: 2,
      }),
    );
    await initializeRawOnboardingSubscriberGoal(redis as never, {
      nowMs: nowMs + 1,
      migrationOnly: true,
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "awaiting_warning",
      migratedFromVersion: "onboarding_subscriber_goal_v1",
      legacyAttempts: "2",
    });
  });

  it.each(["onboarding_reminder_v1", "onboarding_reminder_v2"])(
    "migrates pending reminder-only %s work",
    async (legacyVersion) => {
      await redis.hSet(`${legacyVersion}_state`, {
        version: legacyVersion,
        status: "pending",
        armedAt: String(nowMs),
        nextRunAt: String(nowMs),
        lifecycleSource: "upgrade",
      });
      await initializeRawOnboardingSubscriberGoal(redis as never, {
        nowMs,
        migrationOnly: true,
      });
      await expect(
        redis.hGetAll(onboardingSubscriberGoalStateKey),
      ).resolves.toMatchObject({
        migratedFromVersion: legacyVersion,
        status: "awaiting_warning",
      });
    },
  );

  it("keeps offsets stable under concurrent NX initialization", async () => {
    await Promise.all([
      initializeRawOnboardingSubscriberGoal(redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      }),
      initializeRawOnboardingSubscriberGoal(redis as never, {
        lifecycleSource: "upgrade",
        nowMs: nowMs + 1,
      }),
    ]);
    const first = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    await initializeRawOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs: nowMs + 2,
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toEqual(first);
  });

  it("does not lazily rearm completed legacy work", async () => {
    await redis.hSet("onboarding_subscriber_goal_v3_state", {
      version: "onboarding_subscriber_goal_v3",
      status: "complete",
      armedAt: String(nowMs),
      nextRunAt: String(nowMs),
    });
    await redis.hSet("onboarding_reminder_v2_state", {
      version: "onboarding_reminder_v2",
      status: "pending",
      armedAt: String(nowMs),
      nextRunAt: String(nowMs),
      lifecycleSource: "upgrade",
    });
    await initializeRawOnboardingSubscriberGoal(redis as never, {
      nowMs,
      migrationOnly: true,
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toEqual({});

    await initializeRawOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs: nowMs + 1,
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "awaiting_warning",
      migratedFromVersion: "",
    });
  });
});
