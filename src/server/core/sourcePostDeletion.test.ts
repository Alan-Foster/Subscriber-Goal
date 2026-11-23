import type { RedditClient, RedisClient } from "../types";
import { defaultAppSettings, type ServerAppSettings } from "../settings";
import { FakeRedisImpl, Gate } from "../testing/faultHarness";
import { dueJobsKey } from "../jobs/queue";
import { dispatchDueJobs } from "../jobs/runner";
import { describe, expect, it, vi } from "vitest";
import {
  createSourcePostDeletionJob,
  dispatchConfirmedSourceDeletion,
  prepareSourcePostDeletionIntent,
  queueConfirmedSourceDeletionCleanup,
  recordSourceDeleteAttempt,
  recordSourceDeletionConfirmed,
} from "./sourcePostDeletion";
import {
  getSourcePostDeletionIntent,
  saveSourcePostDeletionIntent,
  sourcePostDeletionIntentId,
  sourcePostDeletionIntentsKey,
  sourcePostDeletionDueKey,
} from "../data/sourcePostDeletion";

class TestRedis extends FakeRedisImpl {
  // The legacy cases use synthetic timestamps close to the Unix epoch.
  override set(key: string, value: string, options?: { nx?: boolean }) {
    return super.set(
      key,
      value,
      options?.nx === undefined ? undefined : { nx: options.nx },
    );
  }
}

const settings = { promoSubreddit: "SubGoal" } as never;
const input = {
  postId: "t3_source" as const,
  subredditId: "t5_source" as const,
  subredditName: "ExampleSub",
};

async function processDueSourcePostDeletions(
  reddit: RedditClient,
  redis: RedisClient,
  appSettings: ServerAppSettings,
  options: { nowMs?: number; limit?: number } = {},
): Promise<void> {
  const { nowMs, limit } = options;
  await dispatchDueJobs(
    redis,
    [createSourcePostDeletionJob(reddit, redis, appSettings, limit)],
    nowMs === undefined ? {} : { now: () => nowMs },
  );
}

