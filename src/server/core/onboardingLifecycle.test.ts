import { beforeEach, describe, expect, it, vi } from "vitest";
import { watchTestHash } from "../utils/testHashWatch";
import {
  autoCreateNextGoalExhaustedKey,
  autoCreateNextGoalQueueKey,
  autoCreateNextGoalRetryAttemptsKey,
  postAutomaticSuccessorSuppressionSuffix,
} from "../data/subGoalData";
import { autoCreateNextGoalSuccessorsKey } from "./autoCreateNextGoal";
import {
  ensureExistingSubscriberGoalHighlighted,
  onboardingSubscriberGoalLockKey,
  onboardingSubscriberGoalStateKey,
  processDueOnboardingSubscriberGoal,
} from "./onboardingSubscriberGoal";
import {
  onboardingReminderLockKey,
  onboardingReminderStateKey,
  processDueOnboardingReminder,
} from "./onboardingReminder";
import { reconcileOnboardingForLifecycle } from "./onboardingLifecycle";
import {
  highlightManagementStateKey,
  legacyHighlightManagementStateKey,
  saveHighlightManagementBaseline,
} from "../data/highlightManagement";
import { highlightContradictionKey } from "../data/highlightContradiction";
import { postOperationalStateKeyPrefix } from "../data/postOperationalState";

const lifecycleHoisted = vi.hoisted(() => ({
  processDueAutoCreateNextGoals: vi.fn(),
  createSubscriberGoal: vi.fn(),
}));

vi.mock("./autoCreateNextGoal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./autoCreateNextGoal")>();
  return {
    ...actual,
    actualProcessDueAutoCreateNextGoals: actual.processDueAutoCreateNextGoals,
    processDueAutoCreateNextGoals:
      lifecycleHoisted.processDueAutoCreateNextGoals,
  };
});

vi.mock("./createSubscriberGoal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./createSubscriberGoal")>()),
  createSubscriberGoal: lifecycleHoisted.createSubscriberGoal,
}));

class InMemoryRedis {
  watch(key: string) {
    return watchTestHash(this, key);
  }

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

  async expire(): Promise<void> {}

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

  async hIncrBy(
    key: string,
    field: string,
    increment: number,
  ): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    const value = Number(hash.get(field) ?? 0) + increment;
    hash.set(field, String(value));
    this.hashes.set(key, hash);
    return value;
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

  async zScore(key: string, member: string): Promise<number | undefined> {
    return this.sortedSets.get(key)?.get(member);
  }

  async zRem(key: string, members: string[]): Promise<void> {
    const set = this.sortedSets.get(key);
    for (const member of members) set?.delete(member);
  }

  async hScan(key: string): Promise<{
    cursor: number;
    fieldValues: { field: string; value: string }[];
  }> {
    return {
      cursor: 0,
      fieldValues: [...(this.hashes.get(key) ?? [])].map(([field, value]) => ({
        field,
        value,
      })),
    };
  }

  async hMGet(key: string, fields: string[]): Promise<(string | undefined)[]> {
    return fields.map((field) => this.hashes.get(key)?.get(field));
  }
}

const oldArmedAt = Date.parse("2026-09-16T12:00:00.000Z");
const nowMs = Date.parse("2026-09-17T12:00:00.000Z");

function createReddit({
  highlighted = false,
  posts,
  subscriberCount = 2_000,
  nsfw = false,
}: {
  highlighted?: boolean;
  posts?: Record<string, unknown>[];
  subscriberCount?: number;
  nsfw?: boolean;
} = {}) {
  const highlightedPost = {
    id: "t3_highlighted",
    authorName: "subscriber-goal-app",
    subredditId: "t5_example",
    subredditName: "ExampleSub",
    createdAt: new Date(nowMs - 60_000),
    postData: { postKind: "subscriber-goal-v1" },
    isHighlighted: () => true,
    highlight: vi.fn(async () => undefined),
    unhighlight: vi.fn(async () => undefined),
  };
  const availablePosts = posts ?? (highlighted ? [highlightedPost] : []);
  const getHighlightedPosts = vi.fn(async () => {
    if (highlighted) return [{ postId: "t3_highlighted" as const }];
    const result = [] as { postId: `t3_${string}` }[];
    for (const post of availablePosts) {
      const verifier = (post as { isHighlighted?: () => boolean })
        .isHighlighted;
      if (verifier && (await verifier())) {
        result.push({ postId: post.id as `t3_${string}` });
      }
    }
    return result;
  });
  const reorderHighlightedPosts = vi.fn(async () => undefined);
  return {
    getCurrentSubreddit: vi.fn(async () => ({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: subscriberCount,
      type: "public",
      nsfw,
      getHighlightedPosts,
      reorderHighlightedPosts,
    })),
    getAppUser: vi.fn(async () => ({
      username: "subscriber-goal-app",
      getModPermissionsForSubreddit: vi.fn(async () => ["posts"]),
    })),
    getPostById: vi.fn(async (postId: string) =>
      availablePosts.find((post) => post.id === postId),
    ),
    searchPosts: vi.fn(() => ({ all: vi.fn(async () => availablePosts) })),
    getNewPosts: vi.fn(() => ({ all: vi.fn(async () => []) })),
    modMail: { createModNotification: vi.fn(async () => undefined) },
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
    autoCreateNextGoal?: boolean | null;
  },
): Promise<void> {
  await redis.hSet("subscriber_goals", {
    [`${postId}_post_kind`]: "subscriber-goal-v1",
    [`${postId}_post_height`]: "regular",
    [`${postId}_goal`]: String(goal),
    [`${postId}_completed_time`]: String(completedTime),
    ...(autoCreateNextGoal === null
      ? {}
      : {
          [`${postId}_auto_create_next_goal`]: String(autoCreateNextGoal),
        }),
    [`${postId}_subreddit_display_name`]: "ExampleSub",
    [`${postId}_language`]: "en",
    [`${postId}_color_theme`]: "blue",
  });
}

