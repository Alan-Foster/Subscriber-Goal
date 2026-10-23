import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAppSettings } from "../settings";

const hoisted = vi.hoisted(() => ({
  getTrackedPosts: vi.fn(),
  getQueuedUpdates: vi.fn(),
  cancelUpdates: vi.fn(),
  untrackPost: vi.fn(),
  createSubscriberGoal: vi.fn(),
  notifyHighlightFailure: vi.fn(),
  getPostUrl: vi.fn(),
  checkAppAccountHealth: vi.fn(),
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

vi.mock("../utils/communityHighlights", () => ({
  highlightAndVerifyPost: vi.fn(async () => ({
    status: "highlighted",
    selectedPostId: "t3_existing",
    verifiedHighlighted: true,
    issues: [],
    capacityOutcome: "not_needed",
    cleanupOutcome: "not_needed",
    removedManagedHighlightIds: [],
    preservedHighlightIds: [],
    rollbackOutcome: "not_needed",
    reorderOutcome: "reordered",
  })),
  createFailedHighlightResult: vi.fn(
    (selectedPostId: string, category: string, message: string) => ({
      status: "not_highlighted",
      selectedPostId,
      verifiedHighlighted: false,
      failureCategory: category,
      errorMessage: message,
      issues: [{ category, message, postId: selectedPostId }],
      capacityOutcome: "not_needed",
      cleanupOutcome: "not_needed",
      removedManagedHighlightIds: [],
      preservedHighlightIds: [],
      rollbackOutcome: "not_needed",
      reorderOutcome: "not_attempted",
    }),
  ),
  highlightVerificationIntervalMs: 5_000,
  highlightVerificationMaxWaitMs: 30_000,
}));

vi.mock("../utils/highlightFailureNotifications", () => ({
  notifyHighlightFailureIncident: hoisted.notifyHighlightFailure,
  clearHighlightFailureIncident: vi.fn(),
  clearActiveHighlightFailureIncident: vi.fn(),
  getPostUrl: hoisted.getPostUrl,
}));

vi.mock("./appAccountHealth", () => ({
  checkAppAccountHealth: hoisted.checkAppAccountHealth,
}));

import {
  getOnboardingEligibility,
  initializeOnboardingSubscriberGoal as initializeRawOnboardingSubscriberGoal,
  onboardingGoalBaseDelayMs,
  onboardingGoalStaggerMaxMinutes,
  onboardingGoalStaggerMinMinutes,
  onboardingMinimumSubscriberCount,
  onboardingTinySubscriberThreshold,
  onboardingRecentPostPageSize,
  onboardingRecentPostScanLimit,
  onboardingSubscriberGoalStateKey,
  processDueOnboardingSubscriberGoal,
  scheduleOnboardingSubscriberGoalAfterWarning,
  selectOnboardingGoalStaggerMinutes,
} from "./onboardingSubscriberGoal";
import {
  onboardingReminderStateKey,
  processDueOnboardingReminder,
  scheduleOnboardingReminder,
} from "./onboardingReminder";
import { reconcileOnboardingForLifecycle } from "./onboardingLifecycle";

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

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }

  async hDel(key: string, fields: string[]): Promise<void> {
    const hash = this.hashes.get(key);
    for (const field of fields) hash?.delete(field);
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
const highlightSubredditMethods = {
  getHighlightedPosts: vi.fn(async () => []),
  reorderHighlightedPosts: vi.fn(async () => undefined),
};

function createReddit() {
  const getHighlightedPosts = vi.fn().mockResolvedValue([]);
  const reorderHighlightedPosts = vi.fn().mockResolvedValue(undefined);
  return {
    getCurrentSubreddit: vi.fn().mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 1_001,
      type: "public",
      nsfw: false,
      getHighlightedPosts,
      reorderHighlightedPosts,
    }),
    getHighlightedPosts,
    reorderHighlightedPosts,
    getAppUser: vi.fn().mockResolvedValue({ username: "subscriber-goal" }),
    getPostById: vi.fn(),
    searchPosts: vi
      .fn()
      .mockReturnValue({ all: vi.fn().mockResolvedValue([]) }),
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
    vi.restoreAllMocks();
    redis = new InMemoryRedis();
    reddit = createReddit();
    hoisted.getTrackedPosts.mockReset();
    hoisted.checkAppAccountHealth.mockReset();
    hoisted.checkAppAccountHealth.mockResolvedValue({
      status: "healthy",
      healthy: true,
      appUsername: "subscriber-goal",
      permissions: ["posts"],
      notification: "not_needed",
    });
    hoisted.getQueuedUpdates.mockReset();
    hoisted.cancelUpdates.mockReset();
    hoisted.untrackPost.mockReset();
    hoisted.createSubscriberGoal.mockReset();
    hoisted.notifyHighlightFailure.mockReset();
    hoisted.getPostUrl.mockReset();
    hoisted.getTrackedPosts.mockResolvedValue([]);
    hoisted.getQueuedUpdates.mockResolvedValue([]);
    hoisted.createSubscriberGoal.mockResolvedValue({
      post: { id: "t3_created", title: "Welcome to r/ExampleSub!" },
      highlightResult: {
        status: "highlighted",
        selectedPostId: "t3_created",
        verifiedHighlighted: true,
        issues: [],
        capacityOutcome: "slot_available",
        cleanupOutcome: "not_needed",
        removedManagedHighlightIds: [],
        preservedHighlightIds: [],
        rollbackOutcome: "not_needed",
        reorderOutcome: "reordered",
      },
    });
  });

  it("does not re-arm an existing onboarding lifecycle state", async () => {
    expect(onboardingGoalBaseDelayMs).toBe(1_440 * 60 * 1000);

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
        nowMs: nowMs + onboardingGoalBaseDelayMs - 1,
      }),
    ).resolves.toMatchObject({ status: "not_due" });
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("requires at least 1,000 subscribers for automatic onboarding", () => {
    expect(onboardingMinimumSubscriberCount).toBe(1_000);
    expect(
      getOnboardingEligibility({
        numberOfSubscribers: 999,
        type: "public",
        nsfw: false,
      }),
    ).toMatchObject({ eligible: false, reason: "subscriber_count" });
    expect(
      getOnboardingEligibility({
        numberOfSubscribers: 1_000,
        type: "public",
        nsfw: false,
      }),
    ).toMatchObject({ eligible: true });
  });

  it("requires explicit SFW metadata for automatic onboarding", () => {
    expect(
      getOnboardingEligibility({
        numberOfSubscribers: 1_001,
        type: "public",
        nsfw: true,
      }),
    ).toMatchObject({ eligible: false, reason: "subreddit_not_sfw" });
    expect(
      getOnboardingEligibility({
        numberOfSubscribers: 1_001,
        type: "public",
      }),
    ).toMatchObject({ eligible: false, reason: "subreddit_not_sfw" });
  });

  it("selects inclusive goal stagger boundaries", () => {
    expect(onboardingGoalStaggerMinMinutes).toBe(1);
    expect(onboardingGoalStaggerMaxMinutes).toBe(1_000);
    expect(selectOnboardingGoalStaggerMinutes(0)).toBe(
      onboardingGoalStaggerMinMinutes,
    );
    expect(selectOnboardingGoalStaggerMinutes(1)).toBe(
      onboardingGoalStaggerMaxMinutes,
    );
    expect(
      onboardingGoalBaseDelayMs / (60 * 1000) + onboardingGoalStaggerMinMinutes,
    ).toBe(1_441);
    expect(
      onboardingGoalBaseDelayMs / (60 * 1000) + onboardingGoalStaggerMaxMinutes,
    ).toBe(2_440);
  });

  it("schedules creation from the configured base delay and maximum stagger", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    await initializeRawOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    await scheduleOnboardingSubscriberGoalAfterWarning(redis as never, nowMs);

    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      creationStaggerMinutes: String(onboardingGoalStaggerMaxMinutes),
      nextRunAt: String(
        nowMs +
          onboardingGoalBaseDelayMs +
          onboardingGoalStaggerMaxMinutes * 60 * 1000,
      ),
    });
  });

  it("persists one upgrade stagger without redrawing it", async () => {
    await initializeRawOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    const first = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    const staggerMinutes = Number(first.creationStaggerMinutes);

    expect(staggerMinutes).toBeGreaterThanOrEqual(
      onboardingGoalStaggerMinMinutes,
    );
    expect(staggerMinutes).toBeLessThanOrEqual(onboardingGoalStaggerMaxMinutes);
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

  it("rejects a moderator-authored tracked goal", async () => {
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
      status: "created",
      postId: "t3_created",
      lifecycleSource: "upgrade",
    });
    expect(reddit.getPostById).toHaveBeenCalledWith("t3_existing");
    expect(hoisted.createSubscriberGoal).toHaveBeenCalledOnce();
  });

  it("recognizes a highlighted Tiny post and a recent legacy app post", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    reddit.getHighlightedPosts.mockResolvedValue([{ postId: "t3_tiny" }]);
    reddit.getPostById.mockResolvedValue({
      id: "t3_tiny",
      authorName: "subscriber-goal",
      subredditId: "t5_example",
      postData: { postKind: "subscribe-only-v1" },
    });
    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingGoalBaseDelayMs,
      }),
    ).resolves.toMatchObject({
      status: "existing",
      postId: "t3_tiny",
      existingSource: "highlighted",
    });

    redis = new InMemoryRedis();
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    const upgradeState = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    reddit = createReddit();
    reddit.getNewPosts.mockReturnValue({
      all: vi.fn().mockResolvedValue([
        {
          id: "t3_legacy",
          authorName: "subscriber-goal",
          subredditId: "t5_example",
          stickied: true,
          createdAt: new Date(Number(upgradeState.nextRunAt) - 10_000),
          postData: {
            postKind: "subscriber-goal-v1",
            postHeight: "regular",
          },
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
            nowMs + onboardingGoalBaseDelayMs - 25 * 60 * 60 * 1000 - 1,
          ),
        },
      ]),
    });

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingGoalBaseDelayMs,
      }),
    ).resolves.toMatchObject({
      status: "created",
      postId: "t3_created",
    });
    expect(hoisted.createSubscriberGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          goal: 1_500,
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
        nowMs: nowMs + onboardingGoalBaseDelayMs + 60_000,
      }),
    ).resolves.toMatchObject({
      status: "complete",
      postId: "t3_created",
    });
    expect(hoisted.createSubscriberGoal).toHaveBeenCalledTimes(1);
  });

  it("suppresses creation when a goal appears after the initial duplicate check", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    reddit.getNewPosts
      .mockReturnValueOnce({ all: vi.fn().mockResolvedValue([]) })
      .mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([
          {
            id: "t3_racing_goal",
            authorName: "subscriber-goal",
            subredditId: "t5_example",
            stickied: false,
            createdAt: new Date(nowMs + onboardingGoalBaseDelayMs - 1),
            postData: { postKind: "subscriber-goal-v1" },
          },
        ]),
      });

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingGoalBaseDelayMs,
      }),
    ).resolves.toMatchObject({
      status: "existing",
      postId: "t3_racing_goal",
      existingSource: "recent",
    });
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("does not repin a completed goal found by the initial delayed upgrade check", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    const highlight = vi.fn(async () => undefined);
    const completedPost = {
      id: "t3_completed_initial",
      authorName: "subscriber-goal",
      subredditId: "t5_example",
      subredditName: "ExampleSub",
      stickied: false,
      createdAt: new Date(nowMs),
      postData: { postKind: "subscriber-goal-v1", postHeight: "regular" },
      highlight,
    };
    await redis.hSet("subscriber_goals", {
      [`${completedPost.id}_goal`]: "1000",
      [`${completedPost.id}_completed_time`]: String(
        nowMs + onboardingGoalBaseDelayMs - 60 * 60 * 1000,
      ),
      [`${completedPost.id}_auto_create_next_goal`]: "true",
      [`${completedPost.id}_post_kind`]: "subscriber-goal-v1",
    });
    reddit.getPostById.mockResolvedValue(completedPost);
    reddit.getNewPosts.mockReturnValue({
      all: vi.fn().mockResolvedValue([completedPost]),
    });

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingGoalBaseDelayMs,
      }),
    ).resolves.toMatchObject({
      status: "existing",
      postId: completedPost.id,
    });
    expect(highlight).not.toHaveBeenCalled();
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("does not repin a completed goal found by the final delayed upgrade check", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    const highlight = vi.fn(async () => undefined);
    const completedPost = {
      id: "t3_completed_final",
      authorName: "subscriber-goal",
      subredditId: "t5_example",
      subredditName: "ExampleSub",
      stickied: false,
      createdAt: new Date(nowMs),
      postData: { postKind: "subscriber-goal-v1", postHeight: "regular" },
      highlight,
    };
    reddit.getPostById.mockResolvedValue(completedPost);
    reddit.getNewPosts
      .mockReturnValueOnce({ all: vi.fn().mockResolvedValue([]) })
      .mockReturnValueOnce({ all: vi.fn().mockResolvedValue([completedPost]) });
    hoisted.checkAppAccountHealth.mockImplementationOnce(async () => {
      await redis.hSet("subscriber_goals", {
        [`${completedPost.id}_goal`]: "1000",
        [`${completedPost.id}_completed_time`]: String(
          nowMs + onboardingGoalBaseDelayMs - 60 * 60 * 1000,
        ),
        [`${completedPost.id}_auto_create_next_goal`]: "true",
        [`${completedPost.id}_post_kind`]: "subscriber-goal-v1",
      });
      return {
        status: "healthy",
        healthy: true,
        appUsername: "subscriber-goal",
        permissions: ["posts"],
        notification: "not_needed",
      };
    });

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingGoalBaseDelayMs,
      }),
    ).resolves.toMatchObject({
      status: "existing",
      postId: completedPost.id,
    });
    expect(highlight).not.toHaveBeenCalled();
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it.each([0, 3, onboardingMinimumSubscriberCount - 1])(
    "does not automatically create an onboarding goal at %i subscribers",
    async (numberOfSubscribers) => {
      await initializeOnboardingSubscriberGoal(redis as never, {
        lifecycleSource: "install",
        nowMs,
      });
      reddit.getCurrentSubreddit.mockResolvedValue({
        ...highlightSubredditMethods,
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers,
        type: "public",
        nsfw: false,
      });

      await expect(
        processDueOnboardingSubscriberGoal({
          reddit: reddit as never,
          redis: redis as never,
          appSettings: settings,
          nowMs: nowMs + onboardingGoalBaseDelayMs,
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
      ...highlightSubredditMethods,
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 1_001,
      type: "public",
      nsfw: false,
      language: "es",
    });

    await processDueOnboardingSubscriberGoal({
      reddit: reddit as never,
      redis: redis as never,
      appSettings: settings,
      nowMs: nowMs + onboardingGoalBaseDelayMs,
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
      ...highlightSubredditMethods,
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 1_001,
      type: "public",
      nsfw: false,
      language: "ja",
    });

    await processDueOnboardingSubscriberGoal({
      reddit: reddit as never,
      redis: redis as never,
      appSettings: settings,
      nowMs: nowMs + onboardingGoalBaseDelayMs,
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
        ...highlightSubredditMethods,
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers: 1_001,
        type,
        nsfw: false,
      });

      await expect(
        processDueOnboardingSubscriberGoal({
          reddit: reddit as never,
          redis: redis as never,
          appSettings: settings,
          nowMs: nowMs + onboardingGoalBaseDelayMs,
        }),
      ).resolves.toMatchObject({
        status: "ineligible",
        eligibilitySubscriberCount: 1_001,
      });

      expect(reddit.getAppUser).not.toHaveBeenCalled();
      expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    },
  );

  it("does not create an onboarding goal for an NSFW subreddit", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    reddit.getCurrentSubreddit.mockResolvedValue({
      ...highlightSubredditMethods,
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 1_001,
      type: "public",
      nsfw: true,
    });

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingGoalBaseDelayMs,
      }),
    ).resolves.toMatchObject({ status: "ineligible" });

    expect(reddit.getAppUser).not.toHaveBeenCalled();
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("rechecks SFW eligibility immediately before creating", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    reddit.getCurrentSubreddit
      .mockResolvedValueOnce({
        ...highlightSubredditMethods,
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers: 1_001,
        type: "public",
        nsfw: false,
      })
      .mockResolvedValueOnce({
        ...highlightSubredditMethods,
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers: 1_001,
        type: "public",
        nsfw: false,
      })
      .mockResolvedValueOnce({
        ...highlightSubredditMethods,
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers: 1_001,
        type: "public",
        nsfw: true,
      });

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingGoalBaseDelayMs,
      }),
    ).resolves.toMatchObject({ status: "ineligible" });

    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it.each([999_999, onboardingTinySubscriberThreshold])(
    "keeps the regular onboarding goal at %i subscribers",
    async (numberOfSubscribers) => {
      await initializeOnboardingSubscriberGoal(redis as never, {
        lifecycleSource: "install",
        nowMs,
      });
      reddit.getCurrentSubreddit.mockResolvedValue({
        ...highlightSubredditMethods,
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers,
        type: "public",
        nsfw: false,
      });

      await processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingGoalBaseDelayMs,
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
      ...highlightSubredditMethods,
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: onboardingTinySubscriberThreshold + 1,
      type: "public",
      nsfw: false,
      language: "es",
    });

    await processDueOnboardingSubscriberGoal({
      reddit: reddit as never,
      redis: redis as never,
      appSettings: settings,
      nowMs: nowMs + onboardingGoalBaseDelayMs,
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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
        nowMs: nowMs + onboardingGoalBaseDelayMs,
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
        nowMs: nowMs + onboardingGoalBaseDelayMs + 60_000,
      }),
    ).resolves.toMatchObject({
      status: "not_due",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"onboarding_goal_retry_scheduled"'),
    );
  });

  it("stops after three total creation-phase attempts", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    hoisted.getTrackedPosts.mockRejectedValue(new Error("redis unavailable"));

    let runAt = nowMs + onboardingGoalBaseDelayMs;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: runAt,
      });
      const state = await redis.hGetAll(onboardingSubscriberGoalStateKey);
      expect(state.attempts).toBe(String(attempt));
      if (attempt < 3) runAt = Number(state.nextRunAt);
    }

    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "retry_exhausted",
      attempts: "3",
    });
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("cancels automatic creation when Manage Posts cannot be verified", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    hoisted.checkAppAccountHealth.mockResolvedValue({
      status: "unknown",
      healthy: false,
      permissions: [],
      notification: "not_needed",
    });

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingGoalBaseDelayMs,
      }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(hoisted.checkAppAccountHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        notify: false,
        scheduleUnknownRetry: false,
      }),
    );
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "cancelled_permission",
    });
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"onboarding_goal_cancelled"'),
    );
  });

  it("does not retry an unknown permission result from the creation boundary", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    const error = new Error("permission lookup failed");
    error.name = "SubscriberGoalPermissionVerificationError";
    hoisted.createSubscriberGoal.mockRejectedValue(error);

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingGoalBaseDelayMs,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "retry_exhausted",
      attempts: "1",
    });
  });

  it("pauses armed creation and re-randomizes it when re-enabled", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    const dueAt = nowMs + onboardingGoalBaseDelayMs;

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: dueAt,
        automationEnabled: false,
      }),
    ).resolves.toMatchObject({ status: "paused" });
    expect(reddit.getCurrentSubreddit).not.toHaveBeenCalled();

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: dueAt + 1,
        automationEnabled: true,
      }),
    ).resolves.toMatchObject({ status: "not_due" });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "pending",
      nextRunAt: String(dueAt + 1 + 60_000),
      pausedAt: "",
    });
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("terminates a created but unhighlighted goal without retrying", async () => {
    await initializeOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    hoisted.createSubscriberGoal.mockResolvedValue({
      post: { id: "t3_unhighlighted", title: "Welcome to r/ExampleSub!" },
      highlightResult: {
        status: "not_highlighted",
        selectedPostId: "t3_unhighlighted",
        verifiedHighlighted: false,
        failureCategory: "write",
        errorMessage: "no permission",
        issues: [{ category: "write", message: "no permission" }],
        capacityOutcome: "not_needed",
        cleanupOutcome: "not_needed",
        removedManagedHighlightIds: [],
        preservedHighlightIds: [],
        rollbackOutcome: "not_needed",
        reorderOutcome: "not_attempted",
      },
    });

    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingGoalBaseDelayMs,
      }),
    ).resolves.toMatchObject({ status: "created", postId: "t3_unhighlighted" });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "created_not_highlighted",
    });
    expect(hoisted.notifyHighlightFailure).toHaveBeenCalledOnce();
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
        nowMs: nowMs + onboardingGoalBaseDelayMs,
      }),
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: nowMs + onboardingGoalBaseDelayMs,
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
        nowMs: nowMs + onboardingGoalBaseDelayMs,
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

  it("recovers onboarding when lifecycle state is absent", async () => {
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
      status: "awaiting_warning",
      lifecycleSource: "recovery",
    });
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
      nextRunAt: String(
        sentAt +
          onboardingGoalBaseDelayMs +
          onboardingGoalStaggerMinMinutes * 60_000,
      ),
    });
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
  });

  it("re-arms a newly eligible lifecycle and creates exactly one goal", async () => {
    const previousCompletedAt = nowMs - 60_000;
    await redis.hSet(onboardingSubscriberGoalStateKey, {
      version: "onboarding_subscriber_goal_v4",
      status: "complete",
      armedAt: String(nowMs - 120_000),
      lifecycleSource: "upgrade",
      creationStaggerMinutes: "5",
      operationId: `onboarding:onboarding_subscriber_goal_v4:${nowMs - 120_000}`,
      completedAt: String(previousCompletedAt),
      resultStatus: "ineligible",
      eligibilitySubscriberCount: "44",
    });
    await redis.hSet(onboardingReminderStateKey, {
      version: "onboarding_reminder_v3",
      status: "complete",
      nextRunAt: String(previousCompletedAt),
      armedAt: String(nowMs - 120_000),
      lifecycleSource: "upgrade",
      reminderStaggerMinutes: "1",
      completedAt: String(previousCompletedAt),
      result: "ineligible",
      eligibilitySubscriberCount: "44",
    });
    vi.spyOn(Math, "random").mockReturnValue(0);

    await reconcileOnboardingForLifecycle(reddit as never, redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    await expect(
      processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: nowMs + 60_000,
      }),
    ).resolves.toMatchObject({ status: "sent" });

    const goal = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: settings,
        nowMs: Number(goal.nextRunAt),
      }),
    ).resolves.toMatchObject({ status: "created", postId: "t3_created" });
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
    expect(hoisted.createSubscriberGoal).toHaveBeenCalledOnce();
  });

  it("logs each successful onboarding transition in order", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(Math, "random").mockReturnValue(0);
    await initializeRawOnboardingSubscriberGoal(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });
    await scheduleOnboardingReminder(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });

    const sentAt = nowMs + 60_000;
    await processDueOnboardingReminder({
      reddit: reddit as never,
      redis: redis as never,
      nowMs: sentAt,
    });
    const goalState = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    await processDueOnboardingSubscriberGoal({
      reddit: reddit as never,
      redis: redis as never,
      appSettings: settings,
      nowMs: Number(goalState.nextRunAt),
    });

    const trackedEvents = new Set([
      "onboarding_reminder_scheduled",
      "onboarding_modmail_dispatch_started",
      "onboarding_modmail_sent",
      "onboarding_goal_scheduled",
      "onboarding_goal_creation_started",
      "onboarding_goal_created",
    ]);
    const events = infoSpy.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith("[diagnostic] "))
      .map((line) => JSON.parse(line.slice("[diagnostic] ".length)).event)
      .filter((event: string) => trackedEvents.has(event));

    expect(events).toEqual([...trackedEvents]);
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
          onboardingGoalBaseDelayMs +
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
    ).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "delivery_unknown",
      nextRunAt: "",
    });
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("skips a community that drops to 39 subscribers after its warning", async () => {
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
      ...highlightSubredditMethods,
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 39,
      type: "public",
      nsfw: false,
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
      eligibilitySubscriberCount: 39,
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      resultStatus: "ineligible",
      eligibilitySubscriberCount: "39",
      ineligibilityReason: "subscriber_count",
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
      ...highlightSubredditMethods,
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 1_001,
      type: "restricted",
      nsfw: false,
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
      eligibilitySubscriberCount: 1_001,
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
        status: "pending",
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

  it("cancels ambiguous legacy processing work without resending", async () => {
    await redis.hSet("onboarding_subscriber_goal_v3_state", {
      version: "onboarding_subscriber_goal_v3",
      status: "processing",
      armedAt: String(nowMs),
      nextRunAt: String(nowMs - 1),
      lifecycleSource: "upgrade",
      attempts: "1",
    });

    await initializeRawOnboardingSubscriberGoal(redis as never, {
      nowMs,
      migrationOnly: true,
    });

    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "delivery_unknown",
      migratedFromVersion: "onboarding_subscriber_goal_v3",
    });
  });

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
