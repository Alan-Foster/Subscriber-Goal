import { describe, expect, it, vi } from "vitest";
import {
  addRecentSubscriberPostIndex,
  autoCreateNextGoalQueueKey,
  autoCreateNextGoalExhaustedKey,
  autoCreateNextGoalRetryAttemptsKey,
  autoCreateNextGoalRetryDelayMs,
  cancelAutoCreateNextGoal,
  checkCompletionStatus,
  eraseFromRecentSubscribers,
  getAutoCreateNextGoalRunAt,
  getDueAutoCreateNextGoalPostIds,
  getSubGoalData,
  processRecentSubscriberIndexMigrationBatch,
  recordAutoCreateNextGoalFailure,
  repairAutoCreateNextGoal,
  recentSubscriberIndexMigrationStateKey,
  recentSubscriberPostsByUsernameKey,
  registerNewSubGoalPost,
  registerNewCtaOnlyPost,
  registerNewSubscribeOnlyPost,
  scheduleAutoCreateNextGoal,
  setSubGoalData,
  setSubredditDisplayNameForPost,
  subscriberGoalsKey,
  postAutomaticSuccessorSuppressionSuffix,
  postColorThemeSuffix,
  postAfterSubscribeActionSuffix,
  postAfterSubscribeButtonTextSuffix,
  postAfterSubscribeColorThemeSuffix,
  postAfterSubscribePresetSuffix,
  postAfterSubscribeUrlSuffix,
  postHeaderTextSuffix,
  postHeightSuffix,
  postKindSuffix,
  postRecentSubscriberSuffix,
  postCompletedTimeSuffix,
  postAutoCreateNextGoalSuffix,
  postSubredditDisplayNameSuffix,
} from "./subGoalData";
import {
  ctaOnlyPostKind,
  subscriberGoalPostKind,
  subscribeOnlyPostKind,
} from "../../shared/postKind";
import { postsKey, updatesKey } from "./updaterData";
import { subscriberGoalPostRegistryKey } from "./subscriberGoalPostRegistry";

type ZEntry = { member: string; score: number };

