import { describe, expect, it } from "vitest";
import {
  getRegisteredSubscriberGoalPosts,
  registerSubscriberGoalPost,
  removeSubscriberGoalPost,
  subscriberGoalPostRegistryKey,
} from "./subscriberGoalPostRegistry";

class TestRedis {
  private readonly entries = new Map<string, Map<string, number>>();

  async zAdd(
    key: string,
    ...values: { member: string; score: number }[]
  ): Promise<void> {
    const set = this.entries.get(key) ?? new Map<string, number>();
    for (const value of values) set.set(value.member, value.score);
    this.entries.set(key, set);
  }

  async zRange(key: string): Promise<{ member: string; score: number }[]> {
    return [...(this.entries.get(key)?.entries() ?? [])]
      .map(([member, score]) => ({ member, score }))
      .sort((left, right) => left.score - right.score);
  }

  async zRem(key: string, members: string[]): Promise<void> {
    for (const member of members) this.entries.get(key)?.delete(member);
  }
}

describe("subscriber goal post registry", () => {
  it("registers every post idempotently and removes confirmed stale posts", async () => {
    const redis = new TestRedis();

    await registerSubscriberGoalPost(
      redis as never,
      "t3_regular",
      new Date(100),
    );
    await registerSubscriberGoalPost(redis as never, "t3_tiny", 200);
    await registerSubscriberGoalPost(redis as never, "t3_regular", 300);

    await expect(
      getRegisteredSubscriberGoalPosts(redis as never),
    ).resolves.toEqual(["t3_tiny", "t3_regular"]);

    await removeSubscriberGoalPost(redis as never, "t3_tiny");
    await expect(
      getRegisteredSubscriberGoalPosts(redis as never),
    ).resolves.toEqual(["t3_regular"]);
    expect(subscriberGoalPostRegistryKey).toBe(
      "subscriber_goal_post_registry_v1",
    );
  });
});
