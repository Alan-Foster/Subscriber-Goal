import { beforeEach, describe, expect, it, vi } from "vitest";
import { autoCreateNextGoalQueueKey } from "../data/subGoalData";
import { autoCreateNextGoalSuccessorsKey } from "./autoCreateNextGoal";
import {
  ensureExistingSubscriberGoalPinned,
  onboardingSubscriberGoalLockKey,
  onboardingSubscriberGoalStateKey,
} from "./onboardingSubscriberGoal";
import {
  onboardingReminderLockKey,
  onboardingReminderStateKey,
} from "./onboardingReminder";
import { reconcileOnboardingForLifecycle } from "./onboardingLifecycle";

const lifecycleHoisted = vi.hoisted(() => ({
  processDueAutoCreateNextGoals: vi.fn(),
}));

vi.mock("./autoCreateNextGoal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./autoCreateNextGoal")>()),
  processDueAutoCreateNextGoals: lifecycleHoisted.processDueAutoCreateNextGoals,
}));

class InMemoryRedis {
  hashes = new Map<string, Map<string, string>>();
  values = new Map<string, string>();
  sortedSets = new Map<string, Map<string, number>>();
  failReminderWrite = false;

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
    this.hashes.delete(key);
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
    if (key === onboardingReminderStateKey && this.failReminderWrite) {
      throw new Error("reminder write failed");
    }
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(values)) hash.set(field, value);
    this.hashes.set(key, hash);
  }

  async zRange(key: string): Promise<{ member: string; score: number }[]> {
    return [...(this.sortedSets.get(key) ?? [])]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score);
  }

  async zAdd(
    key: string,
    entry: { member: string; score: number },
  ): Promise<void> {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    set.set(entry.member, entry.score);
    this.sortedSets.set(key, set);
  }

  async hScan(): Promise<{ cursor: number; fieldValues: never[] }> {
    return { cursor: 0, fieldValues: [] };
  }

  async hMGet(key: string, fields: string[]): Promise<(string | undefined)[]> {
    return fields.map((field) => this.hashes.get(key)?.get(field));
  }
}

const oldArmedAt = Date.parse("2026-09-16T12:00:00.000Z");
const nowMs = Date.parse("2026-09-17T12:00:00.000Z");

function createReddit({
  pinned = false,
  posts,
  subscriberCount = 2_000,
}: {
  pinned?: boolean;
  posts?: Record<string, unknown>[];
  subscriberCount?: number;
} = {}) {
  const pinnedPost = {
    id: "t3_pinned",
    authorName: "subscriber-goal-app",
    subredditId: "t5_example",
    subredditName: "ExampleSub",
    createdAt: new Date(nowMs - 60_000),
    postData: { postKind: "subscriber-goal-v1" },
    isStickied: () => true,
  };
  return {
    getCurrentSubreddit: vi.fn(async () => ({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: subscriberCount,
      type: "public",
      nsfw: false,
    })),
    getAppUser: vi.fn(async () => ({ username: "subscriber-goal-app" })),
    getPostById: vi.fn(async (postId: string) =>
      posts?.find((post) => post.id === postId),
    ),
    getHotPosts: vi.fn(() => ({
      get: vi.fn(async () => posts ?? (pinned ? [pinnedPost] : [])),
    })),
    searchPosts: vi.fn(() => ({ all: vi.fn(async () => []) })),
    getNewPosts: vi.fn(() => ({ all: vi.fn(async () => []) })),
  };
}

async function seedCompleted(
  redis: InMemoryRedis,
  resultStatus = "ineligible",
  reminderResult = "ineligible",
): Promise<void> {
  await redis.hSet(onboardingSubscriberGoalStateKey, {
    version: "onboarding_subscriber_goal_v4",
    status: "complete",
    nextRunAt: "",
    armedAt: String(oldArmedAt),
    lifecycleSource: "upgrade",
    creationStaggerMinutes: "2",
    reminderSentAt: "",
    operationId: `onboarding:onboarding_subscriber_goal_v4:${oldArmedAt}`,
    eligibilitySubscriberCount: "44",
    completedAt: String(oldArmedAt + 60_000),
    resultStatus,
  });
  await redis.hSet(onboardingReminderStateKey, {
    version: "onboarding_reminder_v3",
    status: "complete",
    nextRunAt: String(oldArmedAt + 60_000),
    armedAt: String(oldArmedAt),
    lifecycleSource: "upgrade",
    reminderStaggerMinutes: "1",
    eligibilitySubscriberCount: "44",
    completedAt: String(oldArmedAt + 60_000),
    result: reminderResult,
  });
}

