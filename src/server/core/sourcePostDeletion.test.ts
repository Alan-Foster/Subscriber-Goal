import { describe, expect, it, vi } from "vitest";
import {
  dispatchConfirmedSourceDeletion,
  prepareSourcePostDeletionIntent,
  processDueSourcePostDeletions,
  recordSourceDeleteAttempt,
  recordSourceDeletionConfirmed,
} from "./sourcePostDeletion";
import {
  getSourcePostDeletionIntent,
  sourcePostDeletionDueKey,
} from "../data/sourcePostDeletion";

class TestRedis {
  values = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  sorted = new Map<string, Map<string, number>>();

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean },
  ): Promise<string | undefined> {
    if (options?.nx && this.values.has(key)) return undefined;
    this.values.set(key, value);
    return "OK";
  }
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async del(key: string): Promise<void> {
    this.values.delete(key);
  }
  async hSet(key: string, fields: Record<string, string>): Promise<void> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(fields)) hash.set(field, value);
    this.hashes.set(key, hash);
  }
  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }
  async zAdd(
    key: string,
    entry: { member: string; score: number },
  ): Promise<void> {
    const set = this.sorted.get(key) ?? new Map<string, number>();
    set.set(entry.member, entry.score);
    this.sorted.set(key, set);
  }
  async zRem(key: string, members: string[]): Promise<void> {
    for (const member of members) this.sorted.get(key)?.delete(member);
  }
  async zRange(key: string): Promise<Array<{ member: string; score: number }>> {
    return [...(this.sorted.get(key) ?? [])].map(([member, score]) => ({
      member,
      score,
    }));
  }
}

const settings = { promoSubreddit: "SubGoal" } as never;
const input = {
  postId: "t3_source" as const,
  subredditId: "t5_source" as const,
  subredditName: "ExampleSub",
};

describe("durable source post deletion", () => {
  it("fails closed when intent discoverability cannot be persisted", async () => {
    const redis = new TestRedis();
    redis.zAdd = vi.fn(async () => {
      throw new Error("unknown zadd result");
    });

    await expect(
      prepareSourcePostDeletionIntent(redis as never, input),
    ).rejects.toThrow("unknown zadd result");
  });

  it("reconciles a lost delete response without issuing another delete", async () => {
    const redis = new TestRedis();
    const prepared = await prepareSourcePostDeletionIntent(redis as never, {
      ...input,
      nowMs: 1_000,
    });
    const attempted = await recordSourceDeleteAttempt(
      redis as never,
      prepared,
      1_000,
    );
    // Make the verification due now, as the next real scheduler tick would.
    await redis.zAdd(sourcePostDeletionDueKey, {
      member: attempted.id,
      score: 1_000,
    });
    const updateWikiPage = vi.fn(async () => undefined);
    const reddit = {
      getPostById: vi.fn(async () => {
        throw Object.assign(new Error("gone"), { status: 404 });
      }),
      updateWikiPage,
    };

    await processDueSourcePostDeletions(
      reddit as never,
      redis as never,
      settings,
      { nowMs: 2_000 },
    );

    expect(reddit.getPostById).toHaveBeenCalledOnce();
    expect(updateWikiPage).toHaveBeenCalledOnce();
    await expect(
      getSourcePostDeletionIntent(redis as never, attempted.id),
    ).resolves.toMatchObject({ status: "dispatched", deleteAttemptCount: 1 });
  });

  it("keeps a live or ambiguously looked-up source from dispatching", async () => {
    const redis = new TestRedis();
    const prepared = await prepareSourcePostDeletionIntent(redis as never, {
      ...input,
      nowMs: 1_000,
    });
    const attempted = await recordSourceDeleteAttempt(
      redis as never,
      prepared,
      1_000,
    );
    await redis.zAdd(sourcePostDeletionDueKey, {
      member: attempted.id,
      score: 1_000,
    });
    const updateWikiPage = vi.fn();

    await processDueSourcePostDeletions(
      {
        getPostById: vi.fn(async () => ({ id: input.postId })),
        updateWikiPage,
      } as never,
      redis as never,
      settings,
      { nowMs: 2_000 },
    );

    expect(updateWikiPage).not.toHaveBeenCalled();
    await expect(
      getSourcePostDeletionIntent(redis as never, attempted.id),
    ).resolves.toMatchObject({ status: "verify_source" });
  });

  it("retains dispatch work when the wiki call or confirmation write fails", async () => {
    const redis = new TestRedis();
    const prepared = await prepareSourcePostDeletionIntent(redis as never, {
      ...input,
      nowMs: 1_000,
    });
    const confirmed = await recordSourceDeletionConfirmed(
      redis as never,
      prepared,
      1_000,
    );
    const reddit = {
      updateWikiPage: vi.fn(async () => {
        throw new Error("wiki unavailable");
      }),
    };

    await expect(
      dispatchConfirmedSourceDeletion(
        reddit as never,
        redis as never,
        settings,
        confirmed,
        2_000,
      ),
    ).rejects.toThrow("wiki unavailable");
    await expect(
      getSourcePostDeletionIntent(redis as never, confirmed.id),
    ).resolves.toMatchObject({ status: "dispatch_pending" });
  });
});