function makeLifecycleGoalPost({
  id,
  createdAt = nowMs - 60_000,
  highlighted = false,
}: {
  id: `t3_${string}`;
  createdAt?: number;
  highlighted?: boolean;
}) {
  let isHighlighted = highlighted;
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
    isHighlighted: vi.fn(() => isHighlighted),
    highlight: vi.fn(async () => {
      isHighlighted = true;
    }),
    unhighlight: vi.fn(async () => {
      isHighlighted = false;
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
    lifecycleHoisted.createSubscriberGoal.mockReset();
    lifecycleHoisted.createSubscriberGoal.mockResolvedValue({
      outcome: "created",
      post: {
        id: "t3_recovered_successor",
        title: "Recovered successor",
        url: "https://www.reddit.com/r/ExampleSub/comments/recovered",
      },
      highlightResult: { issues: [] },
    });
  });

  it("recovers legacy NSFW onboarding once across repeated upgrades", async () => {
    await seedCompleted(redis);
    for (const key of [
      onboardingSubscriberGoalStateKey,
      onboardingReminderStateKey,
    ]) {
      await redis.hSet(key, { ineligibilityReason: "subreddit_not_sfw" });
    }
    const posts: Record<string, unknown>[] = [];
    const reddit = createReddit({ posts, nsfw: true });
    const newPost = makeLifecycleGoalPost({
      id: "t3_nsfw_onboarding",
      highlighted: true,
    });
    lifecycleHoisted.createSubscriberGoal.mockImplementation(async () => {
      posts.push(newPost);
      await seedGoalData(redis, newPost.id, { goal: 3_000 });
      return {
        outcome: "created",
        post: newPost,
        highlightResult: { issues: [] },
      };
    });

    const upgrade = (at: number) =>
      reconcileOnboardingForLifecycle(reddit as never, redis as never, {
        lifecycleSource: "upgrade",
        nowMs: at,
      });
    await expect(upgrade(nowMs)).resolves.toMatchObject({ status: "rearmed" });
    const reminderAt = Number(
      (await redis.hGetAll(onboardingReminderStateKey)).nextRunAt,
    );
    await expect(
      processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: reminderAt,
      }),
    ).resolves.toMatchObject({ status: "sent" });
    const goalAt = Number(
      (await redis.hGetAll(onboardingSubscriberGoalStateKey)).nextRunAt,
    );
    await expect(
      processDueOnboardingSubscriberGoal({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: { promoSubreddit: "SubGoal" } as never,
        nowMs: goalAt,
      }),
    ).resolves.toMatchObject({ status: "created", postId: newPost.id });

    await expect(upgrade(goalAt + 60_000)).resolves.toMatchObject({
      status: "existing",
      postId: newPost.id,
    });
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
    expect(
      lifecycleHoisted.createSubscriberGoal,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        options: expect.objectContaining({
          crosspost: false,
          afterSubscribePreset: "newest-post",
        }),
      }),
    );
  });

  it("recovers a cancelled successor for a highlighted NSFW goal once across upgrades", async () => {
    const source = makeLifecycleGoalPost({
      id: "t3_nsfw_completed",
      highlighted: true,
    });
    const posts = [source];
    const reddit = createReddit({ posts, nsfw: true });
    await seedGoalData(redis, source.id, {
      goal: 1_500,
      completedTime: nowMs - 48 * 60 * 60 * 1000,
    });
    const next = makeLifecycleGoalPost({
      id: "t3_nsfw_successor",
      highlighted: true,
    });
    lifecycleHoisted.createSubscriberGoal.mockImplementation(async () => {
      posts.push(next);
      await seedGoalData(redis, next.id, { goal: 3_000 });
      await source.unhighlight();
      return {
        outcome: "created",
        post: next,
        highlightResult: { issues: [] },
      };
    });
    const module =
      (await import("./autoCreateNextGoal")) as typeof import("./autoCreateNextGoal") & {
        actualProcessDueAutoCreateNextGoals: typeof import("./autoCreateNextGoal").processDueAutoCreateNextGoals;
      };
    lifecycleHoisted.processDueAutoCreateNextGoals.mockImplementation(
      module.actualProcessDueAutoCreateNextGoals,
    );

    const upgrade = (at: number) =>
      reconcileOnboardingForLifecycle(reddit as never, redis as never, {
        lifecycleSource: "upgrade",
        nowMs: at,
      });
    expect(await redis.zRange(autoCreateNextGoalQueueKey)).toEqual([]);
    await expect(upgrade(nowMs)).resolves.toMatchObject({
      status: "replacement_created",
    });
    await expect(upgrade(nowMs + 60_000)).resolves.toMatchObject({
      status: "existing",
      postId: next.id,
    });
    expect(
      lifecycleHoisted.createSubscriberGoal,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        options: expect.objectContaining({
          crosspost: false,
          operationId: `auto-next:${source.id}`,
        }),
      }),
    );
    expect(await redis.hGet(autoCreateNextGoalSuccessorsKey, source.id)).toBe(
      next.id,
    );
  });

  it.each([
    "moderator",
    "automod_filtered",
    "reddit",
    "community_ops",
    "unknown_remover",
  ])(
    "preserves inventory and pending work during %s removal, then restores the same goal",
    async (category) => {
      const post = {
        ...makeLifecycleGoalPost({ id: "t3_paused" }),
        removedByCategory: category as string | undefined,
      };
      await seedGoalData(redis, post.id, { goal: 3000 });
      for (const key of [
        "subscriber_goal_post_registry_v1",
        "posts",
        "updater",
        autoCreateNextGoalQueueKey,
      ]) {
        await redis.zAdd(key, { member: post.id, score: nowMs });
      }
      const beforeHashes = new Map(
        [...redis.hashes].map(([k, v]) => [k, new Map(v)]),
      );
      const beforeSets = new Map(
        [...redis.sortedSets].map(([k, v]) => [k, new Map(v)]),
      );
      const reddit = createReddit({ posts: [post] });
      for (const time of [nowMs, nowMs + 72 * 60 * 60 * 1000]) {
        await expect(
          ensureExistingSubscriberGoalHighlighted({
            reddit: reddit as never,
            redis: redis as never,
            nowMs: time,
          }),
        ).resolves.toMatchObject({
          status: "existing_not_highlighted",
          postId: post.id,
          eligiblePostIds: [post.id],
          unhighlightedEligiblePostIds: [post.id],
        });
        expect(redis.hashes).toEqual(beforeHashes);
        expect(redis.sortedSets).toEqual(beforeSets);
        expect(redis.values.has(`retired_subscriber_goal_v1:${post.id}`)).toBe(
          false,
        );
      }
      expect(post.highlight).not.toHaveBeenCalled();
      expect(lifecycleHoisted.createSubscriberGoal).not.toHaveBeenCalled();
      post.removedByCategory = undefined;
      await expect(
        ensureExistingSubscriberGoalHighlighted({
          reddit: reddit as never,
          redis: redis as never,
          nowMs,
        }),
      ).resolves.toMatchObject({ status: "existing", postId: post.id });
      expect(post.highlight).toHaveBeenCalledOnce();
    },
  );

  it.each(["completed", "tiny", "cta"])(
    "skips removed %s posts without pruning their state",
    async (kind) => {
      const post = {
        ...makeLifecycleGoalPost({ id: "t3_removed", highlighted: true }),
        removedByCategory: "moderator",
        postData: {
          postKind:
            kind === "tiny"
              ? "subscribe-only-v1"
              : kind === "cta"
                ? "cta-only-v1"
                : "subscriber-goal-v1",
          postHeight: kind === "completed" ? "regular" : kind,
        },
      };
      if (kind === "completed")
        await seedGoalData(redis, post.id, {
          goal: 1500,
          completedTime: nowMs - 1000,
        });
      await redis.zAdd("subscriber_goal_post_registry_v1", {
        member: post.id,
        score: nowMs,
      });
      const beforeHashes = new Map(
        [...redis.hashes].map(([k, v]) => [k, new Map(v)]),
      );
      const beforeSets = new Map(
        [...redis.sortedSets].map(([k, v]) => [k, new Map(v)]),
      );
      await expect(
        ensureExistingSubscriberGoalHighlighted({
          reddit: createReddit({ posts: [post] }) as never,
          redis: redis as never,
          nowMs,
        }),
      ).resolves.toMatchObject({ status: "missing", candidateCount: 0 });
      expect(redis.hashes).toEqual(beforeHashes);
      expect(redis.sortedSets).toEqual(beforeSets);
      expect(redis.values.has(`retired_subscriber_goal_v1:${post.id}`)).toBe(
        false,
      );
      expect(post.highlight).not.toHaveBeenCalled();
      expect(post.unhighlight).not.toHaveBeenCalled();
    },
  );

  it.each([
    { unfinished: false, age: "newer", blocks: false },
    { unfinished: true, age: "newer", blocks: true },
    { unfinished: true, age: "older", blocks: false },
    { unfinished: true, age: "same", blocks: false },
    { unfinished: true, age: "unknown", blocks: true },
  ])(
    "handles successor creation with a $age removed classic (unfinished=$unfinished, blocks=$blocks)",
    async ({ unfinished, age, blocks }) => {
      const hour = 60 * 60 * 1000;
      const completedTime = nowMs - 48 * hour;
      const old = {
        ...makeLifecycleGoalPost({ id: "t3_removed_old" }),
        createdAt:
          age === "unknown"
            ? undefined
            : new Date(
                nowMs -
                  60_000 +
                  (age === "newer" ? 1000 : age === "older" ? -1000 : 0),
              ),
        removedByCategory: "moderator" as string | undefined,
      };
      const source = makeLifecycleGoalPost({ id: "t3_due_source" });
      await seedGoalData(redis, old.id, {
        goal: 3000,
        completedTime: unfinished ? 0 : completedTime - hour,
      });
      await seedGoalData(redis, source.id, { goal: 1500, completedTime });
      for (const post of [old, source])
        await redis.zAdd("subscriber_goal_post_registry_v1", {
          member: post.id,
          score: nowMs,
        });
      await redis.zAdd(autoCreateNextGoalQueueKey, {
        member: source.id,
        score: nowMs,
      });
      const module =
        (await import("./autoCreateNextGoal")) as typeof import("./autoCreateNextGoal") & {
          actualProcessDueAutoCreateNextGoals: typeof import("./autoCreateNextGoal").processDueAutoCreateNextGoals;
        };
      const reddit = createReddit({ posts: [old, source] });
      for (const at of blocks ? [nowMs, nowMs + 72 * hour] : [nowMs]) {
        await expect(
          module.actualProcessDueAutoCreateNextGoals({
            reddit: reddit as never,
            redis: redis as never,
            appSettings: { promoSubreddit: "SubscriberGoal" } as never,
            nowMs: at,
          }),
        ).resolves.toMatchObject({
          created: blocks ? 0 : 1,
          rescheduled: blocks ? 1 : 0,
          failed: 0,
          exhausted: 0,
        });
        expect(
          await redis.hGet("subscriber_goals", `${source.id}_completed_time`),
        ).toBe(String(completedTime));
        expect(await redis.hGetAll(autoCreateNextGoalRetryAttemptsKey)).toEqual(
          {},
        );
        expect(await redis.hGetAll(autoCreateNextGoalExhaustedKey)).toEqual({});
      }
      expect(lifecycleHoisted.createSubscriberGoal).toHaveBeenCalledTimes(
        blocks ? 0 : 1,
      );
      expect(old.highlight).not.toHaveBeenCalled();
      expect(old.unhighlight).not.toHaveBeenCalled();
      expect(
        await redis.zScore("subscriber_goal_post_registry_v1", old.id),
      ).toBe(nowMs);
      expect(redis.values.has(`retired_subscriber_goal_v1:${old.id}`)).toBe(
        false,
      );
      if (blocks && age !== "unknown") {
        old.removedByCategory = undefined;
        await ensureExistingSubscriberGoalHighlighted({
          reddit: reddit as never,
          redis: redis as never,
          nowMs: nowMs + 73 * hour,
        });
        expect(old.highlight).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    { age: "older", blocks: false },
    { age: "newer", blocks: true },
    { age: "unknown", blocks: true },
  ])(
    "repairs a live classic with a $age removed unfinished goal (blocks=$blocks)",
    async ({ age, blocks }) => {
      const removed = {
        ...makeLifecycleGoalPost({ id: "t3_removed" }),
        createdAt:
          age === "unknown"
            ? undefined
            : new Date(nowMs - (age === "older" ? 120_000 : 30_000)),
        removedByCategory: "moderator",
      };
      const live = makeLifecycleGoalPost({
        id: "t3_live",
        createdAt: nowMs - 60_000,
      });
      await seedGoalData(redis, removed.id, { goal: 3000 });
      await seedGoalData(redis, live.id, { goal: 3000 });
      for (const post of [removed, live])
        await redis.zAdd("subscriber_goal_post_registry_v1", {
          member: post.id,
          score: nowMs,
        });
      const result = await ensureExistingSubscriberGoalHighlighted({
        reddit: createReddit({ posts: [removed, live] }) as never,
        redis: redis as never,
        nowMs,
      });
      expect(result).toMatchObject({
        status: "existing",
        postId: live.id,
        eligiblePostIds: blocks ? [removed.id, live.id] : [live.id],
      });
      expect(live.highlight).toHaveBeenCalledOnce();
      expect(result.pausedByRemovedGoal).toBe(blocks ? true : undefined);
      expect(removed.highlight).not.toHaveBeenCalled();
      expect(removed.unhighlight).not.toHaveBeenCalled();
      expect(
        await redis.zScore("subscriber_goal_post_registry_v1", removed.id),
      ).toBe(nowMs);
      expect(redis.values.has(`retired_subscriber_goal_v1:${removed.id}`)).toBe(
        false,
      );
    },
  );

  it("repairs an older live goal and completes app repair while a newer removal still blocks successors", async () => {
    const health = await import("./appAccountHealth");
    vi.spyOn(health, "checkAppAccountHealth").mockResolvedValue({
      status: "healthy",
      healthy: true,
    } as never);
    const activity = await import("../data/ctaActivity");
    vi.spyOn(activity, "ensureCommunityPostActivityBackfill").mockResolvedValue(
      undefined as never,
    );
    const postKind = await import("../data/postKindMigration");
    vi.spyOn(postKind, "initializePostKindMigration").mockResolvedValue(
      undefined as never,
    );
    const legacy = await import("../data/legacyAfterSubscribeActionMigration");
    vi.spyOn(
      legacy,
      "initializeLegacyAfterSubscribeActionMigration",
    ).mockResolvedValue(undefined as never);
    const nsfw = await import("../data/nsfwAfterSubscribeActionMigration");
    vi.spyOn(
      nsfw,
      "initializeNsfwAfterSubscribeActionMigration",
    ).mockResolvedValue(undefined as never);
    const flair = await import("./subscriberGoalPostFlair");
    vi.spyOn(flair, "ensureSubscriberGoalPostFlair").mockResolvedValue({
      id: "flair_1",
    } as never);
    vi.spyOn(flair, "backfillSubscriberGoalPostFlair").mockResolvedValue({
      applied: 0,
      failed: [],
    });
    const {
      processDueAppRepair,
      scheduleAppRepair,
      recurringHighlightRepairIntervalMs,
    } = await import("./appRepair");
    const { appRepairStateKey } = await import("../data/highlightRepair");
    const removed = {
      ...makeLifecycleGoalPost({ id: "t3_removed", createdAt: nowMs - 1000 }),
      removedByCategory: "automod_filtered",
    };
    const live = makeLifecycleGoalPost({
      id: "t3_live",
      createdAt: nowMs - 60_000,
    });
    const source = makeLifecycleGoalPost({
      id: "t3_source",
      createdAt: nowMs - 120_000,
    });
    await seedGoalData(redis, removed.id, { goal: 3000 });
    await seedGoalData(redis, live.id, { goal: 3000 });
    await seedGoalData(redis, source.id, {
      goal: 1500,
      completedTime: nowMs - 48 * 60 * 60 * 1000,
    });
    for (const post of [removed, live, source])
      await redis.zAdd("subscriber_goal_post_registry_v1", {
        member: post.id,
        score: nowMs,
      });
    const reddit = createReddit({ posts: [removed, live, source] });
    await scheduleAppRepair(redis as never, nowMs, 0);
    await expect(
      processDueAppRepair({
        reddit: reddit as never,
        redis: redis as never,
        nowMs,
      }),
    ).resolves.toBe("complete");
    expect(live.highlight).toHaveBeenCalledOnce();
    expect(removed.highlight).not.toHaveBeenCalled();
    expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
      status: "complete",
      recurring: "true",
      nextRunAt: String(nowMs + recurringHighlightRepairIntervalMs),
      lastError: "",
    });
    await redis.zAdd(autoCreateNextGoalQueueKey, {
      member: source.id,
      score: nowMs,
    });
    const module =
      (await import("./autoCreateNextGoal")) as typeof import("./autoCreateNextGoal") & {
        actualProcessDueAutoCreateNextGoals: typeof import("./autoCreateNextGoal").processDueAutoCreateNextGoals;
      };
    await expect(
      module.actualProcessDueAutoCreateNextGoals({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: { promoSubreddit: "SubscriberGoal" } as never,
        nowMs,
      }),
    ).resolves.toMatchObject({
      created: 0,
      failed: 0,
      exhausted: 0,
      rescheduled: 1,
    });
    expect(lifecycleHoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(
      await redis.hGet(autoCreateNextGoalSuccessorsKey, source.id),
    ).toBeUndefined();
    expect(
      await redis.zScore(autoCreateNextGoalQueueKey, source.id),
    ).toBeGreaterThan(nowMs);
  });

  it("ignores unrelated removed highlights while inventorying goals", async () => {
    const unrelated = {
      ...makeLifecycleGoalPost({ id: "t3_unrelated", highlighted: true }),
      authorName: "someone-else",
      removedByCategory: "moderator",
    };
    await expect(
      ensureExistingSubscriberGoalHighlighted({
        reddit: createReddit({ posts: [unrelated] }) as never,
        redis: redis as never,
        nowMs,
      }),
    ).resolves.toMatchObject({ status: "missing" });
    expect(unrelated.highlight).not.toHaveBeenCalled();
    expect(unrelated.unhighlight).not.toHaveBeenCalled();
  });

  it("arms a fresh workflow when no highlighted goal exists", async () => {
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

  it("immediately pauses missing-goal upgrade onboarding when account permissions are unhealthy", async () => {
    const reddit = createReddit();
    reddit.getAppUser.mockResolvedValue({
      username: "subscriber-goal-app",
      getModPermissionsForSubreddit: vi.fn(async () => []),
    });

    await expect(
      reconcileOnboardingForLifecycle(reddit as never, redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      }),
    ).resolves.toMatchObject({ status: "rearmed" });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "awaiting_warning",
      intent: "missing_goal",
      pausedForAccountRecovery: "true",
    });
    await expect(
      redis.hGetAll(onboardingReminderStateKey),
    ).resolves.toMatchObject({
      status: "pending",
      nextRunAt: String(nowMs + 5 * 60_000),
    });
  });

  it("does not arm onboarding when rearming is disabled and no goal exists", async () => {
    await expect(
      reconcileOnboardingForLifecycle(createReddit() as never, redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
        allowOnboardingRearm: false,
      }),
    ).resolves.toEqual({
      status: "unchanged",
      reason: "onboarding_ineligible",
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toEqual({});
    await expect(redis.hGetAll(onboardingReminderStateKey)).resolves.toEqual(
      {},
    );
  });

  it("records a highlighted goal as existing without arming timers", async () => {
    const reddit = createReddit({ highlighted: true });

    await expect(
      reconcileOnboardingForLifecycle(reddit as never, redis as never, {
        lifecycleSource: "install",
        nowMs,
      }),
    ).resolves.toMatchObject({
      status: "existing",
      postId: "t3_highlighted",
      existingSource: "highlighted",
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "existing",
      postId: "t3_highlighted",
    });
    await expect(
      redis.hGetAll(onboardingReminderStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      result: "existing",
      postId: "t3_highlighted",
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
    "created_not_highlighted",
  ])(
    "re-arms terminal %s state when no highlighted goal exists",
    async (result) => {
      await seedCompleted(redis, result, "sent");

      await expect(
        reconcileOnboardingForLifecycle(
          createReddit() as never,
          redis as never,
          {
            lifecycleSource: "upgrade",
            nowMs,
          },
        ),
      ).resolves.toMatchObject({ status: "rearmed" });
      await expect(
        redis.hGetAll(onboardingSubscriberGoalStateKey),
      ).resolves.toMatchObject({
        status: "awaiting_warning",
        resultStatus: "",
      });
      await expect(
        redis.hGetAll(onboardingReminderStateKey),
      ).resolves.toMatchObject({ status: "pending", result: "" });
    },
  );

  it.each([true, false])(
    "resumes exhausted onboarding lookup only with complete original metadata (safe=%s)",
    async (safe) => {
      await seedCompleted(redis, "submission_reconciliation_exhausted", "sent");
      const previous = await redis.hGetAll(onboardingSubscriberGoalStateKey);
      await redis.hSet("subscriber_goal_creation_v1:" + previous.operationId, {
        status: "submission_unknown",
        reconciliationStatus: "exhausted",
        reconciliationAttempts: "6",
        ...(safe
          ? {
              submissionMarker: "onboarding-original",
              subredditId: "t5_example",
              subredditName: "ExampleSub",
            }
          : {}),
      });
      const result = await reconcileOnboardingForLifecycle(
        createReddit() as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      );
      expect(result.status).toBe(safe ? "rearmed" : "unchanged");
      await expect(
        redis.hGetAll(onboardingSubscriberGoalStateKey),
      ).resolves.toMatchObject({
        operationId: previous.operationId,
        status: safe ? "pending" : "complete",
        resultStatus: safe
          ? "submission_reconciliation_pending"
          : "submission_reconciliation_exhausted",
      });
      if (safe) {
        await expect(
          redis.hGetAll("subscriber_goal_creation_v1:" + previous.operationId),
        ).resolves.toMatchObject({
          status: "submission_unknown",
          submissionMarker: "onboarding-original",
          reconciliationAttempts: "0",
          reconciliationNextAt: String(nowMs),
        });
        await expect(
          reconcileOnboardingForLifecycle(
            createReddit() as never,
            redis as never,
            { lifecycleSource: "upgrade", nowMs: nowMs + 1 },
          ),
        ).resolves.toMatchObject({ status: "unchanged" });
      }
    },
  );

  it("re-arms prerequisite exhaustion with the same operation and a fresh window", async () => {
    const {
      automaticGoalPrerequisiteRetriesKey,
      automaticGoalRetryGenerationsKey,
    } = await import("./automaticGoalRetry");
    await seedCompleted(redis, "retry_exhausted", "sent");
    const previous = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    await redis.hSet(automaticGoalPrerequisiteRetriesKey, {
      [previous.operationId!]: "53",
      [previous.operationId + ":firstDeferredAt"]: String(
        nowMs - 48 * 3_600_000,
      ),
    });
    await expect(
      reconcileOnboardingForLifecycle(createReddit() as never, redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      }),
    ).resolves.toMatchObject({
      status: "rearmed",
      operationId: previous.operationId,
    });
    expect(await redis.hGetAll(automaticGoalPrerequisiteRetriesKey)).toEqual(
      {},
    );
    expect(
      await redis.hGet(automaticGoalRetryGenerationsKey, previous.operationId!),
    ).toBe("1");
    expect(await redis.hGetAll(onboardingSubscriberGoalStateKey)).toMatchObject(
      { status: "awaiting_warning", operationId: previous.operationId },
    );
  });

  it("preserves active operation identity and timers when no highlight exists", async () => {
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

  it("turns an active workflow terminal when a highlighted goal is found", async () => {
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
        createReddit({ highlighted: true }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({ status: "existing", postId: "t3_highlighted" });
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

  it("preserves mandatory successor work when onboarding rearming is disabled", async () => {
    const completedTime = nowMs - 60 * 60 * 1000;
    const post = makeLifecycleGoalPost({ id: "t3_completed" });
    await seedGoalData(redis, post.id, { goal: 1_500, completedTime });
    await redis.zAdd(autoCreateNextGoalQueueKey, {
      member: post.id,
      score: nowMs + 60_000,
    });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [post] }) as never,
        redis as never,
        {
          lifecycleSource: "upgrade",
          nowMs,
          allowOnboardingRearm: false,
        },
      ),
    ).resolves.toMatchObject({
      status: "replacement_scheduled",
      sourcePostId: post.id,
    });

    expect(post.highlight).not.toHaveBeenCalled();
    expect(
      lifecycleHoisted.processDueAutoCreateNextGoals,
    ).not.toHaveBeenCalled();
    await expect(redis.zRange(autoCreateNextGoalQueueKey)).resolves.toEqual([
      { member: post.id, score: nowMs + 60_000 },
    ]);
  });

  it("uses the original deadline for an enabled overdue goal during upgrade", async () => {
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
    ).resolves.toMatchObject({ status: "replacement_created" });

    expect(post.highlight).not.toHaveBeenCalled();
    expect(lifecycleHoisted.processDueAutoCreateNextGoals).toHaveBeenCalled();
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "replacement_created",
      postId: post.id,
    });
  });

  it("repairs a completed legacy goal whose auto setting was never recorded", async () => {
    const post = makeLifecycleGoalPost({ id: "t3_legacy_unconfigured" });
    await seedGoalData(redis, post.id, {
      goal: 1_500,
      completedTime: nowMs - 7 * 24 * 60 * 60 * 1000,
      autoCreateNextGoal: null,
    });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [post] }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({ status: "replacement_scheduled" });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "replacement_scheduled",
      postId: post.id,
    });
    await expect(redis.zRange(autoCreateNextGoalQueueKey)).resolves.toEqual([
      { member: post.id, score: nowMs - 6 * 24 * 60 * 60 * 1000 },
    ]);
  });

  it("preserves an existing successor deadline exactly across an upgrade", async () => {
    const post = makeLifecycleGoalPost({ id: "t3_in_flight" });
    const runAt = nowMs + 12 * 60 * 60 * 1000;
    await seedGoalData(redis, post.id, {
      goal: 1_500,
      completedTime: nowMs - 12 * 60 * 60 * 1000,
    });
    await redis.zAdd(autoCreateNextGoalQueueKey, {
      member: post.id,
      score: runAt,
    });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [post] }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({ status: "replacement_scheduled" });
    await expect(redis.zRange(autoCreateNextGoalQueueKey)).resolves.toEqual([
      { member: post.id, score: runAt },
    ]);
    expect(
      lifecycleHoisted.processDueAutoCreateNextGoals,
    ).not.toHaveBeenCalled();
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
    ).resolves.toMatchObject({ status: "replacement_scheduled" });

    expect(post.highlight).not.toHaveBeenCalled();
    await expect(
      redis.hGet("subscriber_goals", `${post.id}_completed_time`),
    ).resolves.toBe(String(nowMs));
    await expect(
      redis.hGet(
        "subscriber_goals",
        `${post.id}${postAutomaticSuccessorSuppressionSuffix}`,
      ),
    ).resolves.toBeUndefined();
    await expect(redis.zRange(autoCreateNextGoalQueueKey)).resolves.toEqual([
      { member: post.id, score: nowMs + 24 * 60 * 60 * 1000 },
    ]);
  });

  it("lets a protected Tiny highlight suppress an overdue classic replacement", async () => {
    const completed = makeLifecycleGoalPost({ id: "t3_completed" });
    const tiny = {
      ...makeLifecycleGoalPost({ id: "t3_tiny", highlighted: true }),
      postData: { postKind: "subscribe-only-v1", postHeight: "tiny" },
    };
    await seedGoalData(redis, completed.id, {
      goal: 1_500,
      completedTime: nowMs - 48 * 60 * 60 * 1000,
    });
    const deferredRecheckAt = nowMs + 60 * 60 * 1000;
    await redis.zAdd(autoCreateNextGoalQueueKey, {
      member: completed.id,
      score: deferredRecheckAt,
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
    ).resolves.toMatchObject({
      status: "existing",
      postId: tiny.id,
    });
    expect(tiny.unhighlight).not.toHaveBeenCalled();
    expect(completed.highlight).not.toHaveBeenCalled();
    await expect(redis.zRange(autoCreateNextGoalQueueKey)).resolves.toEqual([
      { member: completed.id, score: deferredRecheckAt },
    ]);
  });

  it("seeds and resumes legacy successor recovery around a protected Tiny post", async () => {
    const completed = makeLifecycleGoalPost({ id: "t3_legacy_completed" });
    const tiny = {
      ...makeLifecycleGoalPost({ id: "t3_legacy_tiny", highlighted: true }),
      postData: { postKind: "subscribe-only-v1", postHeight: "tiny" },
      removedByCategory: undefined as string | undefined,
    };
    await seedGoalData(redis, completed.id, {
      goal: 1_500,
      completedTime: nowMs - 48 * 60 * 60 * 1000,
      autoCreateNextGoal: false,
    });
    const autoCreateNextGoalModule =
      (await import("./autoCreateNextGoal")) as typeof import("./autoCreateNextGoal") & {
        actualProcessDueAutoCreateNextGoals: typeof import("./autoCreateNextGoal").processDueAutoCreateNextGoals;
      };
    lifecycleHoisted.processDueAutoCreateNextGoals.mockImplementation(
      autoCreateNextGoalModule.actualProcessDueAutoCreateNextGoals,
    );
    const reddit = createReddit({ posts: [completed, tiny] });

    await expect(
      reconcileOnboardingForLifecycle(reddit as never, redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      }),
    ).resolves.toMatchObject({ status: "existing", postId: tiny.id });

    expect(lifecycleHoisted.createSubscriberGoal).not.toHaveBeenCalled();
    const [deferred] = await redis.zRange(autoCreateNextGoalQueueKey);
    expect(deferred).toMatchObject({ member: completed.id });
    expect(deferred!.score).toBeGreaterThan(nowMs);

    tiny.removedByCategory = "deleted";
    await expect(
      autoCreateNextGoalModule.actualProcessDueAutoCreateNextGoals({
        reddit: reddit as never,
        redis: redis as never,
        appSettings: {
          promoSubreddit: "SubscriberGoal",
        } as never,
        nowMs: deferred!.score,
      }),
    ).resolves.toMatchObject({ created: 1 });
    expect(lifecycleHoisted.createSubscriberGoal).toHaveBeenCalledOnce();
    await expect(redis.zRange(autoCreateNextGoalQueueKey)).resolves.toEqual([]);
  });

  it("keeps failed overdue work in successor retry recovery", async () => {
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
      postId: post.id,
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

  it("recovers mandatory successor work for a legacy disabled goal", async () => {
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
      status: "replacement_scheduled",
      sourcePostId: post.id,
    });
    expect(post.highlight).not.toHaveBeenCalled();
    expect(lifecycleHoisted.processDueAutoCreateNextGoals).toHaveBeenCalled();
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "replacement_scheduled",
      postId: post.id,
    });
  });

  it("moves mandatory work to the newest completed source despite a legacy opt-out", async () => {
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
    await redis.zAdd(autoCreateNextGoalQueueKey, {
      member: enabled.id,
      score: nowMs + 60_000,
    });
    await redis.hSet(autoCreateNextGoalRetryAttemptsKey, { [enabled.id]: "2" });
    await redis.hSet(autoCreateNextGoalExhaustedKey, { [enabled.id]: "6" });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [enabled, newerDisabled] }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({
      status: "replacement_scheduled",
      sourcePostId: newerDisabled.id,
    });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "replacement_scheduled",
      postId: newerDisabled.id,
    });
    await expect(redis.zRange(autoCreateNextGoalQueueKey)).resolves.toEqual([
      {
        member: newerDisabled.id,
        score: nowMs - 12 * 60 * 60 * 1000,
      },
    ]);
    await expect(
      redis.hGet(autoCreateNextGoalRetryAttemptsKey, enabled.id),
    ).resolves.toBeUndefined();
    await expect(
      redis.hGet(autoCreateNextGoalExhaustedKey, enabled.id),
    ).resolves.toBeUndefined();
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
    expect(active.highlight).toHaveBeenCalledOnce();
    expect(completed.highlight).not.toHaveBeenCalled();
    expect(
      lifecycleHoisted.processDueAutoCreateNextGoals,
    ).not.toHaveBeenCalled();
  });

  it("recovers a due automatic successor during reinstall reconciliation", async () => {
    const post = makeLifecycleGoalPost({ id: "t3_completed" });
    await seedGoalData(redis, post.id, {
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
        createReddit({ posts: [post] }) as never,
        redis as never,
        { lifecycleSource: "install", nowMs },
      ),
    ).resolves.toMatchObject({
      status: "replacement_created",
      sourcePostId: post.id,
    });

    expect(post.highlight).not.toHaveBeenCalled();
    expect(
      lifecycleHoisted.processDueAutoCreateNextGoals,
    ).toHaveBeenCalledOnce();
  });

  it("records newly detected completion during install and schedules its delay", async () => {
    const post = makeLifecycleGoalPost({ id: "t3_install_met" });
    await seedGoalData(redis, post.id, { goal: 1_500 });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [post], subscriberCount: 2_000 }) as never,
        redis as never,
        { lifecycleSource: "install", nowMs },
      ),
    ).resolves.toMatchObject({ status: "replacement_scheduled" });

    expect(post.highlight).not.toHaveBeenCalled();
    await expect(redis.zRange(autoCreateNextGoalQueueKey)).resolves.toEqual([
      { member: post.id, score: nowMs + 24 * 60 * 60 * 1000 },
    ]);
    await expect(
      redis.hGet("subscriber_goals", `${post.id}_completed_time`),
    ).resolves.toBe(String(nowMs));
    await expect(
      redis.hGet(
        "subscriber_goals",
        `${post.id}${postAutomaticSuccessorSuppressionSuffix}`,
      ),
    ).resolves.toBeUndefined();
  });

  it("ignores a legacy successor opt-out during reinstall", async () => {
    const post = makeLifecycleGoalPost({ id: "t3_install_opted_out" });
    await seedGoalData(redis, post.id, {
      goal: 1_500,
      completedTime: nowMs - 48 * 60 * 60 * 1000,
      autoCreateNextGoal: false,
    });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [post] }) as never,
        redis as never,
        { lifecycleSource: "install", nowMs },
      ),
    ).resolves.toMatchObject({ status: "replacement_scheduled" });

    expect(lifecycleHoisted.processDueAutoCreateNextGoals).toHaveBeenCalled();
    await expect(redis.zRange(autoCreateNextGoalQueueKey)).resolves.toEqual([
      { member: post.id, score: nowMs - 24 * 60 * 60 * 1000 },
    ]);
  });

  it("preserves an existing replacement retry and its backoff", async () => {
    const post = makeLifecycleGoalPost({ id: "t3_retrying" });
    await seedGoalData(redis, post.id, {
      goal: 1_500,
      completedTime: nowMs - 48 * 60 * 60 * 1000,
    });
    const retryAt = nowMs + 15 * 60 * 1000;
    await redis.zAdd(autoCreateNextGoalQueueKey, {
      member: post.id,
      score: retryAt,
    });
    await redis.hSet(autoCreateNextGoalRetryAttemptsKey, { [post.id]: "2" });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [post] }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({ status: "replacement_retrying" });

    await expect(redis.zRange(autoCreateNextGoalQueueKey)).resolves.toEqual([
      { member: post.id, score: retryAt },
    ]);
    await expect(
      redis.hGet(autoCreateNextGoalRetryAttemptsKey, post.id),
    ).resolves.toBe("2");
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "replacement_retrying",
      postId: post.id,
    });
    expect(
      lifecycleHoisted.processDueAutoCreateNextGoals,
    ).not.toHaveBeenCalled();
  });

  it("rearms ordinary exhausted replacement state during upgrade", async () => {
    const post = makeLifecycleGoalPost({ id: "t3_exhausted" });
    await seedGoalData(redis, post.id, {
      goal: 1_500,
      completedTime: nowMs - 48 * 60 * 60 * 1000,
    });
    await redis.hSet(autoCreateNextGoalExhaustedKey, { [post.id]: "6" });

    await expect(
      reconcileOnboardingForLifecycle(
        createReddit({ posts: [post] }) as never,
        redis as never,
        { lifecycleSource: "upgrade", nowMs },
      ),
    ).resolves.toMatchObject({ status: "replacement_scheduled" });

    await expect(redis.zRange(autoCreateNextGoalQueueKey)).resolves.toEqual([
      { member: post.id, score: nowMs - 24 * 60 * 60 * 1000 },
    ]);
    await expect(
      redis.hGet(autoCreateNextGoalExhaustedKey, post.id),
    ).resolves.toBeUndefined();
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      resultStatus: "replacement_scheduled",
      postId: post.id,
    });
    expect(
      lifecycleHoisted.processDueAutoCreateNextGoals,
    ).toHaveBeenCalledOnce();
  });
});

