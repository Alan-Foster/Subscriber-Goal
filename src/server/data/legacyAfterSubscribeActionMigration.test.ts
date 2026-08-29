import { describe, expect, it } from "vitest";
import {
  postAfterSubscribeActionSuffix,
  postAfterSubscribeButtonTextSuffix,
  postAfterSubscribeColorThemeSuffix,
  postAfterSubscribeUrlSuffix,
  subscriberGoalsKey,
} from "./subGoalData";
import {
  initializeLegacyAfterSubscribeActionMigration,
  legacyAfterSubscribeActionMigrationQueueKey,
  legacyAfterSubscribeActionMigrationStateKey,
  processLegacyAfterSubscribeActionMigrationBatch,
} from "./legacyAfterSubscribeActionMigration";

type ZEntry = { member: string; score: number };

class TestRedis {
  hashes = new Map<string, Map<string, string>>();
  sortedSets = new Map<string, Map<string, number>>();

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
  async hSetNX(key: string, field: string, value: string): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    if (hash.has(field)) {
      return 0;
    }
    hash.set(field, value);
    this.hashes.set(key, hash);
    return 1;
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
}

const asRedis = (redis: TestRedis) =>
  redis as unknown as Parameters<
    typeof initializeLegacyAfterSubscribeActionMigration
  >[0];

describe("legacy after-subscription action migration", () => {
  it("upgrades an actionless legacy goal without modifying its other state", async () => {
    const redis = new TestRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_legacy_goal: "250",
      t3_legacy_recent_subscriber: "ExistingUser",
      t3_legacy_completed_time: "123",
      t3_legacy_language: "es",
      t3_legacy_color_theme: "pink",
      t3_legacy_post_height: "short",
      t3_legacy_auto_create_next_goal: "true",
    });

    await initializeLegacyAfterSubscribeActionMigration(asRedis(redis), [
      "t3_legacy",
    ]);
    const summary = await processLegacyAfterSubscribeActionMigrationBatch(
      asRedis(redis),
    );

    expect(summary).toEqual({
      scanned: 1,
      upgraded: 1,
      alreadyConfigured: 0,
      ineligible: 0,
      failed: 0,
    });
    await expect(
      Promise.all([
        redis.hGet(
          subscriberGoalsKey,
          `t3_legacy${postAfterSubscribeActionSuffix}`,
        ),
        redis.hGet(
          subscriberGoalsKey,
          `t3_legacy${postAfterSubscribeButtonTextSuffix}`,
        ),
        redis.hGet(
          subscriberGoalsKey,
          `t3_legacy${postAfterSubscribeUrlSuffix}`,
        ),
        redis.hGet(
          subscriberGoalsKey,
          `t3_legacy${postAfterSubscribeColorThemeSuffix}`,
        ),
      ]),
    ).resolves.toEqual([
      "top-post-day",
      "Ver la publicación destacada de hoy",
      "",
      "pink",
    ]);
    await expect(
      redis.hGet(subscriberGoalsKey, "t3_legacy_goal"),
    ).resolves.toBe("250");
    await expect(
      redis.hGet(subscriberGoalsKey, "t3_legacy_recent_subscriber"),
    ).resolves.toBe("ExistingUser");
    await expect(
      redis.hGet(subscriberGoalsKey, "t3_legacy_completed_time"),
    ).resolves.toBe("123");
  });

  it("preserves configured actions and skips Tiny or invalid goals", async () => {
    const redis = new TestRedis();
    await redis.hSet(subscriberGoalsKey, {
      t3_disabled_goal: "100",
      [`t3_disabled${postAfterSubscribeActionSuffix}`]: "disabled",
      t3_tiny_post_kind: "subscribe-only-v1",
      t3_invalid_goal: "0",
    });
    await initializeLegacyAfterSubscribeActionMigration(asRedis(redis), [
      "t3_disabled",
      "t3_tiny",
      "t3_invalid",
    ]);
    await initializeLegacyAfterSubscribeActionMigration(asRedis(redis), [
      "t3_not_requeued",
    ]);

    const summary = await processLegacyAfterSubscribeActionMigrationBatch(
      asRedis(redis),
    );

    expect(summary).toEqual({
      scanned: 3,
      upgraded: 0,
      alreadyConfigured: 1,
      ineligible: 2,
      failed: 0,
    });
    await expect(
      redis.zRange(legacyAfterSubscribeActionMigrationQueueKey, 0, -1),
    ).resolves.toEqual([]);
    await expect(
      redis.hGet(legacyAfterSubscribeActionMigrationStateKey, "status"),
    ).resolves.toBe("complete");
  });

  it("keeps failures queued for retry", async () => {
    const redis = new TestRedis();
    await initializeLegacyAfterSubscribeActionMigration(asRedis(redis), [
      "invalid-id",
    ]);

    const summary = await processLegacyAfterSubscribeActionMigrationBatch(
      asRedis(redis),
    );

    expect(summary.failed).toBe(1);
    await expect(
      redis.zRange(legacyAfterSubscribeActionMigrationQueueKey, 0, -1),
    ).resolves.toEqual([{ member: "invalid-id", score: 0 }]);
  });

  it("does not overwrite an action configured while the migration is running", async () => {
    const redis = new TestRedis();
    await redis.hSet(subscriberGoalsKey, { t3_race_goal: "100" });
    const originalHSetNX = redis.hSetNX.bind(redis);
    redis.hSetNX = async (key, field, value) => {
      if (field.endsWith(postAfterSubscribeActionSuffix)) {
        await redis.hSet(key, { [field]: "disabled" });
      }
      return originalHSetNX(key, field, value);
    };
    await initializeLegacyAfterSubscribeActionMigration(asRedis(redis), [
      "t3_race",
    ]);

    const summary = await processLegacyAfterSubscribeActionMigrationBatch(
      asRedis(redis),
    );

    expect(summary).toMatchObject({ upgraded: 0, alreadyConfigured: 1 });
    await expect(
      redis.hGet(
        subscriberGoalsKey,
        `t3_race${postAfterSubscribeActionSuffix}`,
      ),
    ).resolves.toBe("disabled");
  });
});