describe("durable source post deletion", () => {
  it("dispatches confirmed cleanup once even when the caller repeats it", async () => {
    const impl = new TestRedis();
    const redis = impl as unknown as RedisClient;
    const updateWikiPage = vi.fn(async () => undefined);
    const reddit = { updateWikiPage } as unknown as RedditClient;
    const id = sourcePostDeletionIntentId(input.subredditId, input.postId);

    await expect(
      queueConfirmedSourceDeletionCleanup(reddit, redis, defaultAppSettings, {
        ...input,
        nowMs: 1_000,
      }),
    ).resolves.toBe("dispatched");
    await expect(
      queueConfirmedSourceDeletionCleanup(reddit, redis, defaultAppSettings, {
        ...input,
        nowMs: 2_000,
      }),
    ).resolves.toBe("dispatched");

    expect(updateWikiPage).toHaveBeenCalledOnce();
    await expect(getSourcePostDeletionIntent(redis, id)).resolves.toMatchObject(
      {
        status: "dispatched",
        dispatchedAtMs: 1_000,
        attemptCount: 0,
      },
    );
    expect(await impl.zScore(sourcePostDeletionDueKey, id)).toBeUndefined();
  });

  it.each([0, 19])(
    "handles a dispatch outage after %i recorded failures",
    async (attemptCount) => {
      const impl = new TestRedis();
      const redis = impl as unknown as RedisClient;
      const updateWikiPage = vi
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error("wiki unavailable"));
      const reddit = { updateWikiPage } as unknown as RedditClient;
      const nowMs = 1_000;
      const id = sourcePostDeletionIntentId(input.subredditId, input.postId);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const tick = (now: number) =>
        processDueSourcePostDeletions(reddit, redis, defaultAppSettings, {
          nowMs: now,
        });
      try {
        await expect(
          queueConfirmedSourceDeletionCleanup(
            reddit,
            redis,
            defaultAppSettings,
            { ...input, nowMs },
          ),
        ).resolves.toBe("queued");
        const queued = await getSourcePostDeletionIntent(redis, id);
        expect(queued).toMatchObject({
          status: "dispatch_pending",
          nextAttemptMs: nowMs,
        });
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("source_post_deletion_dispatch_pending"),
        );
        if (!queued) throw new Error("Expected a persisted cleanup intent");
        if (attemptCount > 0)
          await saveSourcePostDeletionIntent(redis, {
            ...queued,
            attemptCount,
          });

        await tick(nowMs);
        const retryAt = nowMs + (attemptCount === 0 ? 60_000 : 30 * 60_000);
        await expect(
          getSourcePostDeletionIntent(redis, id),
        ).resolves.toMatchObject({
          status: attemptCount === 0 ? "dispatch_pending" : "terminal_failed",
          attemptCount: attemptCount + 1,
          nextAttemptMs: retryAt,
          lastError: "wiki unavailable",
        });
        expect(await impl.zScore(sourcePostDeletionDueKey, id)).toBe(
          attemptCount === 0 ? retryAt : undefined,
        );

        await tick(retryAt - 1);
        expect(updateWikiPage).toHaveBeenCalledTimes(2);
        updateWikiPage.mockResolvedValue(undefined);
        await tick(retryAt);
        await tick(retryAt + 1);
        expect(updateWikiPage).toHaveBeenCalledTimes(
          attemptCount === 0 ? 3 : 2,
        );
        await expect(
          getSourcePostDeletionIntent(redis, id),
        ).resolves.toMatchObject({
          status: attemptCount === 0 ? "dispatched" : "terminal_failed",
          attemptCount: attemptCount + 1,
        });
        expect(await impl.zScore(sourcePostDeletionDueKey, id)).toBeUndefined();
        const exhaustedLogs = warn.mock.calls.filter(([message]) =>
          String(message).includes("source_post_deletion_attempts_exhausted"),
        );
        expect(exhaustedLogs).toHaveLength(attemptCount === 0 ? 0 : 1);
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("indexes a legacy verification timer and dispatches it once at the original deadline", async () => {
    const redis = new TestRedis();
    const id = "t5_source:t3_source";
    const legacy = {
      ...input,
      id,
      status: "verify_source",
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
      nextAttemptMs: 500_000,
      attemptCount: 6,
      deleteAttemptCount: 1,
      lastError: "source_still_live",
    };
    await redis.hSet(sourcePostDeletionIntentsKey, {
      [id]: JSON.stringify(legacy),
    });
    await redis.zAdd(sourcePostDeletionDueKey, {
      member: id,
      score: legacy.nextAttemptMs,
    });
    const reddit = {
      getPostById: vi.fn(async () => {
        throw Object.assign(new Error("gone"), { status: 404 });
      }),
      updateWikiPage: vi.fn(async () => undefined),
    };
    const tick = (nowMs: number) =>
      processDueSourcePostDeletions(reddit as never, redis as never, settings, {
        nowMs,
      });

    await tick(499_999);
    expect(await redis.zScore(dueJobsKey, "source_post_deletion")).toBe(
      legacy.nextAttemptMs,
    );
    expect(await getSourcePostDeletionIntent(redis as never, id)).toEqual(
      legacy,
    );
    expect(reddit.getPostById).not.toHaveBeenCalled();

    await tick(500_000);
    await tick(500_001);
    expect(reddit.getPostById).toHaveBeenCalledOnce();
    expect(reddit.updateWikiPage).toHaveBeenCalledOnce();
    expect(await getSourcePostDeletionIntent(redis as never, id)).toMatchObject(
      {
        status: "dispatched",
        attemptCount: 6,
        deleteAttemptCount: 1,
      },
    );
    expect(
      await redis.zScore(dueJobsKey, "source_post_deletion"),
    ).toBeUndefined();
    expect(await redis.hGetAll("source_post_deletion_job_v1_state")).toEqual(
      {},
    );
  });

  it("keeps the next intent at its due time when the current intent spends the budget", async () => {
    const redis = new TestRedis();
    let now = Date.now();
    const dueAt = now;
    const first = await prepareSourcePostDeletionIntent(redis as never, {
      ...input,
      postId: "t3_first",
      nowMs: dueAt,
    });
    const second = await prepareSourcePostDeletionIntent(redis as never, {
      ...input,
      postId: "t3_second",
      nowMs: dueAt,
    });
    const reddit = {
      getPostById: vi.fn(async () => {
        now += 1_000;
        throw Object.assign(new Error("gone"), { status: 404 });
      }),
      updateWikiPage: vi.fn(async () => undefined),
    };
    const job = createSourcePostDeletionJob(
      reddit as never,
      redis as never,
      settings,
    );
    await dispatchDueJobs(redis as never, [job], {
      now: () => now,
      deadlineMs: dueAt + 1_000,
    });
    expect(reddit.getPostById).toHaveBeenCalledTimes(1);
    expect(
      await getSourcePostDeletionIntent(redis as never, first.id),
    ).toMatchObject({ status: "dispatched" });
    expect(
      await getSourcePostDeletionIntent(redis as never, second.id),
    ).toEqual(second);
    expect(await redis.zScore(dueJobsKey, "source_post_deletion")).toBe(dueAt);

    await dispatchDueJobs(redis as never, [job], { now: () => now });
    expect(reddit.getPostById).toHaveBeenCalledTimes(2);
    expect(
      await redis.zScore(dueJobsKey, "source_post_deletion"),
    ).toBeUndefined();
  });

  it("dispatches one verification across overlapping runner ticks", async () => {
    const redis = new TestRedis();
    const nowMs = Date.now();
    await prepareSourcePostDeletionIntent(redis as never, { ...input, nowMs });
    const gate = new Gate();
    const reddit = {
      getPostById: vi.fn(async () => {
        gate.arrive();
        await gate.released;
        throw Object.assign(new Error("gone"), { status: 404 });
      }),
      updateWikiPage: vi.fn(async () => undefined),
    };
    const tick = () =>
      processDueSourcePostDeletions(reddit as never, redis as never, settings, {
        nowMs,
      });
    const first = tick();
    try {
      await Promise.race([
        gate.reached,
        first.then(() => {
          throw new Error("Verification did not start");
        }),
      ]);
      await tick();
      expect(reddit.getPostById).toHaveBeenCalledOnce();
    } finally {
      gate.release();
      await first;
    }
    await tick();
    expect(reddit.getPostById).toHaveBeenCalledOnce();
    expect(reddit.updateWikiPage).toHaveBeenCalledOnce();
  });

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
      { nowMs: 1_000 },
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
      { nowMs: 62_000 },
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
      { nowMs: 1_000 },
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

  it("rechecks a stale due snapshot under the lease and preserves newer backoff", async () => {
    const redis = new TestRedis();
    const prepared = await prepareSourcePostDeletionIntent(redis as never, {
      ...input,
      nowMs: 1_000,
    });
    const attempted = await recordSourceDeleteAttempt(
      redis as never,
      prepared,
      { nowMs: 1_000 },
    );
    await redis.zAdd(sourcePostDeletionDueKey, {
      member: attempted.id,
      score: 1_000,
    });
    const backedOff = {
      ...attempted,
      nextAttemptMs: 5_000,
      attemptCount: 7,
      lastError: "newer failure",
    };
    const originalSet = redis.set.bind(redis);
    let moveIntoBackoff = true;
    redis.set = vi.fn(async (key, value, options) => {
      if (
        key === "subscriber_goal_community_mutation_v1_lock" &&
        moveIntoBackoff
      ) {
        moveIntoBackoff = false;
        await redis.hSet(sourcePostDeletionIntentsKey, {
          [attempted.id]: JSON.stringify(backedOff),
        });
        await redis.zAdd(sourcePostDeletionDueKey, {
          member: attempted.id,
          score: backedOff.nextAttemptMs,
        });
      }
      return originalSet(key, value, options);
    });
    const getPostById = vi.fn(async () => {
      throw Object.assign(new Error("gone"), { status: 404 });
    });
    const updateWikiPage = vi.fn(async () => undefined);

    await processDueSourcePostDeletions(
      { getPostById, updateWikiPage } as never,
      redis as never,
      settings,
      { nowMs: 2_000 },
    );

    expect(getPostById).not.toHaveBeenCalled();
    expect(updateWikiPage).not.toHaveBeenCalled();
    await expect(
      getSourcePostDeletionIntent(redis as never, attempted.id),
    ).resolves.toEqual(backedOff);
    expect(redis.zsets.get(sourcePostDeletionDueKey)?.get(attempted.id)).toBe(
      5_000,
    );

    await processDueSourcePostDeletions(
      { getPostById, updateWikiPage } as never,
      redis as never,
      settings,
      { nowMs: 5_000 },
    );
    expect(getPostById).toHaveBeenCalledOnce();
    expect(updateWikiPage).toHaveBeenCalledOnce();
  });

  it("does no work when the intent disappears before lease acquisition", async () => {
    const redis = new TestRedis();
    const prepared = await prepareSourcePostDeletionIntent(redis as never, {
      ...input,
      nowMs: 1_000,
    });
    const originalSet = redis.set.bind(redis);
    redis.set = vi.fn(async (key, value, options) => {
      if (key === "subscriber_goal_community_mutation_v1_lock") {
        redis.hashes.get(sourcePostDeletionIntentsKey)?.delete(prepared.id);
      }
      return originalSet(key, value, options);
    });
    const getPostById = vi.fn();
    const updateWikiPage = vi.fn();

    await processDueSourcePostDeletions(
      { getPostById, updateWikiPage } as never,
      redis as never,
      settings,
      { nowMs: 2_000 },
    );

    expect(getPostById).not.toHaveBeenCalled();
    expect(updateWikiPage).not.toHaveBeenCalled();
  });
});