describe("existing goal highlight ensurance", () => {
  const makePost = ({
    id,
    createdAt,
    postKind,
    postHeight,
    highlighted = false,
    highlightFails = false,
    highlightError,
    archived = false,
    locked = false,
    listed,
    highlightLabel,
    highlightedUntil,
  }: {
    id: `t3_${string}`;
    createdAt: string;
    postKind?: string;
    postHeight?: string;
    highlighted?: boolean;
    highlightFails?: boolean;
    highlightError?: string;
    archived?: boolean;
    locked?: boolean;
    listed?: boolean;
    highlightLabel?: "ANNOUNCEMENT" | "EVENT";
    highlightedUntil?: Date;
  }) => {
    let isHighlighted = highlighted;
    const post = {
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
      listed,
      highlightLabel,
      highlightedUntil,
      archived,
      locked,
      isHighlighted: vi.fn(() => isHighlighted),
      highlight: vi.fn(
        async (options?: {
          highlightUntil?: Date;
          highlightLabelType?: "ANNOUNCEMENT" | "EVENT";
        }) => {
          if (highlightFails || highlightError)
            throw new Error(highlightError ?? "highlight slots full");
          isHighlighted = true;
          void options;
        },
      ),
      unhighlight: vi.fn(async () => {
        isHighlighted = false;
      }),
    };
    return post;
  };

  const makeReddit = (posts: ReturnType<typeof makePost>[]) => {
    const getHighlightedPosts = vi.fn(async () => {
      const highlightedPosts = [] as {
        postId: `t3_${string}`;
        highlightLabel?: "ANNOUNCEMENT" | "EVENT";
        highlightedUntil?: Date;
      }[];
      for (const post of posts) {
        if (post.listed ?? (await post.isHighlighted())) {
          highlightedPosts.push({
            postId: post.id as `t3_${string}`,
            ...(post.highlightLabel
              ? { highlightLabel: post.highlightLabel }
              : {}),
            ...(post.highlightedUntil
              ? { highlightedUntil: post.highlightedUntil }
              : {}),
          });
        }
      }
      return highlightedPosts;
    });
    return {
      getCurrentSubreddit: vi.fn(async () => ({
        id: "t5_example",
        name: "ExampleSub",
        getHighlightedPosts,
        reorderHighlightedPosts: vi.fn(async () => undefined),
      })),
      getAppUser: vi.fn(async () => ({
        username: "subscriber-goal-app",
        getModPermissionsForSubreddit: vi.fn(async () => ["posts"]),
      })),
      getPostById: vi.fn(async (postId: string) =>
        posts.find((post) => post.id === postId),
      ),
      searchPosts: vi.fn(() => ({ all: vi.fn(async () => posts) })),
      getNewPosts: vi.fn(() => ({ all: vi.fn(async () => []) })),
      modMail: { createModNotification: vi.fn(async () => undefined) },
    };
  };

  it("fills available slots newest first and quietly restores a waiting goal when a slot opens", async () => {
    const protectedPosts = Array.from({ length: 4 }, (_, i) => ({
      ...makePost({
        id: `t3_protected${i}`,
        createdAt: "2026-09-14",
        highlighted: true,
      }),
      authorName: i % 2 ? "moderator" : "other-app",
    }));
    const older = makePost({
      id: "t3_older",
      createdAt: "2026-09-15",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
    });
    const tiny = makePost({
      id: "t3_tiny",
      createdAt: "2026-09-16",
      postKind: "subscribe-only-v1",
      postHeight: "tiny",
    });
    const cta = makePost({
      id: "t3_cta",
      createdAt: "2026-09-17",
      postKind: "cta-only-v1",
      postHeight: "cta",
    });
    const redis = new InMemoryRedis();
    await seedGoalData(redis, older.id, { goal: 3000 });
    const reddit = makeReddit([older, tiny, cta, ...protectedPosts]);
    const run = (time: number) =>
      ensureExistingSubscriberGoalHighlighted({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: time,
        notifyOnFailure: true,
        reconciliationContext: "repair",
      });
    const blocked = await run(nowMs);
    expect(blocked).toMatchObject({
      capacityOnly: true,
      unhighlightedEligiblePostIds: [older.id],
    });
    expect(cta.highlight.mock.invocationCallOrder[0]).toBeLessThan(
      tiny.highlight.mock.invocationCallOrder[0]!,
    );
    expect(older.highlight).not.toHaveBeenCalled();
    await run(nowMs + 60_000);
    expect(reddit.modMail.createModNotification).not.toHaveBeenCalled();
    expect(
      await redis.hGetAll("app_repair_community_highlights_v3_state"),
    ).toEqual({});
    for (const post of protectedPosts)
      expect(post.unhighlight).not.toHaveBeenCalled();
    await protectedPosts[0]!.unhighlight();
    await expect(run(nowMs + 6 * 60 * 60 * 1000)).resolves.toMatchObject({
      status: "existing",
      unhighlightedEligiblePostIds: [],
    });
    expect(older.highlight).toHaveBeenCalledOnce();
    expect(tiny.unhighlight).not.toHaveBeenCalled();
    expect(cta.unhighlight).not.toHaveBeenCalled();
    expect(reddit.modMail.createModNotification).not.toHaveBeenCalled();
  });

  it("sends one permission Modmail for multiple goals and reopens the incident after recovery", async () => {
    const posts = Array.from({ length: 3 }, (_, i) =>
      makePost({
        id: `t3_goal${i}`,
        createdAt: `2026-09-1${i + 4}`,
        postKind: "subscribe-only-v1",
        postHeight: "tiny",
      }),
    );
    const reddit = makeReddit(posts);
    const permissions = vi.fn(async (): Promise<string[]> => []);
    reddit.getAppUser.mockResolvedValue({
      username: "subscriber-goal-app",
      getModPermissionsForSubreddit: permissions,
    });
    const redis = new InMemoryRedis();
    const run = (time: number) =>
      ensureExistingSubscriberGoalHighlighted({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: time,
        notifyOnFailure: true,
        reconciliationContext: "repair",
      });
    await expect(run(nowMs)).resolves.toMatchObject({
      notificationOutcome: "sent",
      failureCategories: ["permission"],
    });
    const message = reddit.modMail.createModNotification.mock
      .calls[0] as unknown as [{ bodyMarkdown: string }];
    for (const post of posts) {
      expect(message[0].bodyMarkdown).toContain(
        "/comments/" + post.id.slice(3),
      );
      expect(post.highlight).not.toHaveBeenCalled();
    }
    await expect(run(nowMs + 60_000)).resolves.toMatchObject({
      notificationOutcome: "skipped_duplicate",
    });
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
    permissions.mockResolvedValue(["posts"]);
    await run(nowMs + 120_000);
    for (const post of posts) await post.unhighlight();
    permissions.mockResolvedValue([]);
    await run(nowMs + 180_000);
    expect(reddit.modMail.createModNotification).toHaveBeenCalledTimes(2);
  });

  it("restores an unhighlighted protected Tiny post", async () => {
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
    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: makeReddit([older, newer]) as never,
      redis: new InMemoryRedis() as never,
      nowMs,
    });

    expect(result).toMatchObject({
      status: "existing",
      postId: "t3_newer",
      classification: "tiny",
      selectedWasAlreadyHighlighted: false,
    });
    expect(newer.highlight).toHaveBeenCalledOnce();
    expect(older.highlight).not.toHaveBeenCalled();
  });

  it("restores an unhighlighted CTA post", async () => {
    const cta = makePost({
      id: "t3_cta_recovery",
      createdAt: "2026-09-16T00:00:00Z",
      postKind: "cta-only-v1",
      postHeight: "cta",
    });

    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: makeReddit([cta]) as never,
      redis: new InMemoryRedis() as never,
      nowMs,
    });

    expect(result).toMatchObject({
      status: "existing",
      postId: cta.id,
      classification: "cta",
      eligiblePostIds: [cta.id],
      unhighlightedEligiblePostIds: [],
    });
    expect(cta.highlight).toHaveBeenCalledOnce();
  });

  it("reconciles every active classic goal without displacing either", async () => {
    const highlighted = makePost({
      id: "t3_highlighted",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: true,
    });
    const newer = makePost({
      id: "t3_newer",
      createdAt: "2026-09-16T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "short",
    });
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", {
      t3_highlighted_goal: "3000",
      t3_newer_goal: "4000",
    });
    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: makeReddit([highlighted, newer]) as never,
      redis: redis as never,
      nowMs,
    });

    expect(result).toMatchObject({
      status: "existing",
      eligiblePostIds: ["t3_newer", "t3_highlighted"],
      unhighlightedEligiblePostIds: [],
    });
    expect(highlighted.unhighlight).not.toHaveBeenCalled();
    expect(newer.highlight).toHaveBeenCalledOnce();
  });

  it("consolidates only older classic highlights and preserves CTA, Tiny, and ambiguous highlights", async () => {
    const oldClassic = makePost({
      id: "t3_oldclassic",
      createdAt: "2026-09-14T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: true,
    });
    const newClassic = makePost({
      id: "t3_newclassic",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "short",
      highlighted: true,
    });
    const cta = makePost({
      id: "t3_cta",
      createdAt: "2026-09-16T00:00:00Z",
      postKind: "cta-only-v1",
      postHeight: "cta",
      highlighted: true,
    });
    const tiny = makePost({
      id: "t3_tiny",
      createdAt: "2026-09-16T01:00:00Z",
      postKind: "subscribe-only-v1",
      postHeight: "tiny",
      highlighted: true,
    });
    const ambiguous = makePost({
      id: "t3_legacy",
      createdAt: "2026-09-13T00:00:00Z",
      postKind: "subscriber-goal-v1",
      highlighted: true,
    });
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", {
      t3_oldclassic_goal: "1000",
      t3_newclassic_goal: "2000",
      t3_legacy_goal: "100",
    });

    const result = await ensureExistingSubscriberGoalHighlighted({
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

    expect(result.classicPostsUnhighlighted).toEqual([]);
    expect(result.protectedHighlightsPreserved).toEqual(["t3_cta", "t3_tiny"]);
    expect(oldClassic.unhighlight).not.toHaveBeenCalled();
    expect(newClassic.unhighlight).not.toHaveBeenCalled();
    expect(cta.unhighlight).not.toHaveBeenCalled();
    expect(tiny.unhighlight).not.toHaveBeenCalled();
    expect(ambiguous.unhighlight).not.toHaveBeenCalled();
  });

  it("keeps the only active goal and removes two completed legacy classics", async () => {
    const firstCompleted = makePost({
      id: "t3_completed_one",
      createdAt: "2026-09-13T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: true,
    });
    const secondCompleted = makePost({
      id: "t3_completed_two",
      createdAt: "2026-09-14T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: true,
    });
    const active = makePost({
      id: "t3_active_goal",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: true,
    });
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", {
      t3_completed_one_goal: "1000",
      t3_completed_one_completed_time: String(nowMs - 20_000),
      t3_completed_two_goal: "2000",
      t3_completed_two_completed_time: String(nowMs - 10_000),
      t3_active_goal_goal: "3000",
    });
    await redis.hSet(autoCreateNextGoalSuccessorsKey, {
      [firstCompleted.id]: "t3_existing_successor",
    });

    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: makeReddit([firstCompleted, secondCompleted, active]) as never,
      redis: redis as never,
      nowMs,
      reconciliationContext: "legacy_upgrade",
    });

    expect(result).toMatchObject({ status: "existing", postId: active.id });
    expect(result.classicPostsUnhighlighted).toEqual([]);
    expect(firstCompleted.unhighlight).not.toHaveBeenCalled();
    expect(secondCompleted.unhighlight).not.toHaveBeenCalled();
    expect(active.unhighlight).not.toHaveBeenCalled();
    await expect(
      redis.hGet(autoCreateNextGoalSuccessorsKey, firstCompleted.id),
    ).resolves.toBe("t3_existing_successor");
    await expect(
      redis.hGet(autoCreateNextGoalSuccessorsKey, secondCompleted.id),
    ).resolves.toBe(active.id);
  });

  it.each(["none", "reordered"])("treats a slot change as informational with a stored %s override", async (moderatorOverride) => {
    const scheduled = {
      ...makePost({ id: "t3_scheduled", createdAt: "2026-09-16T00:00:00Z", highlighted: true }),
      authorName: "ScheduleCreator",
    };
    const active = makePost({
      id: "t3_active_slot",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: true,
    });
    const reddit = makeReddit([scheduled, active]);
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", { t3_active_slot_goal: "3000" });
    await saveHighlightManagementBaseline(redis as never, {
      canonicalPostId: active.id,
      highlighted: true,
      position: 0,
      highlightLabel: null,
      highlightedUntil: null,
      moderatorOverride: "none",
      reconciledAt: nowMs,
    });
    await redis.hSet(highlightManagementStateKey, { moderatorOverride });

    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: reddit as never,
      redis: redis as never,
      nowMs,
      reconciliationContext: "repair",
    });

    expect(result.status).toBe("existing");
    expect(result.moderatorOverride).toBeUndefined();
    expect(active.highlight).not.toHaveBeenCalled();
    expect(scheduled.unhighlight).not.toHaveBeenCalled();
    await expect(redis.hGetAll(highlightManagementStateKey)).resolves.toMatchObject({
      position: "1",
      moderatorOverride: "none",
    });
  });

  it("restores a moderator-unhighlighted active goal", async () => {
    const active = makePost({
      id: "t3_moderator_override",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
    });
    const reddit = makeReddit([active]);
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", {
      t3_moderator_override_goal: "3000",
    });
    await ensureExistingSubscriberGoalHighlighted({
      reddit: reddit as never,
      redis: redis as never,
      nowMs,
      reconciliationContext: "legacy_upgrade",
    });
    expect(active.highlight).toHaveBeenCalledOnce();
    await saveHighlightManagementBaseline(redis as never, {
      canonicalPostId: active.id,
      highlighted: true,
      position: 0,
      highlightLabel: "EVENT",
      highlightedUntil: nowMs + 60 * 60 * 1000,
      moderatorOverride: "none",
      reconciledAt: nowMs,
    });
    await active.unhighlight();
    active.highlight.mockClear();

    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: reddit as never,
      redis: redis as never,
      nowMs: nowMs + 60_000,
      reconciliationContext: "repair",
    });

    expect(result).toMatchObject({
      status: "existing",
    });
    expect(active.highlight).toHaveBeenCalledOnce();
    await expect(
      redis.hGetAll(highlightManagementStateKey),
    ).resolves.toMatchObject({
      moderatorOverride: "none",
      highlightedUntil: String(nowMs + 60 * 60 * 1000),
    });
  });

  it("records an elapsed highlight expiration without making it permanent", async () => {
    const active = makePost({
      id: "t3_expired",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: false,
      highlightedUntil: new Date(nowMs - 1_000),
    });
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", { t3_expired_goal: "3000" });
    await saveHighlightManagementBaseline(redis as never, {
      canonicalPostId: active.id,
      highlighted: true,
      position: 0,
      highlightLabel: "ANNOUNCEMENT",
      highlightedUntil: nowMs - 1_000,
      moderatorOverride: "none",
      reconciledAt: nowMs - 60_000,
    });

    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: makeReddit([active]) as never,
      redis: redis as never,
      nowMs,
      reconciliationContext: "repair",
    });

    expect(result).toMatchObject({
      status: "existing",
    });
    expect(active.highlight).toHaveBeenCalledOnce();
    await expect(
      redis.hGetAll(highlightManagementStateKey),
    ).resolves.toMatchObject({ moderatorOverride: "none" });
  });

  it("adopts moderator-edited label and expiration metadata", async () => {
    const newExpiration = new Date(nowMs + 2 * 60 * 60 * 1000);
    const active = makePost({
      id: "t3_metadata",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: true,
      highlightLabel: "EVENT",
      highlightedUntil: newExpiration,
    });
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", { t3_metadata_goal: "3000" });
    await saveHighlightManagementBaseline(redis as never, {
      canonicalPostId: active.id,
      highlighted: true,
      position: 0,
      highlightLabel: "ANNOUNCEMENT",
      highlightedUntil: nowMs + 60 * 60 * 1000,
      moderatorOverride: "none",
      reconciledAt: nowMs - 60_000,
    });

    await ensureExistingSubscriberGoalHighlighted({
      reddit: makeReddit([active]) as never,
      redis: redis as never,
      nowMs,
      reconciliationContext: "repair",
    });

    await expect(
      redis.hGetAll(highlightManagementStateKey),
    ).resolves.toMatchObject({
      highlightLabel: "EVENT",
      highlightedUntil: String(newExpiration.getTime()),
    });
  });

  it("migrates a v1 baseline from live metadata without rehighlighting", async () => {
    const expiration = new Date(nowMs + 2 * 60 * 60 * 1000);
    const active = makePost({
      id: "t3_v1_baseline",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: true,
      highlightLabel: "EVENT",
      highlightedUntil: expiration,
    });
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", { t3_v1_baseline_goal: "3000" });
    await redis.hSet(legacyHighlightManagementStateKey, {
      version: "highlight_management_v1",
      canonicalPostId: active.id,
      highlighted: "true",
      position: "0",
      moderatorOverride: "none",
      reconciledAt: String(nowMs - 60_000),
    });

    await ensureExistingSubscriberGoalHighlighted({
      reddit: makeReddit([active]) as never,
      redis: redis as never,
      nowMs,
      reconciliationContext: "repair",
    });

    expect(active.highlight).not.toHaveBeenCalled();
    await expect(
      redis.hGetAll(highlightManagementStateKey),
    ).resolves.toMatchObject({
      version: "highlight_management_v2",
      highlightLabel: "EVENT",
      highlightedUntil: String(expiration.getTime()),
    });
  });

  it("persists contradictory observations and notifies once after three", async () => {
    const active = makePost({
      id: "t3_contradiction",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: false,
      listed: true,
    });
    const reddit = makeReddit([active]);
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", {
      t3_contradiction_goal: "3000",
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await ensureExistingSubscriberGoalHighlighted({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: nowMs + attempt * 5 * 60 * 1000,
        notifyOnFailure: true,
        reconciliationContext: "repair",
      });
    }

    await expect(
      redis.hGetAll(highlightContradictionKey),
    ).resolves.toMatchObject({ postId: active.id, consecutiveCount: "3" });
    expect(active.highlight).not.toHaveBeenCalled();
    expect(active.unhighlight).not.toHaveBeenCalled();
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();

    active.isHighlighted.mockReturnValue(true);
    await ensureExistingSubscriberGoalHighlighted({
      reddit: reddit as never,
      redis: redis as never,
      nowMs: nowMs + 60 * 60 * 1000,
      notifyOnFailure: true,
      reconciliationContext: "repair",
    });
    await expect(redis.hGetAll(highlightContradictionKey)).resolves.toEqual({});
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
  });

  it("stops retrying a narrowly recognized archived-post highlight rejection", async () => {
    const active = makePost({
      id: "t3_archived_blocked",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      archived: true,
      highlightError: "This post is archived and cannot be highlighted",
    });
    const reddit = makeReddit([active]);
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", {
      t3_archived_blocked_goal: "3000",
    });

    const first = await ensureExistingSubscriberGoalHighlighted({
      reddit: reddit as never,
      redis: redis as never,
      nowMs,
      notifyOnFailure: true,
      highlightVerification: { maxWaitMs: 0, intervalMs: 0 },
      reconciliationContext: "repair",
    });
    const second = await ensureExistingSubscriberGoalHighlighted({
      reddit: reddit as never,
      redis: redis as never,
      nowMs: nowMs + 60_000,
      notifyOnFailure: true,
      reconciliationContext: "repair",
    });

    expect(first.failureCategories).toContain("post_state");
    expect(second.failureCategories).toContain("post_state");
    expect(active.highlight).toHaveBeenCalledOnce();
    await expect(
      redis.hGetAll(`${postOperationalStateKeyPrefix}:${active.id}`),
    ).resolves.toMatchObject({
      archived: "true",
      highlightBlocked: "true",
    });
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
  });

  it("records a failed existing-goal highlight and sends one accurate modmail", async () => {
    const existing = makePost({
      id: "t3_existing",
      createdAt: "2026-09-16T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlightFails: true,
    });
    const reddit = makeReddit([existing]);
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", { t3_existing_goal: "3000" });
    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: reddit as never,
      redis: redis as never,
      nowMs,
      notifyOnFailure: true,
      highlightVerification: { maxWaitMs: 0, intervalMs: 0 },
    });

    expect(result).toMatchObject({
      status: "existing_not_highlighted",
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