async function seedGoalData(
  redis: InMemoryRedis,
  postId: string,
  {
    goal,
    completedTime = 0,
    autoCreateNextGoal = true,
  }: {
    goal: number;
    completedTime?: number;
    autoCreateNextGoal?: boolean;
  },
): Promise<void> {
  await redis.hSet("subscriber_goals", {
    [`${postId}_post_kind`]: "subscriber-goal-v1",
    [`${postId}_post_height`]: "regular",
    [`${postId}_goal`]: String(goal),
    [`${postId}_completed_time`]: String(completedTime),
    [`${postId}_auto_create_next_goal`]: String(autoCreateNextGoal),
    [`${postId}_subreddit_display_name`]: "ExampleSub",
    [`${postId}_language`]: "en",
    [`${postId}_color_theme`]: "blue",
  });
}

function makeLifecycleGoalPost({
  id,
  createdAt = nowMs - 60_000,
  pinned = false,
}: {
  id: `t3_${string}`;
  createdAt?: number;
  pinned?: boolean;
}) {
  let isPinned = pinned;
  return {
    id,
    title: id,
    authorName: "subscriber-goal-app",
    subredditId: "t5_example",
    subredditName: "ExampleSub",
    createdAt: new Date(createdAt),
    postData: {
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
    },
    isStickied: vi.fn(() => isPinned),
    sticky: vi.fn(async () => {
      isPinned = true;
    }),
    unsticky: vi.fn(async () => {
      isPinned = false;
    }),
  };
}

