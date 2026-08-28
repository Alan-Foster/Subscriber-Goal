import { describe, expect, it, vi } from "vitest";
import {
  addRecentSubscriberPostIndex,
  autoCreateNextGoalQueueKey,
  cancelAutoCreateNextGoal,
  checkCompletionStatus,
  eraseFromRecentSubscribers,
  getDueAutoCreateNextGoalPostIds,
  getSubGoalData,
  processRecentSubscriberIndexMigrationBatch,
  recentSubscriberIndexMigrationStateKey,
  recentSubscriberPostsByUsernameKey,
  registerNewSubGoalPost,
  registerNewSubscribeOnlyPost,
  scheduleAutoCreateNextGoal,
  setSubGoalData,
  setSubredditDisplayNameForPost,
  subscriberGoalsKey,
  postColorThemeSuffix,
  postHeaderTextSuffix,
  postHeightSuffix,
  postKindSuffix,
  postSubredditDisplayNameSuffix,
} from "./subGoalData";
import {
  subscriberGoalPostKind,
  subscribeOnlyPostKind,
} from "../../shared/postKind";
import { postsKey, updatesKey } from "./updaterData";

type ZEntry = { member: string; score: number };

class InMemoryRedis {
  private hashes = new Map<string, Map<string, string>>();
  private sortedSets = new Map<string, Map<string, number>>();
  hGetAllCalls = 0;

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
    expect(
      await redis.hGet(subscriberGoalsKey, `t3_post${postHeaderTextSuffix}`),
    ).toBe("Custom Header");
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
    for (const colorTheme of ["red", "green", "purple", "blue"] as const) {
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
      expect.stringContaining("preserving subscriber goal"),
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
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"tiny_post_height"'),
    );
    infoSpy.mockRestore();
  });

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
