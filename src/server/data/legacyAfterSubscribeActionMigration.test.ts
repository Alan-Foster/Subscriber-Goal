import { describe, expect, it, vi } from "vitest";
import {
  postAfterSubscribeActionSuffix,
  postAfterSubscribeButtonTextSuffix,
  postAfterSubscribeColorThemeSuffix,
  postAfterSubscribePresetSuffix,
  postAfterSubscribeUrlSuffix,
  postGoalSuffix,
  subscriberGoalsKey,
} from "./subGoalData";
import {
  initializeLegacyAfterSubscribeActionMigration,
  legacyAfterSubscribeActionMigrationQueueKey,
  legacyAfterSubscribeActionMigrationStateKey,
  legacyAfterSubscribeActionMigrationVersion,
  processLegacyAfterSubscribeActionMigrationBatch,
} from "./legacyAfterSubscribeActionMigration";

type ZEntry = { member: string; score: number };

class TestRedis {
  hashes = new Map<string, Map<string, string>>();
  sortedSets = new Map<string, Map<string, number>>();
  strings = new Map<string, string>();

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }
  async hGetAll(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key)?.entries() ?? []);
  }
  async hMGet(key: string, fields: string[]): Promise<Array<string | null>> {
    return fields.map((field) => this.hashes.get(key)?.get(field) ?? null);
  }
  async hSet(key: string, fields: Record<string, string>): Promise<void> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    Object.entries(fields).forEach(([field, value]) => hash.set(field, value));
    this.hashes.set(key, hash);
  }
  async zAdd(key: string, ...entries: ZEntry[]): Promise<void> {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    entries.forEach(({ member, score }) => set.set(member, score));
    this.sortedSets.set(key, set);
  }
  async zRange(key: string, start: number, end: number): Promise<ZEntry[]> {
    const entries = [...(this.sortedSets.get(key)?.entries() ?? [])]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score);
    return entries.slice(start, end < 0 ? undefined : end + 1);
  }
  async zRem(key: string, members: string[]): Promise<void> {
    members.forEach((member) => this.sortedSets.get(key)?.delete(member));
  }
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
}

const asRedis = (redis: TestRedis) =>
  redis as unknown as Parameters<
    typeof initializeLegacyAfterSubscribeActionMigration
  >[0];
const publicSubreddit = { name: "SubGoal", type: "public" };