describe("onboarding lifecycle reconciliation", () => {
  let redis: InMemoryRedis;

  beforeEach(() => {
    vi.restoreAllMocks();
    redis = new InMemoryRedis();
    vi.spyOn(Math, "random").mockReturnValue(0);
    lifecycleHoisted.processDueAutoCreateNextGoals.mockReset();
    lifecycleHoisted.processDueAutoCreateNextGoals.mockResolvedValue({
      due: 0,
      created: 0,
      skipped: 0,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });
  });

  it("arms a fresh workflow when no pinned goal exists", async () => {
    const reddit = createReddit();

    await expect(
      reconcileOnboardingForLifecycle(reddit as never, redis as never, {
        lifecycleSource: "install",
        nowMs,
      }),
    ).resolves.toEqual({
      status: "rearmed",
      operationId: `onboarding:onboarding_subscriber_goal_v4:${nowMs}`,
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "awaiting_warning",
      armedAt: String(nowMs),
      creationStaggerMinutes: "1",
      operationId: `onboarding:onboarding_subscriber_goal_v4:${nowMs}`,
    });
    await expect(
      redis.hGetAll(onboardingReminderStateKey),
    ).resolves.toMatchObject({
      status: "pending",
      nextRunAt: String(nowMs + 60_000),
      reminderStaggerMinutes: "1",
    });
  });

  it("records a pinned goal as existing without arming timers", async () => {
    const reddit = createReddit({ pinned: true });

    await expect(
      reconcileOnboardingForLifecycle(reddit as never, redis as never, {
        lifecycleSource: "install",
        nowMs,
      }),
    ).resolves.toMatchObject({
      status: "existing",
      postId: "t3_pinned",
      existingSource: "pinned",
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "existing",
      postId: "t3_pinned",
    });
    await expect(
      redis.hGetAll(onboardingReminderStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      result: "existing",
      postId: "t3_pinned",
    });
  });

  it.each([
    "created",
    "existing",
    "ineligible",
    "failed",
    "cancelled_permission",
    "delivery_unknown",
    "retry_exhausted",
    "created_not_pinned",
  ])("re-arms terminal %s state when no pinned goal exists", async (result) => {
    await seedCompleted(redis, result, "sent");

    await expect(
      reconcileOnboardingForLifecycle(createReddit() as never, redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      }),
    ).resolves.toMatchObject({ status: "rearmed" });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({ status: "awaiting_warning", resultStatus: "" });
    await expect(
      redis.hGetAll(onboardingReminderStateKey),
    ).resolves.toMatchObject({ status: "pending", result: "" });
  });

  it("preserves active operation identity and timers when no pin exists", async () => {
    await seedCompleted(redis);
    await redis.hSet(onboardingSubscriberGoalStateKey, {
      status: "pending",
      nextRunAt: String(nowMs + 120_000),
      resultStatus: "",
    });
    await redis.hSet(onboardingReminderStateKey, {
      status: "complete",
      result: "sent",
    });
    const goal = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    const reminder = await redis.hGetAll(onboardingReminderStateKey);

    await expect(
      reconcileOnboardingForLifecycle(createReddit() as never, redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      }),
    ).resolves.toEqual({
      status: "unchanged",
      reason: "active_workflow_preserved",
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toEqual(goal);
    await expect(redis.hGetAll(onboardingReminderStateKey)).resolves.toEqual(
      reminder,
    );
  });

  it("turns an active workflow terminal when a pinned goal is found", async () => {
    await seedCompleted(redis);
    await redis.hSet(onboardingSubscriberGoalStateKey, {
      status: "awaiting_warning",
      resultStatus: "",
    });
    await redis.hSet(onboardingReminderStateKey, {
      status: "pending",
      result: "",
    });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ pinned: true }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({ status: "existing", postId: "t3_pinned" });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({ status: "complete", resultStatus: "existing" });
    await expect(
      redis.hGetAll(onboardingReminderStateKey),
    ).resolves.toMatchObject({ status: "complete", result: "existing" });
  });

  it("preserves malformed non-empty state instead of overwriting it", async () => {
    await redis.hSet(onboardingSubscriberGoalStateKey, { unexpected: "data" });

    await expect(
      reconcileOnboardingForLifecycle(createReddit() as never, redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      }),
    ).resolves.toEqual({
      status: "unchanged",
      reason: "unparseable_nonempty_state_preserved",
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toEqual({ unexpected: "data" });
  });

  it("releases the goal lock when the reminder lock is busy", async () => {
    await redis.set(onboardingReminderLockKey, "busy");

    await expect(
      reconcileOnboardingForLifecycle(createReddit() as never, redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      }),
    ).rejects.toThrow("Onboarding lifecycle state is currently locked");
    await expect(
      redis.get(onboardingSubscriberGoalLockKey),
    ).resolves.toBeUndefined();
  });

  it("rolls back a newly written goal when the reminder write fails", async () => {
    redis.failReminderWrite = true;

    await expect(
      reconcileOnboardingForLifecycle(createReddit() as never, redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      }),
    ).rejects.toThrow("reminder write failed");
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toEqual({});
  });

  it("schedules the remaining delay for a recently completed goal without repinning it", async () => {
    const completedTime = nowMs - 60 * 60 * 1000;
    const post = makeLifecycleGoalPost({ id: "t3_completed" });
    await seedGoalData(redis, post.id, { goal: 1_500, completedTime });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [post] }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({
      status: "replacement_scheduled",
      sourcePostId: post.id,
    });

    expect(post.sticky).not.toHaveBeenCalled();
    expect(
      lifecycleHoisted.processDueAutoCreateNextGoals,
    ).not.toHaveBeenCalled();
    await expect(redis.zRange(autoCreateNextGoalQueueKey)).resolves.toEqual([
      {
        member: post.id,
        score: completedTime + 24 * 60 * 60 * 1000,
      },
    ]);
  });

  it("creates a replacement immediately when completion is at least 24 hours old", async () => {
    const completedTime = nowMs - 24 * 60 * 60 * 1000;
    const post = makeLifecycleGoalPost({ id: "t3_completed" });
    await seedGoalData(redis, post.id, { goal: 1_500, completedTime });
    lifecycleHoisted.processDueAutoCreateNextGoals.mockResolvedValue({
      due: 1,
      created: 1,
      skipped: 0,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [post] }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({
      status: "replacement_created",
      sourcePostId: post.id,
    });

    expect(post.sticky).not.toHaveBeenCalled();
    expect(
      lifecycleHoisted.processDueAutoCreateNextGoals,
    ).toHaveBeenCalledOnce();
  });

  it("records completion at upgrade time when the target is met without a timestamp", async () => {
    const post = makeLifecycleGoalPost({ id: "t3_missing_time" });
    await seedGoalData(redis, post.id, { goal: 1_500 });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [post], subscriberCount: 2_000 }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({
      status: "replacement_scheduled",
      sourcePostId: post.id,
    });

    expect(post.sticky).not.toHaveBeenCalled();
    await expect(
      redis.hGet("subscriber_goals", `${post.id}_completed_time`),
    ).resolves.toBe(String(nowMs));
    await expect(redis.zRange(autoCreateNextGoalQueueKey)).resolves.toEqual([
      { member: post.id, score: nowMs + 24 * 60 * 60 * 1000 },
    ]);
  });

  it("keeps a protected Tiny pin while replacing an overdue classic goal", async () => {
    const completed = makeLifecycleGoalPost({ id: "t3_completed" });
    const tiny = {
      ...makeLifecycleGoalPost({ id: "t3_tiny", pinned: true }),
      postData: { postKind: "subscribe-only-v1", postHeight: "tiny" },
    };
    await seedGoalData(redis, completed.id, {
      goal: 1_500,
      completedTime: nowMs - 48 * 60 * 60 * 1000,
    });
    lifecycleHoisted.processDueAutoCreateNextGoals.mockResolvedValue({
      due: 1,
      created: 1,
      skipped: 0,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [completed, tiny] }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({ status: "replacement_created" });
    expect(tiny.unsticky).not.toHaveBeenCalled();
    expect(completed.sticky).not.toHaveBeenCalled();
  });

  it("keeps failed overdue replacement work terminal while the retry is scheduled", async () => {
    const post = makeLifecycleGoalPost({ id: "t3_retry" });
    await seedGoalData(redis, post.id, {
      goal: 1_500,
      completedTime: nowMs - 48 * 60 * 60 * 1000,
    });
    lifecycleHoisted.processDueAutoCreateNextGoals.mockResolvedValue({
      due: 1,
      created: 0,
      skipped: 0,
      failed: 1,
      rescheduled: 1,
      exhausted: 0,
    });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [post] }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({ status: "replacement_retrying" });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "replacement_retrying",
    });
  });

  it("recognizes a previously recorded successor without creating another", async () => {
    const post = makeLifecycleGoalPost({ id: "t3_source" });
    await seedGoalData(redis, post.id, {
      goal: 1_500,
      completedTime: nowMs - 48 * 60 * 60 * 1000,
    });
    await redis.hSet(autoCreateNextGoalSuccessorsKey, {
      [post.id]: "t3_successor",
    });
    lifecycleHoisted.processDueAutoCreateNextGoals.mockResolvedValue({
      due: 1,
      created: 0,
      skipped: 1,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [post] }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({
      status: "replacement_created",
      sourcePostId: post.id,
      postId: "t3_successor",
    });
  });

  it("does not replace or rearm a completed goal whose automatic replacement is disabled", async () => {
    const post = makeLifecycleGoalPost({ id: "t3_opted_out" });
    await seedGoalData(redis, post.id, {
      goal: 1_500,
      completedTime: nowMs - 48 * 60 * 60 * 1000,
      autoCreateNextGoal: false,
    });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [post] }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({
      status: "completed_auto_disabled",
      sourcePostId: post.id,
    });
    expect(post.sticky).not.toHaveBeenCalled();
    expect(
      lifecycleHoisted.processDueAutoCreateNextGoals,
    ).not.toHaveBeenCalled();
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "completed_auto_disabled",
    });
  });

  it("selects the newest completed goal that has automatic replacement enabled", async () => {
    const enabled = makeLifecycleGoalPost({
      id: "t3_enabled",
      createdAt: nowMs - 120_000,
    });
    const newerDisabled = makeLifecycleGoalPost({
      id: "t3_newer_disabled",
      createdAt: nowMs - 60_000,
    });
    await seedGoalData(redis, enabled.id, {
      goal: 1_500,
      completedTime: nowMs - 48 * 60 * 60 * 1000,
    });
    await seedGoalData(redis, newerDisabled.id, {
      goal: 1_750,
      completedTime: nowMs - 36 * 60 * 60 * 1000,
      autoCreateNextGoal: false,
    });
    lifecycleHoisted.processDueAutoCreateNextGoals.mockResolvedValue({
      due: 1,
      created: 1,
      skipped: 0,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [enabled, newerDisabled] }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({
      status: "replacement_created",
      sourcePostId: enabled.id,
    });
  });

  it("prefers an unmet goal over a completed goal during upgrade", async () => {
    const completed = makeLifecycleGoalPost({
      id: "t3_completed",
      createdAt: nowMs - 30_000,
    });
    const active = makeLifecycleGoalPost({
      id: "t3_active",
      createdAt: nowMs - 60_000,
    });
    await seedGoalData(redis, completed.id, {
      goal: 1_500,
      completedTime: nowMs - 48 * 60 * 60 * 1000,
    });
    await seedGoalData(redis, active.id, { goal: 3_000 });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [completed, active] }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({ status: "existing", postId: active.id });
    expect(active.sticky).toHaveBeenCalledOnce();
    expect(completed.sticky).not.toHaveBeenCalled();
    expect(
      lifecycleHoisted.processDueAutoCreateNextGoals,
    ).not.toHaveBeenCalled();
  });

  it("does not run completed-goal recovery during install reconciliation", async () => {
    const post = makeLifecycleGoalPost({ id: "t3_completed" });
    await seedGoalData(redis, post.id, {
      goal: 1_500,
      completedTime: nowMs - 48 * 60 * 60 * 1000,
    });

    await reconcileOnboardingForLifecycle(
      createReddit({ posts: [post] }) as never,
      redis as never,
      { lifecycleSource: "install", nowMs },
    );

    expect(
      lifecycleHoisted.processDueAutoCreateNextGoals,
    ).not.toHaveBeenCalled();
  });
});