class InMemoryRedis {
  private hashes = new Map<string, Map<string, string>>();
  private sortedSets = new Map<string, Map<string, number>>();
  private strings = new Map<string, string>();
  hGetAllCalls = 0;

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean },
  ): Promise<void> {
    if (options?.nx && this.strings.has(key)) return;
    this.strings.set(key, value);
  }

  async get(key: string): Promise<string | undefined> {
    return this.strings.get(key);
  }

  async del(key: string): Promise<void> {
    this.strings.delete(key);
  }

  async hSet(key: string, fields: Record<string, string>): Promise<void> {
    const current = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(fields)) {
      current.set(field, value);
    }
    this.hashes.set(key, current);
  }

  async hMGet(key: string, fields: string[]): Promise<Array<string | null>> {
    const map = this.hashes.get(key) ?? new Map<string, string>();
    return fields.map((field) => map.get(field) ?? null);
  }

  async hSetNX(key: string, field: string, value: string): Promise<number> {
    const current = this.hashes.get(key) ?? new Map<string, string>();
    if (current.has(field)) return 0;
    current.set(field, value);
    this.hashes.set(key, current);
    return 1;
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    this.hGetAllCalls += 1;
    const map = this.hashes.get(key) ?? new Map<string, string>();
    return Object.fromEntries(map.entries());
  }

  async hDel(key: string, fields: string[]): Promise<void> {
    const map = this.hashes.get(key);
    if (!map) {
      return;
    }
    for (const field of fields) {
      map.delete(field);
    }
  }

  async hIncrBy(key: string, field: string, value: number): Promise<number> {
    const current = this.hashes.get(key) ?? new Map<string, string>();
    const next = Number(current.get(field) ?? 0) + value;
    current.set(field, String(next));
    this.hashes.set(key, current);
    return next;
  }

  async zAdd(key: string, ...entries: ZEntry[]): Promise<void> {
    const current = this.sortedSets.get(key) ?? new Map<string, number>();
    for (const entry of entries) {
      current.set(entry.member, entry.score);
    }
    this.sortedSets.set(key, current);
  }

  async zRange(key: string, start: number, end: number): Promise<ZEntry[]> {
    const current = this.sortedSets.get(key) ?? new Map<string, number>();
    const sorted = [...current.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    const normalizedEnd = end < 0 ? sorted.length - 1 : end;
    return sorted.slice(start, normalizedEnd + 1);
  }

  async zScore(key: string, member: string): Promise<number | undefined> {
    return this.sortedSets.get(key)?.get(member);
  }

  async zRem(key: string, members: string[]): Promise<void> {
    const current = this.sortedSets.get(key);
    if (!current) {
      return;
    }
    for (const member of members) {
      current.delete(member);
    }
  }

  async zScan(
    key: string,
    cursor: number,
    _pattern?: string,
    count = 10,
  ): Promise<{ cursor: number; members: ZEntry[] }> {
    const current = this.sortedSets.get(key) ?? new Map<string, number>();
    const sorted = [...current.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    const members = sorted.slice(cursor, cursor + count);
    const nextCursor =
      cursor + members.length >= sorted.length ? 0 : cursor + members.length;
    return { cursor: nextCursor, members };
  }
}

describe("subGoalData subreddit display name", () => {
  it("replays regular registration without resetting live state or valid updater scores", async () => {
    const redis = new InMemoryRedis();
    const post = {
      id: "t3_replayed",
      subredditName: "ExampleSub",
      createdAt: new Date(100),
    };
    const reddit = {
      getCurrentSubreddit: vi.fn(async () => ({ nsfw: false })),
    };
    const settings = { promoSubreddit: "SubGoal" };

    await registerNewSubGoalPost(
      reddit as never,
      redis as never,
      settings as never,
      post as never,
      200,
      false,
      "Original Name",
      "red",
      true,
      "en",
    );
    await redis.hSet(subscriberGoalsKey, {
      [`${post.id}${postRecentSubscriberSuffix}`]: "live-user",
      [`${post.id}${postCompletedTimeSuffix}`]: "1234",
      [`${post.id}${postAutomaticSuccessorSuppressionSuffix}`]:
        "auto_goal_reconciliation",
      [`${post.id}${postSubredditDisplayNameSuffix}`]: "Newer Name",
      [`${post.id}${postAutoCreateNextGoalSuffix}`]: "false",
      [`${post.id}${postColorThemeSuffix}`]: "blue",
    });
    await redis.zAdd(postsKey, { member: post.id, score: 900 });
    await redis.zAdd(updatesKey, { member: post.id, score: 950 });

    await registerNewSubGoalPost(
      reddit as never,
      redis as never,
      settings as never,
      post as never,
      200,
      false,
      "Original Name",
      "red",
      true,
      "en",
    );

    await expect(
      getSubGoalData(redis as never, post.id),
    ).resolves.toMatchObject({
      recentSubscriber: "live-user",
      completedTime: 1234,
      automaticSuccessorSuppression: "auto_goal_reconciliation",
      subredditDisplayName: "Newer Name",
      autoCreateNextGoal: false,
      colorTheme: "blue",
    });
    await expect(redis.zScore(postsKey, post.id)).resolves.toBe(900);
    await expect(redis.zScore(updatesKey, post.id)).resolves.toBe(950);
  });

  it("repairs a completed legacy goal's registry without reviving updater work", async () => {
    const redis = new InMemoryRedis();
    const post = {
      id: "t3_completed_replay",
      subredditName: "ExampleSub",
      createdAt: new Date(100),
    };
    await redis.hSet(subscriberGoalsKey, {
      [`${post.id}${postKindSuffix}`]: subscriberGoalPostKind,
      [`${post.id}${postCompletedTimeSuffix}`]: "4321",
      [`${post.id}${postAutomaticSuccessorSuppressionSuffix}`]:
        "onboarding_reconciliation",
    });

    await registerNewSubGoalPost(
      { getCurrentSubreddit: vi.fn() } as never,
      redis as never,
      { promoSubreddit: "SubGoal" } as never,
      post as never,
      200,
      false,
      "ExampleSub",
      "red",
      true,
      "en",
    );

    await expect(
      redis.zScore(subscriberGoalPostRegistryKey, post.id),
    ).resolves.toBe(100);
    await expect(redis.zScore(postsKey, post.id)).resolves.toBeUndefined();
    await expect(redis.zScore(updatesKey, post.id)).resolves.toBeUndefined();
    await expect(
      getSubGoalData(redis as never, post.id),
    ).resolves.toMatchObject({
      completedTime: 4321,
      automaticSuccessorSuppression: "onboarding_reconciliation",
    });
  });

  it("does not revive a retired post during registration replay", async () => {
    const redis = new InMemoryRedis();
    const post = {
      id: "t3_retired_replay",
      subredditName: "ExampleSub",
      createdAt: new Date(100),
    };
    await redis.set(
      `retired_subscriber_goal_v1:${post.id}`,
      JSON.stringify({ reason: "deleted", retiredAt: 100 }),
    );

    await expect(
      registerNewSubGoalPost(
        { getCurrentSubreddit: vi.fn() } as never,
        redis as never,
        { promoSubreddit: "SubGoal" } as never,
        post as never,
        200,
        false,
        "ExampleSub",
      ),
    ).resolves.toEqual({ status: "skipped" });

    await expect(redis.hGetAll(subscriberGoalsKey)).resolves.toEqual({});
    await expect(
      redis.zScore(subscriberGoalPostRegistryKey, post.id),
    ).resolves.toBeUndefined();
    await expect(redis.zScore(postsKey, post.id)).resolves.toBeUndefined();
    await expect(redis.zScore(updatesKey, post.id)).resolves.toBeUndefined();
  });

  it("persists subreddit display name via setSubGoalData/getSubGoalData", async () => {
    const redis = new InMemoryRedis();
    await setSubGoalData(
      redis as unknown as Parameters<typeof setSubGoalData>[0],
      "t3_post",
      {
        goal: 10,
        recentSubscriber: "",
        completedTime: 0,
        subredditDisplayName: "Subscriber_Goal_Dev",
        headerText: "Custom Header",
        colorTheme: "red",
        postHeight: "short",
        autoCreateNextGoal: true,
        language: "es",
        afterSubscribePreset: "discord",
        afterSubscribeAction: {
          type: "link",
          buttonText: "Únete al Discord",
          url: "https://discord.gg/example",
          colorTheme: "blue",
        },
      },
    );

    const data = await getSubGoalData(
      redis as unknown as Parameters<typeof getSubGoalData>[0],
      "t3_post",
    );
    expect(data.subredditDisplayName).toBe("Subscriber_Goal_Dev");
    expect(data.headerText).toBe("Custom Header");
    expect(data.autoCreateNextGoal).toBe(true);
    expect(data.language).toBe("es");
    expect(data.postHeight).toBe("short");
    expect(data.afterSubscribePreset).toBe("discord");
    expect(
      await redis.hGet(subscriberGoalsKey, `t3_post${postHeaderTextSuffix}`),
    ).toBe("Custom Header");
    expect(
      await redis.hGet(
        subscriberGoalsKey,
        `t3_post${postAfterSubscribePresetSuffix}`,
      ),
    ).toBe("discord");
  });

  it("updates display name independently for a post", async () => {
    const redis = new InMemoryRedis();
    await setSubGoalData(
      redis as unknown as Parameters<typeof setSubGoalData>[0],
      "t3_post",
      {
        goal: 10,
        recentSubscriber: "",
        completedTime: 0,
        subredditDisplayName: "subscriber_goal_dev",
        colorTheme: "red",
        postHeight: "regular",
        autoCreateNextGoal: false,
        language: "en",
      },
    );

    await setSubredditDisplayNameForPost(
      redis as unknown as Parameters<typeof setSubredditDisplayNameForPost>[0],
      "t3_post",
      "Subscriber_Goal_Dev",
    );

    const data = await getSubGoalData(
      redis as unknown as Parameters<typeof getSubGoalData>[0],
      "t3_post",
    );
    expect(data.subredditDisplayName).toBe("Subscriber_Goal_Dev");
    expect(
      await redis.hGet(
        subscriberGoalsKey,
        `t3_post${postSubredditDisplayNameSuffix}`,
      ),
    ).toBe("Subscriber_Goal_Dev");
  });

  it("persists each supported color theme", async () => {
    const redis = new InMemoryRedis();
    for (const colorTheme of [
      "red",
      "green",
      "purple",
      "blue",
      "pink",
    ] as const) {
      await setSubGoalData(
        redis as unknown as Parameters<typeof setSubGoalData>[0],
        `t3_${colorTheme}`,
        {
          goal: 10,
          recentSubscriber: "",
          completedTime: 0,
          subredditDisplayName: "subscriber_goal_dev",
          colorTheme,
          postHeight: "regular",
          autoCreateNextGoal: false,
          language: "en",
        },
      );

      const data = await getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        `t3_${colorTheme}`,
      );
      expect(data.colorTheme).toBe(colorTheme);
      expect(
        await redis.hGet(
          subscriberGoalsKey,
          `t3_${colorTheme}${postColorThemeSuffix}`,
        ),
      ).toBe(colorTheme);
    }
  });

  it("persists and resolves a link action independently from the primary color", async () => {
    const redis = new InMemoryRedis();
    await setSubGoalData(
      redis as unknown as Parameters<typeof setSubGoalData>[0],
      "t3_cta",
      {
        goal: 100,
        recentSubscriber: "",
        completedTime: 0,
        subredditDisplayName: "ExampleSub",
        colorTheme: "red",
        postHeight: "regular",
        autoCreateNextGoal: false,
        language: "en",
        afterSubscribeAction: {
          type: "link",
          buttonText: "Join the Discord",
          url: "https://discord.com/invite/example",
          colorTheme: "pink",
        },
      },
    );

    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        "t3_cta",
      ),
    ).resolves.toMatchObject({
      colorTheme: "red",
      afterSubscribeAction: {
        type: "link",
        buttonText: "Join the Discord",
        url: "https://discord.com/invite/example",
        colorTheme: "pink",
      },
    });
    await expect(
      Promise.all([
        redis.hGet(
          subscriberGoalsKey,
          `t3_cta${postAfterSubscribeActionSuffix}`,
        ),
        redis.hGet(
          subscriberGoalsKey,
          `t3_cta${postAfterSubscribeButtonTextSuffix}`,
        ),
        redis.hGet(subscriberGoalsKey, `t3_cta${postAfterSubscribeUrlSuffix}`),
        redis.hGet(
          subscriberGoalsKey,
          `t3_cta${postAfterSubscribeColorThemeSuffix}`,
        ),
      ]),
    ).resolves.toEqual([
      "link",
      "Join the Discord",
      "https://discord.com/invite/example",
      "pink",
    ]);
  });

  it.each(["top-post-day", "newest-post"] as const)(
    "persists and resolves the URL-free %s action",
    async (type) => {
      const redis = new InMemoryRedis();
      await setSubGoalData(
        redis as unknown as Parameters<typeof setSubGoalData>[0],
        `t3_${type}`,
        {
          goal: 100,
          recentSubscriber: "",
          completedTime: 0,
          subredditDisplayName: "ExampleSub",
          colorTheme: "red",
          postHeight: "regular",
          autoCreateNextGoal: false,
          language: "en",
          afterSubscribeAction: {
            type,
            buttonText:
              type === "top-post-day"
                ? "View the Top Post Today"
                : "View the Most Recent Post Today",
            colorTheme: "pink",
          },
        },
      );

      await expect(
        getSubGoalData(
          redis as unknown as Parameters<typeof getSubGoalData>[0],
          `t3_${type}`,
        ),
      ).resolves.toMatchObject({
        afterSubscribeAction: {
          type,
          colorTheme: "pink",
        },
      });
      await expect(
        redis.hGet(
          subscriberGoalsKey,
          `t3_${type}${postAfterSubscribeUrlSuffix}`,
        ),
      ).resolves.toBe("");
    },
  );

  it("temporarily disables actionless legacy goals and preserves malformed-action fallback", async () => {
    const redis = new InMemoryRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_legacy_goal: "100",
      t3_disabled_goal: "100",
      [`t3_disabled${postAfterSubscribeActionSuffix}`]: "disabled",
      t3_invalid_goal: "100",
      [`t3_invalid${postAfterSubscribeActionSuffix}`]: "link",
      [`t3_invalid${postAfterSubscribeButtonTextSuffix}`]: "No",
      [`t3_invalid${postAfterSubscribeUrlSuffix}`]: "http://example.com",
      [`t3_invalid${postAfterSubscribeColorThemeSuffix}`]: "orange",
    });

    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        "t3_legacy",
      ),
    ).resolves.toMatchObject({
      afterSubscribeAction: { type: "disabled" },
    });
    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        "t3_disabled",
      ),
    ).resolves.toMatchObject({ afterSubscribeAction: { type: "disabled" } });
    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        "t3_invalid",
      ),
    ).resolves.toMatchObject({
      afterSubscribeAction: {
        type: "top-post-day",
        buttonText: "View the Top Post Today",
        colorTheme: "red",
      },
    });
  });

  it("defaults missing or invalid color themes to red", async () => {
    const redis = new InMemoryRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_missing_goal: "10",
      t3_invalid_goal: "10",
      [`t3_invalid${postColorThemeSuffix}`]: "orange",
    });

    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        "t3_missing",
      ),
    ).resolves.toMatchObject({ colorTheme: "red" });
    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        "t3_invalid",
      ),
    ).resolves.toMatchObject({ colorTheme: "red" });
  });

  it("defaults missing or invalid post heights to regular", async () => {
    const redis = new InMemoryRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_missing_goal: "10",
      t3_invalid_goal: "10",
      [`t3_invalid${postHeightSuffix}`]: "compact",
    });

    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        "t3_missing",
      ),
    ).resolves.toMatchObject({ postHeight: "regular" });
    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        "t3_invalid",
      ),
    ).resolves.toMatchObject({ postHeight: "regular" });
  });

  it("preserves a positive legacy goal when conflicting metadata says Tiny", async () => {
    const redis = new InMemoryRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_legacy_goal: "250",
      [`t3_legacy${postHeightSuffix}`]: "tiny",
      [`t3_legacy${postKindSuffix}`]: subscribeOnlyPostKind,
      t3_legacy_recent_subscriber: "ExistingUser",
      t3_legacy_completed_time: "123",
    });
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const data = await getSubGoalData(
      redis as unknown as Parameters<typeof getSubGoalData>[0],
      "t3_legacy",
      { postKind: subscribeOnlyPostKind },
    );

    expect(data).toMatchObject({
      postKind: subscriberGoalPostKind,
      postHeight: "regular",
      goal: 250,
      recentSubscriber: "ExistingUser",
      completedTime: 123,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"stored_state_conflict"'),
    );
    warnSpy.mockRestore();
  });

  it("recognizes a markerless Tiny record only when no goal field exists", async () => {
    const redis = new InMemoryRedis();
    await redis.hSet(subscriberGoalsKey, {
      [`t3_tiny${postHeightSuffix}`]: "tiny",
    });

    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        "t3_tiny",
      ),
    ).resolves.toMatchObject({
      postKind: subscribeOnlyPostKind,
      postHeight: "tiny",
      goal: 0,
    });
  });

  it("persists tiny post height and skips crossposting with a tiny reason", async () => {
    const redis = new InMemoryRedis();
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    const result = await registerNewSubscribeOnlyPost(
      redis as unknown as Parameters<typeof registerNewSubscribeOnlyPost>[0],
      { promoSubreddit: "SubGoal" } as never,
      {
        id: "t3_tiny",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      } as never,
      "ExampleSub",
      "red",
      "en",
    );

    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        "t3_tiny",
      ),
    ).resolves.toMatchObject({
      postKind: subscribeOnlyPostKind,
      postHeight: "tiny",
      goal: 0,
      recentSubscriber: null,
      completedTime: 0,
      autoCreateNextGoal: false,
    });
    expect(result).toEqual({ status: "skipped" });
    await expect(
      redis.hGet(subscriberGoalsKey, `t3_tiny${postKindSuffix}`),
    ).resolves.toBe(subscribeOnlyPostKind);
    await expect(redis.zRange(postsKey, 0, -1)).resolves.toEqual([]);
    await expect(redis.zRange(updatesKey, 0, -1)).resolves.toEqual([]);
    await expect(
      redis.zRange(subscriberGoalPostRegistryKey, 0, -1),
    ).resolves.toEqual([
      {
        member: "t3_tiny",
        score: Date.parse("2026-01-01T00:00:00.000Z"),
      },
    ]);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"tiny_post_height"'),
    );
    infoSpy.mockRestore();
  });

  it("persists CTA-only identity, frame color, and action without updater tracking", async () => {
    const redis = new InMemoryRedis();
    const action = {
      type: "link" as const,
      buttonText: "Create a New Post",
      url: "https://www.reddit.com/r/ExampleSub/submit/",
      colorTheme: "blue" as const,
    };

    const result = await registerNewCtaOnlyPost(
      redis as unknown as Parameters<typeof registerNewCtaOnlyPost>[0],
      { promoSubreddit: "SubGoal" } as never,
      {
        id: "t3_cta",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      } as never,
      "ExampleSub",
      "blue",
      "en",
      action,
    );

    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        "t3_cta",
        { postKind: ctaOnlyPostKind },
      ),
    ).resolves.toMatchObject({
      postKind: ctaOnlyPostKind,
      postHeight: "cta",
      colorTheme: "blue",
      afterSubscribeAction: action,
    });
    expect(result).toEqual({ status: "skipped" });
    await expect(redis.zRange(postsKey, 0, -1)).resolves.toEqual([]);
    await expect(redis.zRange(updatesKey, 0, -1)).resolves.toEqual([]);
  });

  it("registers regular goals in both the durable registry and updater indexes", async () => {
    const redis = new InMemoryRedis();
    const createdAt = new Date("2026-02-01T00:00:00.000Z");

    await registerNewSubGoalPost(
      {} as never,
      redis as unknown as Parameters<typeof registerNewSubGoalPost>[1],
      { promoSubreddit: "SubGoal" } as never,
      {
        id: "t3_regular",
        createdAt,
        subredditName: "ExampleSub",
      } as never,
      100,
      false,
      "ExampleSub",
    );

    const expected = [{ member: "t3_regular", score: createdAt.getTime() }];
    await expect(
      redis.zRange(subscriberGoalPostRegistryKey, 0, -1),
    ).resolves.toEqual(expected);
    await expect(redis.zRange(postsKey, 0, -1)).resolves.toEqual(expected);
    await expect(redis.zRange(updatesKey, 0, -1)).resolves.toEqual(expected);
  });

  it.each([
    [true, "source_subreddit_nsfw"],
    [undefined, "source_subreddit_safety_unknown"],
  ] as const)(
    "skips manual crossposting when current subreddit nsfw is %s",
    async (nsfw, reason) => {
      const redis = new InMemoryRedis();
      const infoSpy = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);
      const createdAt = new Date("2026-02-01T00:00:00.000Z");

      const result = await registerNewSubGoalPost(
        {
          getCurrentSubreddit: async () => ({ nsfw }),
        } as never,
        redis as unknown as Parameters<typeof registerNewSubGoalPost>[1],
        { promoSubreddit: "SubGoal" } as never,
        {
          id: "t3_regular",
          createdAt,
          subredditName: "ExampleSub",
        } as never,
        100,
        true,
        "ExampleSub",
      );

      expect(result).toEqual({ status: "skipped" });
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining(reason));
      infoSpy.mockRestore();
    },
  );

  it("defaults missing auto-create settings to disabled", async () => {
    const redis = new InMemoryRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_missing_goal: "10",
    });

    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        "t3_missing",
      ),
    ).resolves.toMatchObject({ autoCreateNextGoal: false });
  });

  it("defaults missing or invalid language settings to English", async () => {
    const redis = new InMemoryRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_missing_goal: "10",
      t3_invalid_goal: "10",
      t3_invalid_language: "ja",
    });

    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        "t3_missing",
      ),
    ).resolves.toMatchObject({ language: "en" });
    await expect(
      getSubGoalData(
        redis as unknown as Parameters<typeof getSubGoalData>[0],
        "t3_invalid",
      ),
    ).resolves.toMatchObject({ language: "en" });
  });

  it("queues, reads, and clears due auto-create jobs", async () => {
    const redis = new InMemoryRedis();

    await scheduleAutoCreateNextGoal(
      redis as unknown as Parameters<typeof scheduleAutoCreateNextGoal>[0],
      "t3_auto",
      1_000,
    );

    expect(await redis.zRange(autoCreateNextGoalQueueKey, 0, -1)).toEqual([
      { member: "t3_auto", score: 86_401_000 },
    ]);
    await expect(
      getAutoCreateNextGoalRunAt(
        redis as unknown as Parameters<typeof getAutoCreateNextGoalRunAt>[0],
        "t3_auto",
      ),
    ).resolves.toBe(86_401_000);
    await expect(
      getDueAutoCreateNextGoalPostIds(
        redis as unknown as Parameters<
          typeof getDueAutoCreateNextGoalPostIds
        >[0],
        86_400_999,
      ),
    ).resolves.toEqual([]);
    await expect(
      getDueAutoCreateNextGoalPostIds(
        redis as unknown as Parameters<
          typeof getDueAutoCreateNextGoalPostIds
        >[0],
        86_401_000,
      ),
    ).resolves.toEqual(["t3_auto"]);

    await cancelAutoCreateNextGoal(
      redis as unknown as Parameters<typeof cancelAutoCreateNextGoal>[0],
      "t3_auto",
    );

    await expect(
      getDueAutoCreateNextGoalPostIds(
        redis as unknown as Parameters<
          typeof getDueAutoCreateNextGoalPostIds
        >[0],
        86_401_000,
      ),
    ).resolves.toEqual([]);
  });

  it("reschedules five bounded auto-create retries and then exhausts", async () => {
    const redis = new InMemoryRedis();
    const typedRedis = redis as unknown as Parameters<
      typeof recordAutoCreateNextGoalFailure
    >[0];
    const nowMs = 10_000;

    for (const [index, delay] of autoCreateNextGoalRetryDelayMs.entries()) {
      await expect(
        recordAutoCreateNextGoalFailure(typedRedis, "t3_retry", nowMs),
      ).resolves.toEqual({
        failureCount: index + 1,
        retryAt: nowMs + delay,
      });
      expect(await redis.zRange(autoCreateNextGoalQueueKey, 0, -1)).toEqual([
        { member: "t3_retry", score: nowMs + delay },
      ]);
    }

    await expect(
      recordAutoCreateNextGoalFailure(typedRedis, "t3_retry", nowMs),
    ).resolves.toEqual({ failureCount: 6, retryAt: null });

    await cancelAutoCreateNextGoal(typedRedis, "t3_retry");
    await expect(
      redis.hGet(autoCreateNextGoalRetryAttemptsKey, "t3_retry"),
    ).resolves.toBeUndefined();
    expect(await redis.zRange(autoCreateNextGoalQueueKey, 0, -1)).toEqual([]);
  });

  it("repairs only missing auto-create work and preserves retry backoff", async () => {
    const redis = new InMemoryRedis();
    const typedRedis = redis as unknown as Parameters<
      typeof repairAutoCreateNextGoal
    >[0];
    await redis.zAdd(autoCreateNextGoalQueueKey, {
      member: "t3_retry",
      score: 123_000,
    });
    await redis.hSet(autoCreateNextGoalRetryAttemptsKey, { t3_retry: "2" });

    await expect(
      repairAutoCreateNextGoal(typedRedis, "t3_retry", 1_000),
    ).resolves.toEqual({
      status: "retrying",
      runAt: 123_000,
      failureCount: 2,
    });
    expect(await redis.zRange(autoCreateNextGoalQueueKey, 0, -1)).toEqual([
      { member: "t3_retry", score: 123_000 },
    ]);
    await expect(
      redis.hGet(autoCreateNextGoalRetryAttemptsKey, "t3_retry"),
    ).resolves.toBe("2");
  });

  it("does not repair exhausted auto-create work", async () => {
    const redis = new InMemoryRedis();
    await redis.hSet(autoCreateNextGoalExhaustedKey, { t3_exhausted: "6" });

    await expect(
      repairAutoCreateNextGoal(
        redis as unknown as Parameters<typeof repairAutoCreateNextGoal>[0],
        "t3_exhausted",
        1_000,
      ),
    ).resolves.toEqual({ status: "exhausted", failureCount: 6 });
    expect(await redis.zRange(autoCreateNextGoalQueueKey, 0, -1)).toEqual([]);
  });

  it("repairs an orphaned retry without resetting its failure count", async () => {
    const redis = new InMemoryRedis();
    await redis.hSet(autoCreateNextGoalRetryAttemptsKey, { t3_retry: "2" });

    await expect(
      repairAutoCreateNextGoal(
        redis as unknown as Parameters<typeof repairAutoCreateNextGoal>[0],
        "t3_retry",
        1_000,
        10_000,
      ),
    ).resolves.toEqual({
      status: "retrying",
      runAt: 10_000 + autoCreateNextGoalRetryDelayMs[1],
      failureCount: 2,
    });
    await expect(
      redis.hGet(autoCreateNextGoalRetryAttemptsKey, "t3_retry"),
    ).resolves.toBe("2");
  });

  it("queues auto-create when an enabled goal reaches completion", async () => {
    const redis = new InMemoryRedis();
    const reddit = {
      getCurrentSubreddit: async () => ({ numberOfSubscribers: 10 }),
    };
    await setSubGoalData(
      redis as unknown as Parameters<typeof setSubGoalData>[0],
      "t3_post",
      {
        goal: 10,
        recentSubscriber: "",
        completedTime: 0,
        subredditDisplayName: "subscriber_goal_dev",
        colorTheme: "red",
        postHeight: "regular",
        autoCreateNextGoal: true,
        language: "en",
      },
    );

    await expect(
      checkCompletionStatus(
        reddit as unknown as Parameters<typeof checkCompletionStatus>[0],
        redis as unknown as Parameters<typeof checkCompletionStatus>[1],
        "t3_post",
      ),
    ).resolves.toBeGreaterThan(0);

    const queued = await redis.zRange(autoCreateNextGoalQueueKey, 0, -1);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.member).toBe("t3_post");
  });

  it("does not queue auto-create when a disabled goal reaches completion", async () => {
    const redis = new InMemoryRedis();
    const reddit = {
      getCurrentSubreddit: async () => ({ numberOfSubscribers: 10 }),
    };
    await setSubGoalData(
      redis as unknown as Parameters<typeof setSubGoalData>[0],
      "t3_post",
      {
        goal: 10,
        recentSubscriber: "",
        completedTime: 0,
        subredditDisplayName: "subscriber_goal_dev",
        colorTheme: "red",
        postHeight: "regular",
        autoCreateNextGoal: false,
        language: "en",
      },
    );

    await checkCompletionStatus(
      reddit as unknown as Parameters<typeof checkCompletionStatus>[0],
      redis as unknown as Parameters<typeof checkCompletionStatus>[1],
      "t3_post",
    );

    expect(await redis.zRange(autoCreateNextGoalQueueKey, 0, -1)).toEqual([]);
  });

  it("persists intentional successor suppression atomically with completion", async () => {
    const redis = new InMemoryRedis();
    await setSubGoalData(redis as never, "t3_suppressed", {
      goal: 10,
      recentSubscriber: "",
      completedTime: 0,
      subredditDisplayName: "subscriber_goal_dev",
      colorTheme: "red",
      postHeight: "regular",
      autoCreateNextGoal: true,
      language: "en",
    });

    await expect(
      checkCompletionStatus(
        {
          getCurrentSubreddit: async () => ({ numberOfSubscribers: 10 }),
        } as never,
        redis as never,
        "t3_suppressed",
        {
          now: () => 1_000,
          scheduleAutomaticSuccessor: false,
          automaticSuccessorSuppression: "auto_goal_reconciliation",
          scheduleMilestoneNotification: vi
            .fn()
            .mockResolvedValue("suppressed"),
        },
      ),
    ).resolves.toBe(1_000);
    await expect(
      getSubGoalData(redis as never, "t3_suppressed"),
    ).resolves.toMatchObject({
      completedTime: 1_000,
      automaticSuccessorSuppression: "auto_goal_reconciliation",
    });
    expect(await redis.zRange(autoCreateNextGoalQueueKey, 0, -1)).toEqual([]);

    await redis.hSet(subscriberGoalsKey, {
      [`t3_suppressed${postAutomaticSuccessorSuppressionSuffix}`]:
        "future_suppression_reason",
    });
    await expect(
      getSubGoalData(redis as never, "t3_suppressed"),
    ).resolves.toMatchObject({ automaticSuccessorSuppression: "unknown" });
  });

  it("clears stale suppression during an ordinary completion transition", async () => {
    const redis = new InMemoryRedis();
    await setSubGoalData(redis as never, "t3_normal_completion", {
      goal: 10,
      recentSubscriber: "",
      completedTime: 0,
      subredditDisplayName: "subscriber_goal_dev",
      colorTheme: "red",
      postHeight: "regular",
      autoCreateNextGoal: true,
      language: "en",
    });
    await redis.hSet(subscriberGoalsKey, {
      [`t3_normal_completion${postAutomaticSuccessorSuppressionSuffix}`]:
        "onboarding_reconciliation",
    });

    await checkCompletionStatus(
      {
        getCurrentSubreddit: async () => ({ numberOfSubscribers: 10 }),
      } as never,
      redis as never,
      "t3_normal_completion",
      {
        now: () => 1_000,
        scheduleMilestoneNotification: vi.fn().mockResolvedValue("suppressed"),
      },
    );

    await expect(
      getSubGoalData(redis as never, "t3_normal_completion"),
    ).resolves.toMatchObject({ automaticSuccessorSuppression: null });
    expect(await redis.zRange(autoCreateNextGoalQueueKey, 0, -1)).toEqual([
      { member: "t3_normal_completion", score: 86_401_000 },
    ]);
  });

  it("allows only one concurrent completion caller to start the campaign", async () => {
    const redis = new InMemoryRedis();
    const reddit = {
      getCurrentSubreddit: async () => ({ numberOfSubscribers: 10 }),
    };
    const scheduleMilestoneNotification = vi
      .fn()
      .mockResolvedValue("suppressed");
    await setSubGoalData(
      redis as unknown as Parameters<typeof setSubGoalData>[0],
      "t3_concurrent",
      {
        goal: 10,
        recentSubscriber: "",
        completedTime: 0,
        subredditDisplayName: "subscriber_goal_dev",
        colorTheme: "red",
        postHeight: "regular",
        autoCreateNextGoal: false,
        language: "en",
      },
    );

    const completions = await Promise.all([
      checkCompletionStatus(reddit as never, redis as never, "t3_concurrent", {
        scheduleMilestoneNotification,
      }),
      checkCompletionStatus(reddit as never, redis as never, "t3_concurrent", {
        scheduleMilestoneNotification,
      }),
    ]);

    expect(completions[0]).toBeGreaterThan(0);
    expect(completions[1]).toBe(completions[0]);
    expect(scheduleMilestoneNotification).toHaveBeenCalledOnce();
  });

  it("prepares the campaign before isolating an auto-next failure", async () => {
    const redis = new InMemoryRedis();
    redis.zAdd = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const scheduleMilestoneNotification = vi
      .fn()
      .mockResolvedValue("suppressed");
    await setSubGoalData(redis as never, "t3_auto_failure", {
      goal: 10,
      recentSubscriber: "",
      completedTime: 0,
      subredditDisplayName: "subscriber_goal_dev",
      colorTheme: "red",
      postHeight: "regular",
      autoCreateNextGoal: true,
      language: "en",
    });

    await expect(
      checkCompletionStatus(
        {
          getCurrentSubreddit: async () => ({ numberOfSubscribers: 10 }),
        } as never,
        redis as never,
        "t3_auto_failure",
        { scheduleMilestoneNotification },
      ),
    ).resolves.toBeGreaterThan(0);
    expect(scheduleMilestoneNotification).toHaveBeenCalledOnce();
  });

  it("repairs the original due time after completion persistence outlives a queue-write failure", async () => {
    const redis = new InMemoryRedis();
    const originalZAdd = redis.zAdd.bind(redis);
    redis.zAdd = vi
      .fn()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockImplementation(originalZAdd);
    await setSubGoalData(redis as never, "t3_recover_queue", {
      goal: 10,
      recentSubscriber: "",
      completedTime: 0,
      subredditDisplayName: "subscriber_goal_dev",
      colorTheme: "red",
      postHeight: "regular",
      autoCreateNextGoal: true,
      language: "en",
    });

    await expect(
      checkCompletionStatus(
        {
          getCurrentSubreddit: async () => ({ numberOfSubscribers: 10 }),
        } as never,
        redis as never,
        "t3_recover_queue",
        {
          now: () => 1_000,
          scheduleMilestoneNotification: vi
            .fn()
            .mockResolvedValue("suppressed"),
        },
      ),
    ).resolves.toBe(1_000);
    await expect(
      getSubGoalData(redis as never, "t3_recover_queue"),
    ).resolves.toMatchObject({
      completedTime: 1_000,
      automaticSuccessorSuppression: null,
    });
    expect(await redis.zRange(autoCreateNextGoalQueueKey, 0, -1)).toEqual([]);

    await expect(
      repairAutoCreateNextGoal(
        redis as never,
        "t3_recover_queue",
        1_000,
        200_000_000,
      ),
    ).resolves.toEqual({
      status: "scheduled",
      runAt: 86_401_000,
      failureCount: 0,
    });
    expect(await redis.zRange(autoCreateNextGoalQueueKey, 0, -1)).toEqual([
      { member: "t3_recover_queue", score: 86_401_000 },
    ]);
    await expect(
      getSubGoalData(redis as never, "t3_recover_queue"),
    ).resolves.toMatchObject({ completedTime: 1_000 });
  });

  it("preserves a queued original due time when successor metadata cleanup fails", async () => {
    const redis = new InMemoryRedis();
    const originalHDel = redis.hDel.bind(redis);
    redis.hDel = vi
      .fn()
      .mockRejectedValueOnce(new Error("metadata unavailable"))
      .mockImplementation(originalHDel);
    await setSubGoalData(redis as never, "t3_recover_metadata", {
      goal: 10,
      recentSubscriber: "",
      completedTime: 0,
      subredditDisplayName: "subscriber_goal_dev",
      colorTheme: "red",
      postHeight: "regular",
      autoCreateNextGoal: true,
      language: "en",
    });

    await expect(
      checkCompletionStatus(
        {
          getCurrentSubreddit: async () => ({ numberOfSubscribers: 10 }),
        } as never,
        redis as never,
        "t3_recover_metadata",
        {
          now: () => 1_000,
          scheduleMilestoneNotification: vi
            .fn()
            .mockResolvedValue("suppressed"),
        },
      ),
    ).resolves.toBe(1_000);
    expect(await redis.zRange(autoCreateNextGoalQueueKey, 0, -1)).toEqual([
      { member: "t3_recover_metadata", score: 86_401_000 },
    ]);

    await expect(
      repairAutoCreateNextGoal(redis as never, "t3_recover_metadata", 1_000),
    ).resolves.toEqual({
      status: "queued",
      runAt: 86_401_000,
      failureCount: 0,
    });
    expect(await redis.zRange(autoCreateNextGoalQueueKey, 0, -1)).toEqual([
      { member: "t3_recover_metadata", score: 86_401_000 },
    ]);
  });

  it("clears indexed recent subscriber fields without scanning all goal records", async () => {
    const redis = new InMemoryRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_post_recent_subscriber: "TestUser",
      t3_other_recent_subscriber: "OtherUser",
    });
    await addRecentSubscriberPostIndex(
      redis as unknown as Parameters<typeof addRecentSubscriberPostIndex>[0],
      "TestUser",
      "t3_post",
    );

    await eraseFromRecentSubscribers(
      redis as unknown as Parameters<typeof eraseFromRecentSubscribers>[0],
      "testuser",
    );

    expect(
      await redis.hGet(subscriberGoalsKey, "t3_post_recent_subscriber"),
    ).toBe("");
    expect(
      await redis.hGet(subscriberGoalsKey, "t3_other_recent_subscriber"),
    ).toBe("OtherUser");
    expect(
      await redis.hGet(recentSubscriberPostsByUsernameKey, "testuser"),
    ).toBeUndefined();
    expect(redis.hGetAllCalls).toBe(0);
  });

  it("indexes recent subscribers from tracked posts in bounded migration batches", async () => {
    const redis = new InMemoryRedis();
    await redis.zAdd(
      postsKey,
      { member: "t3_a", score: 100 },
      { member: "t3_b", score: 200 },
    );
    await redis.hSet(subscriberGoalsKey, {
      t3_a_recent_subscriber: "Alice",
      t3_b_recent_subscriber: "",
    });
    await redis.hSet(recentSubscriberIndexMigrationStateKey, {
      version: "recent_subscriber_index_v1",
      status: "pending",
      cursor: "0",
      nextRunAt: "0",
      scannedTotal: "0",
      indexedTotal: "0",
      lastRunAt: "0",
    });

    await processRecentSubscriberIndexMigrationBatch(
      redis as unknown as Parameters<
        typeof processRecentSubscriberIndexMigrationBatch
      >[0],
      {
        nowMs: 1_000,
        batchSize: 2,
        cooldownMinMs: 5,
        cooldownMaxMs: 5,
      },
    );

    expect(await redis.hGet(recentSubscriberPostsByUsernameKey, "alice")).toBe(
      JSON.stringify(["t3_a"]),
    );
    expect(
      await redis.hGetAll(recentSubscriberIndexMigrationStateKey),
    ).toMatchObject({
      status: "complete",
      cursor: "0",
      scannedTotal: "2",
      indexedTotal: "1",
    });
  });
});