describe("legacy after-subscription action migration v3", () => {
  it("re-queues a completed v2 installation and initializes v3 once", async () => {
    const redis = new TestRedis();
    await redis.hSet("legacy_after_subscribe_action_migration_v2_state", {
      version: "legacy_after_subscribe_action_v2",
      status: "complete",
    });

    await initializeLegacyAfterSubscribeActionMigration(
      asRedis(redis),
      ["t3_old"],
      publicSubreddit,
    );
    await initializeLegacyAfterSubscribeActionMigration(
      asRedis(redis),
      ["t3_not_requeued"],
      publicSubreddit,
    );

    await expect(
      redis.zRange(legacyAfterSubscribeActionMigrationQueueKey, 0, -1),
    ).resolves.toEqual([{ member: "t3_old", score: 0 }]);
    await expect(
      redis.hGet(legacyAfterSubscribeActionMigrationStateKey, "version"),
    ).resolves.toBe(legacyAfterSubscribeActionMigrationVersion);
  });

  it("converts actionless and canonical Create Post defaults to Top Post", async () => {
    const redis = new TestRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_actionless_goal: "250",
      t3_actionless_language: "es",
      t3_actionless_color_theme: "pink",
      t3_actionless_recent_subscriber: "ExistingUser",
      t3_canonical_goal: "500",
      [`t3_canonical${postAfterSubscribeActionSuffix}`]: "link",
      [`t3_canonical${postAfterSubscribeButtonTextSuffix}`]:
        "Create a New Post",
      [`t3_canonical${postAfterSubscribeUrlSuffix}`]:
        "https://www.reddit.com/r/SubGoal/submit/",
      [`t3_canonical${postAfterSubscribeColorThemeSuffix}`]: "blue",
      [`t3_canonical${postAfterSubscribePresetSuffix}`]: "create-post",
    });
    await initializeLegacyAfterSubscribeActionMigration(
      asRedis(redis),
      ["t3_actionless", "t3_canonical"],
      publicSubreddit,
    );

    const summary = await processLegacyAfterSubscribeActionMigrationBatch(
      asRedis(redis),
      publicSubreddit,
    );

    expect(summary).toMatchObject({
      scanned: 2,
      convertedActionless: 1,
      convertedCanonicalCreatePostDefaults: 1,
      failed: 0,
    });
    await expect(
      Promise.all(
        ["t3_actionless", "t3_canonical"].flatMap((postId) => [
          redis.hGet(
            subscriberGoalsKey,
            `${postId}${postAfterSubscribeActionSuffix}`,
          ),
          redis.hGet(
            subscriberGoalsKey,
            `${postId}${postAfterSubscribeUrlSuffix}`,
          ),
          redis.hGet(
            subscriberGoalsKey,
            `${postId}${postAfterSubscribePresetSuffix}`,
          ),
        ]),
      ),
    ).resolves.toEqual([
      "top-post-day",
      "",
      "top-post-day",
      "top-post-day",
      "",
      "top-post-day",
    ]);
    await expect(
      redis.hGet(
        subscriberGoalsKey,
        `t3_actionless${postAfterSubscribeButtonTextSuffix}`,
      ),
    ).resolves.toBe("Ver la publicación destacada de hoy");
    await expect(
      redis.hGet(subscriberGoalsKey, "t3_actionless_recent_subscriber"),
    ).resolves.toBe("ExistingUser");
  });

  it("preserves explicit choices and skips Tiny, CTA, and invalid records", async () => {
    const redis = new TestRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_custom_goal: "100",
      [`t3_custom${postAfterSubscribeActionSuffix}`]: "top-post-day",
      [`t3_custom${postAfterSubscribeButtonTextSuffix}`]: "Our daily favorite",
      t3_tagged_goal: "100",
      [`t3_tagged${postAfterSubscribeActionSuffix}`]: "top-post-day",
      [`t3_tagged${postAfterSubscribeButtonTextSuffix}`]:
        "View the Top Post Today",
      [`t3_tagged${postAfterSubscribePresetSuffix}`]: "top-post-day",
      t3_disabled_goal: "100",
      [`t3_disabled${postAfterSubscribeActionSuffix}`]: "disabled",
      t3_link_goal: "100",
      [`t3_link${postAfterSubscribeActionSuffix}`]: "link",
      [`t3_link${postAfterSubscribeButtonTextSuffix}`]: "Visit our website",
      [`t3_link${postAfterSubscribeUrlSuffix}`]: "https://example.com/",
      t3_custom_create_goal: "100",
      [`t3_custom_create${postAfterSubscribeActionSuffix}`]: "link",
      [`t3_custom_create${postAfterSubscribeButtonTextSuffix}`]:
        "Create a New Post",
      [`t3_custom_create${postAfterSubscribeUrlSuffix}`]:
        "https://www.reddit.com/r/SubGoal/submit/",
      [`t3_custom_create${postAfterSubscribeColorThemeSuffix}`]: "pink",
      [`t3_custom_create${postAfterSubscribePresetSuffix}`]: "create-post",
      t3_partial_goal: "100",
      [`t3_partial${postAfterSubscribeButtonTextSuffix}`]: "Keep this choice",
      t3_tiny_post_kind: "subscribe-only-v1",
      t3_cta_post_kind: "cta-only-v1",
      t3_invalid_goal: "0",
    });
    const postIds = [
      "t3_custom",
      "t3_tagged",
      "t3_disabled",
      "t3_link",
      "t3_custom_create",
      "t3_partial",
      "t3_tiny",
      "t3_cta",
      "t3_invalid",
    ];
    await initializeLegacyAfterSubscribeActionMigration(
      asRedis(redis),
      postIds,
      publicSubreddit,
    );

    const summary = await processLegacyAfterSubscribeActionMigrationBatch(
      asRedis(redis),
      publicSubreddit,
    );

    expect(summary).toMatchObject({
      scanned: 9,
      preservedExplicit: 5,
      alreadyTopPostDefaults: 1,
      ineligible: 3,
      convertedActionless: 0,
      convertedCanonicalCreatePostDefaults: 0,
    });
    await expect(
      redis.hGet(
        subscriberGoalsKey,
        `t3_custom${postAfterSubscribeButtonTextSuffix}`,
      ),
    ).resolves.toBe("Our daily favorite");
    await expect(
      redis.hGet(
        subscriberGoalsKey,
        `t3_custom_create${postAfterSubscribeActionSuffix}`,
      ),
    ).resolves.toBe("link");
  });

  it("retains Top Post defaults and repairs actionless records to that default", async () => {
    const redis = new TestRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_actionless_goal: "100",
      t3_existing_goal: "100",
      [`t3_existing${postAfterSubscribeActionSuffix}`]: "top-post-day",
      [`t3_existing${postAfterSubscribeButtonTextSuffix}`]:
        "View the Top Post Today",
    });
    const restricted = { name: "PrivateClub", type: "restricted" };
    await initializeLegacyAfterSubscribeActionMigration(
      asRedis(redis),
      ["t3_actionless", "t3_existing"],
      restricted,
    );

    const summary = await processLegacyAfterSubscribeActionMigrationBatch(
      asRedis(redis),
      restricted,
    );

    expect(summary).toMatchObject({
      convertedActionless: 1,
      alreadyTopPostDefaults: 1,
      convertedCanonicalCreatePostDefaults: 0,
    });
    await expect(
      Promise.all([
        redis.hGet(
          subscriberGoalsKey,
          `t3_actionless${postAfterSubscribeActionSuffix}`,
        ),
        redis.hGet(
          subscriberGoalsKey,
          `t3_actionless${postAfterSubscribePresetSuffix}`,
        ),
      ]),
    ).resolves.toEqual(["top-post-day", "top-post-day"]);
  });

  it("leaves a contended record queued without overwriting it", async () => {
    const redis = new TestRedis();
    await redis.hSet(subscriberGoalsKey, { t3_race_goal: "100" });
    await initializeLegacyAfterSubscribeActionMigration(
      asRedis(redis),
      ["t3_race"],
      publicSubreddit,
    );
    vi.spyOn(redis, "set").mockResolvedValue(undefined);

    const summary = await processLegacyAfterSubscribeActionMigrationBatch(
      asRedis(redis),
      publicSubreddit,
    );

    expect(summary).toMatchObject({ scanned: 1, raced: 1 });
    await expect(
      redis.zRange(legacyAfterSubscribeActionMigrationQueueKey, 0, -1),
    ).resolves.toEqual([{ member: "t3_race", score: 0 }]);
    await expect(
      redis.hGet(
        subscriberGoalsKey,
        `t3_race${postAfterSubscribeActionSuffix}`,
      ),
    ).resolves.toBeUndefined();
  });

  it("does not overwrite an action changed after eligibility is read", async () => {
    const redis = new TestRedis();
    await redis.hSet(subscriberGoalsKey, { t3_changed_goal: "100" });
    await initializeLegacyAfterSubscribeActionMigration(
      asRedis(redis),
      ["t3_changed"],
      publicSubreddit,
    );
    const originalHMGet = redis.hMGet.bind(redis);
    let eligibilityReads = 0;
    vi.spyOn(redis, "hMGet").mockImplementation(async (key, fields) => {
      if (fields.length === 5) {
        eligibilityReads += 1;
        if (eligibilityReads === 2) {
          await redis.hSet(subscriberGoalsKey, {
            [`t3_changed${postAfterSubscribeActionSuffix}`]: "disabled",
          });
        }
      }
      return originalHMGet(key, fields);
    });

    const summary = await processLegacyAfterSubscribeActionMigrationBatch(
      asRedis(redis),
      publicSubreddit,
    );

    expect(summary).toMatchObject({ raced: 1, convertedActionless: 0 });
    await expect(
      redis.hGet(
        subscriberGoalsKey,
        `t3_changed${postAfterSubscribeActionSuffix}`,
      ),
    ).resolves.toBe("disabled");
  });

  it("keeps malformed ids queued for retry", async () => {
    const redis = new TestRedis();
    await initializeLegacyAfterSubscribeActionMigration(
      asRedis(redis),
      ["invalid-id"],
      publicSubreddit,
    );

    const summary = await processLegacyAfterSubscribeActionMigrationBatch(
      asRedis(redis),
      publicSubreddit,
    );

    expect(summary.failed).toBe(1);
    await expect(
      redis.zRange(legacyAfterSubscribeActionMigrationQueueKey, 0, -1),
    ).resolves.toEqual([{ member: "invalid-id", score: 0 }]);
  });

  it("processes at most 25 records per batch and reports remaining work", async () => {
    const redis = new TestRedis();
    const postIds = Array.from({ length: 26 }, (_, index) => `t3_goal${index}`);
    await redis.hSet(
      subscriberGoalsKey,
      Object.fromEntries(
        postIds.map((postId) => [`${postId}${postGoalSuffix}`, "100"]),
      ),
    );
    await initializeLegacyAfterSubscribeActionMigration(
      asRedis(redis),
      postIds,
      publicSubreddit,
    );

    const first = await processLegacyAfterSubscribeActionMigrationBatch(
      asRedis(redis),
      publicSubreddit,
    );

    expect(first).toMatchObject({ scanned: 25, convertedActionless: 25 });
    await expect(
      redis.zRange(legacyAfterSubscribeActionMigrationQueueKey, 0, -1),
    ).resolves.toHaveLength(1);

    const second = await processLegacyAfterSubscribeActionMigrationBatch(
      asRedis(redis),
      publicSubreddit,
    );
    expect(second).toMatchObject({ scanned: 1, convertedActionless: 1 });
    await expect(
      redis.hGet(legacyAfterSubscribeActionMigrationStateKey, "status"),
    ).resolves.toBe("complete");
  });
});