describe("existing goal pin ensurance", () => {
  const makePost = ({
    id,
    createdAt,
    postKind,
    postHeight,
    pinned = false,
    stickyFails = false,
  }: {
    id: `t3_${string}`;
    createdAt: string;
    postKind?: string;
    postHeight?: string;
    pinned?: boolean;
    stickyFails?: boolean;
  }) => {
    let isPinned = pinned;
    return {
      id,
      title: id,
      authorName: "subscriber-goal-app",
      subredditId: "t5_example",
      subredditName: "ExampleSub",
      createdAt: new Date(createdAt),
      postData: {
        ...(postKind ? { postKind } : {}),
        ...(postHeight ? { postHeight } : {}),
      },
      isStickied: vi.fn(() => isPinned),
      sticky: vi.fn(async () => {
        if (stickyFails) throw new Error("sticky slots full");
        isPinned = true;
      }),
      unsticky: vi.fn(async () => {
        isPinned = false;
      }),
    };
  };

  const makeReddit = (posts: ReturnType<typeof makePost>[]) => ({
    getCurrentSubreddit: vi.fn(async () => ({
      id: "t5_example",
      name: "ExampleSub",
    })),
    getAppUser: vi.fn(async () => ({ username: "subscriber-goal-app" })),
    getPostById: vi.fn(async (postId: string) =>
      posts.find((post) => post.id === postId),
    ),
    getHotPosts: vi.fn(() => ({ get: vi.fn(async () => posts) })),
    searchPosts: vi.fn(() => ({ all: vi.fn(async () => []) })),
    getNewPosts: vi.fn(() => ({ all: vi.fn(async () => []) })),
    modMail: { createModNotification: vi.fn(async () => undefined) },
  });

  it("pins the newest candidate when every valid goal is unpinned", async () => {
    const older = makePost({
      id: "t3_older",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
    });
    const newer = makePost({
      id: "t3_newer",
      createdAt: "2026-09-16T00:00:00Z",
      postKind: "subscribe-only-v1",
      postHeight: "tiny",
    });
    const result = await ensureExistingSubscriberGoalPinned({
      reddit: makeReddit([older, newer]) as never,
      redis: new InMemoryRedis() as never,
      nowMs,
    });

    expect(result).toMatchObject({
      status: "existing",
      postId: "t3_newer",
      classification: "tiny",
      selectedWasAlreadyPinned: false,
    });
    expect(newer.sticky).toHaveBeenCalledOnce();
    expect(older.sticky).not.toHaveBeenCalled();
  });

  it("preserves one existing pin even when a newer candidate is unpinned", async () => {
    const pinned = makePost({
      id: "t3_pinned",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      pinned: true,
    });
    const newer = makePost({
      id: "t3_newer",
      createdAt: "2026-09-16T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "short",
    });
    const result = await ensureExistingSubscriberGoalPinned({
      reddit: makeReddit([pinned, newer]) as never,
      redis: new InMemoryRedis() as never,
      nowMs,
    });

    expect(result.postId).toBe("t3_pinned");
    expect(pinned.unsticky).not.toHaveBeenCalled();
    expect(newer.sticky).not.toHaveBeenCalled();
  });

  it("consolidates only older classic pins and preserves CTA, Tiny, and ambiguous pins", async () => {
    const oldClassic = makePost({
      id: "t3_oldclassic",
      createdAt: "2026-09-14T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      pinned: true,
    });
    const newClassic = makePost({
      id: "t3_newclassic",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "short",
      pinned: true,
    });
    const cta = makePost({
      id: "t3_cta",
      createdAt: "2026-09-16T00:00:00Z",
      postKind: "cta-only-v1",
      postHeight: "cta",
      pinned: true,
    });
    const tiny = makePost({
      id: "t3_tiny",
      createdAt: "2026-09-16T01:00:00Z",
      postKind: "subscribe-only-v1",
      postHeight: "tiny",
      pinned: true,
    });
    const ambiguous = makePost({
      id: "t3_legacy",
      createdAt: "2026-09-13T00:00:00Z",
      postKind: "subscriber-goal-v1",
      pinned: true,
    });
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", { t3_legacy_goal: "100" });

    const result = await ensureExistingSubscriberGoalPinned({
      reddit: makeReddit([
        oldClassic,
        newClassic,
        cta,
        tiny,
        ambiguous,
      ]) as never,
      redis: redis as never,
      nowMs,
    });

    expect(result.classicPostsUnpinned).toEqual(["t3_oldclassic"]);
    expect(result.protectedPinsPreserved).toEqual(["t3_cta", "t3_tiny"]);
    expect(oldClassic.unsticky).toHaveBeenCalledOnce();
    expect(newClassic.unsticky).not.toHaveBeenCalled();
    expect(cta.unsticky).not.toHaveBeenCalled();
    expect(tiny.unsticky).not.toHaveBeenCalled();
    expect(ambiguous.unsticky).not.toHaveBeenCalled();
  });

  it("records a failed existing-goal pin and sends one accurate modmail", async () => {
    const existing = makePost({
      id: "t3_existing",
      createdAt: "2026-09-16T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      stickyFails: true,
    });
    const reddit = makeReddit([existing]);
    const result = await ensureExistingSubscriberGoalPinned({
      reddit: reddit as never,
      redis: new InMemoryRedis() as never,
      nowMs,
      notifyOnFailure: true,
      stickyVerification: { maxWaitMs: 0, intervalMs: 0 },
    });

    expect(result).toMatchObject({
      status: "existing_not_pinned",
      postId: "t3_existing",
      notificationOutcome: "sent",
    });
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
    expect(reddit.modMail.createModNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyMarkdown: expect.stringContaining("existing valid goal"),
      }),
    );
  });
});
