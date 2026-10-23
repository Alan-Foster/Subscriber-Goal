import { describe, expect, it } from "vitest";
import {
  postAfterSubscribeActionSuffix,
  postAfterSubscribeButtonTextSuffix,
  postAfterSubscribeColorThemeSuffix,
  postAfterSubscribePresetSuffix,
  postAfterSubscribeUrlSuffix,
  postHeightSuffix,
  postKindSuffix,
  postLanguageSuffix,
  subscriberGoalsKey,
} from "./subGoalData";
import {
  initializeNsfwAfterSubscribeActionMigration,
  nsfwAfterSubscribeActionMigrationLockKeyPrefix,
  nsfwAfterSubscribeActionMigrationQueueKey,
  processNsfwAfterSubscribeActionMigrationBatch,
} from "./nsfwAfterSubscribeActionMigration";

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
    typeof initializeNsfwAfterSubscribeActionMigration
  >[0];
const nsfwSubreddit = { name: "ExampleSub", nsfw: true };

describe("NSFW after-subscribe action migration", () => {
  it("converts Top and New actions for every post kind to canonical Create Post", async () => {
    const redis = new TestRedis();
    await redis.hSet(subscriberGoalsKey, {
      [`t3_goal${postKindSuffix}`]: "subscriber-goal-v1",
      [`t3_goal${postLanguageSuffix}`]: "es",
      [`t3_goal${postAfterSubscribeActionSuffix}`]: "top-post-day",
      [`t3_goal${postAfterSubscribePresetSuffix}`]: "top-post-day",
      [`t3_tiny${postKindSuffix}`]: "subscribe-only-v1",
      [`t3_tiny${postHeightSuffix}`]: "tiny",
      [`t3_tiny${postAfterSubscribeActionSuffix}`]: "newest-post",
      [`t3_cta${postKindSuffix}`]: "cta-only-v1",
      [`t3_cta${postHeightSuffix}`]: "cta",
      [`t3_cta${postAfterSubscribePresetSuffix}`]: "top-post-day",
      [`t3_cta${postAfterSubscribeActionSuffix}`]: "link",
    });
    await initializeNsfwAfterSubscribeActionMigration(
      asRedis(redis),
      ["t3_goal", "t3_tiny", "t3_cta"],
      nsfwSubreddit,
    );

    const summary = await processNsfwAfterSubscribeActionMigrationBatch(
      asRedis(redis),
      nsfwSubreddit,
    );

    expect(summary).toMatchObject({ scanned: 3, converted: 3, failed: 0 });
    for (const postId of ["t3_goal", "t3_tiny", "t3_cta"]) {
      await expect(
        redis.hGet(
          subscriberGoalsKey,
          `${postId}${postAfterSubscribeActionSuffix}`,
        ),
      ).resolves.toBe("link");
      await expect(
        redis.hGet(
          subscriberGoalsKey,
          `${postId}${postAfterSubscribeUrlSuffix}`,
        ),
      ).resolves.toBe("https://www.reddit.com/r/ExampleSub/submit/");
      await expect(
        redis.hGet(
          subscriberGoalsKey,
          `${postId}${postAfterSubscribeColorThemeSuffix}`,
        ),
      ).resolves.toBe("blue");
      await expect(
        redis.hGet(
          subscriberGoalsKey,
          `${postId}${postAfterSubscribePresetSuffix}`,
        ),
      ).resolves.toBe("create-post");
    }
    await expect(
      redis.hGet(
        subscriberGoalsKey,
        `t3_goal${postAfterSubscribeButtonTextSuffix}`,
      ),
    ).resolves.toBe("Crear una publicación");
  });

  it("does not queue or change SFW installations", async () => {
    const redis = new TestRedis();
    await redis.hSet(subscriberGoalsKey, {
      [`t3_sfw${postAfterSubscribeActionSuffix}`]: "top-post-day",
    });

    await initializeNsfwAfterSubscribeActionMigration(
      asRedis(redis),
      ["t3_sfw"],
      { name: "ExampleSub", nsfw: false },
    );
    await processNsfwAfterSubscribeActionMigrationBatch(asRedis(redis), {
      name: "ExampleSub",
      nsfw: false,
    });

    await expect(
      redis.zRange(nsfwAfterSubscribeActionMigrationQueueKey, 0, -1),
    ).resolves.toEqual([]);
    await expect(
      redis.hGet(subscriberGoalsKey, `t3_sfw${postAfterSubscribeActionSuffix}`),
    ).resolves.toBe("top-post-day");
  });

  it("preserves direct actions, is idempotent, and leaves lock races queued", async () => {
    const redis = new TestRedis();
    await redis.hSet(subscriberGoalsKey, {
      [`t3_link${postAfterSubscribeActionSuffix}`]: "link",
      [`t3_link${postAfterSubscribePresetSuffix}`]: "web-link",
      [`t3_race${postAfterSubscribeActionSuffix}`]: "top-post-day",
    });
    await initializeNsfwAfterSubscribeActionMigration(
      asRedis(redis),
      ["t3_link", "t3_race"],
      nsfwSubreddit,
    );
    redis.strings.set(
      `${nsfwAfterSubscribeActionMigrationLockKeyPrefix}:t3_race`,
      "other-worker",
    );

    const first = await processNsfwAfterSubscribeActionMigrationBatch(
      asRedis(redis),
      nsfwSubreddit,
    );
    expect(first).toMatchObject({ preserved: 1, raced: 1 });
    await expect(
      redis.zRange(nsfwAfterSubscribeActionMigrationQueueKey, 0, -1),
    ).resolves.toEqual([{ member: "t3_race", score: 1 }]);

    redis.strings.delete(
      `${nsfwAfterSubscribeActionMigrationLockKeyPrefix}:t3_race`,
    );
    const second = await processNsfwAfterSubscribeActionMigrationBatch(
      asRedis(redis),
      nsfwSubreddit,
    );
    expect(second.converted).toBe(1);
    const third = await processNsfwAfterSubscribeActionMigrationBatch(
      asRedis(redis),
      nsfwSubreddit,
    );
    expect(third.scanned).toBe(0);
  });
});
