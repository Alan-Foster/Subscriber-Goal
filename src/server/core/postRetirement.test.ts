import { describe, expect, it } from "vitest";
import {
  autoCreateNextGoalExhaustedKey,
  autoCreateNextGoalQueueKey,
  autoCreateNextGoalRetryAttemptsKey,
  autoCreateNextGoalSuccessorsKey,
  subscriberGoalsKey,
} from "../data/subGoalData";
import { subscriberGoalPostRegistryKey } from "../data/subscriberGoalPostRegistry";
import { postsKey, updatesKey } from "../data/updaterData";
import { appRepairStateKey } from "../data/highlightRepair";
import {
  highlightManagementStateKey,
  saveHighlightManagementBaseline,
} from "../data/highlightManagement";
import {
  classifyPostLookupError,
  isSubscriberGoalPostRetired,
  retireSubscriberGoalPost,
} from "./postRetirement";

class TestRedis {
  values = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  sortedSets = new Map<string, Set<string>>();

  async set(key: string, value: string): Promise<void> {
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
  async hSet(key: string, fields: Record<string, string>): Promise<void> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(fields)) hash.set(field, value);
    this.hashes.set(key, hash);
  }
  async hDel(key: string, fields: string[]): Promise<void> {
    const hash = this.hashes.get(key);
    for (const field of fields) hash?.delete(field);
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
  async zRem(key: string, members: string[]): Promise<void> {
    for (const member of members) this.sortedSets.get(key)?.delete(member);
  }
}

describe("subscriber goal post retirement", () => {
  it("distinguishes confirmed missing responses from transient failures", () => {
    expect(
      classifyPostLookupError(
        Object.assign(new Error("unavailable"), { status: 404 }),
      ),
    ).toMatchObject({ status: "missing" });
    expect(
      classifyPostLookupError(new Error("503 Service Unavailable")),
    ).toMatchObject({
      status: "retryable",
    });
    expect(
      classifyPostLookupError(new Error("no post t3_dead"), "t3_dead"),
    ).toMatchObject({ status: "missing" });
  });

  it("cleans every relationship, writes a tombstone, and schedules canonical repair", async () => {
    const redis = new TestRedis();
    const postId = "t3_dead" as const;
    for (const key of [
      subscriberGoalPostRegistryKey,
      postsKey,
      updatesKey,
      autoCreateNextGoalQueueKey,
    ]) {
      redis.sortedSets.set(key, new Set([postId]));
    }
    await redis.hSet(subscriberGoalsKey, {
      [`${postId}_goal`]: "1000",
      [`${postId}_post_kind`]: "subscriber-goal-v1",
    });
    await redis.hSet(autoCreateNextGoalRetryAttemptsKey, { [postId]: "2" });
    await redis.hSet(autoCreateNextGoalExhaustedKey, { [postId]: "5" });
    await redis.hSet(autoCreateNextGoalSuccessorsKey, {
      [postId]: "t3_next",
      t3_source: postId,
    });
    await saveHighlightManagementBaseline(redis as never, {
      canonicalPostId: postId,
      highlighted: true,
      position: 0,
      moderatorOverride: "none",
      reconciledAt: 100,
    });

    await retireSubscriberGoalPost(
      redis as never,
      postId,
      "confirmed_missing",
      200,
    );

    await expect(
      isSubscriberGoalPostRetired(redis as never, postId),
    ).resolves.toBe(true);
    expect(redis.hashes.get(subscriberGoalsKey)?.has(`${postId}_goal`)).toBe(
      false,
    );
    expect(redis.hashes.get(autoCreateNextGoalSuccessorsKey)?.size).toBe(0);
    expect(redis.hashes.has(highlightManagementStateKey)).toBe(false);
    expect(redis.hashes.get(appRepairStateKey)?.get("status")).toBe("pending");
    for (const key of [subscriberGoalPostRegistryKey, postsKey, updatesKey]) {
      expect(redis.sortedSets.get(key)?.has(postId)).toBe(false);
    }
  });
});
