import { describe, expect, it, vi } from "vitest";
import {
  automaticGoalPrerequisiteMaxAgeMs,
  automaticGoalPrerequisiteRetriesKey,
  automaticGoalRetryGenerationsKey,
  beginAutomaticGoalRetryGeneration,
  nextAutomaticGoalPrerequisiteRetry,
  notifyAutomaticGoalExhausted,
  rearmAutomaticGoalReconciliation,
  resetAutomaticGoalPrerequisiteRetry,
} from "./automaticGoalRetry";

class TestRedis {
  hashes = new Map<string, Map<string, string>>();
  values = new Map<string, string>();
  async hGet(key: string, field: string) {
    return this.hashes.get(key)?.get(field);
  }
  async hGetAll(key: string) {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }
  async hSet(key: string, fields: Record<string, string>) {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(fields)) hash.set(field, value);
    this.hashes.set(key, hash);
  }
  async hDel(key: string, fields: string[]) {
    for (const field of fields) this.hashes.get(key)?.delete(field);
  }
  async set(key: string, value: string, options?: { nx?: boolean }) {
    if (!options?.nx || !this.values.has(key)) this.values.set(key, value);
  }
  async get(key: string) {
    return this.values.get(key);
  }
}

describe("automatic goal prerequisite windows", () => {
  it("keeps uncapped attempts and the original first deferral, with capped delays and a 48-hour deadline", async () => {
    const redis = new TestRedis();
    let nowMs = 0;
    for (let attempt = 1; attempt <= 10; attempt++) {
      const retry = await nextAutomaticGoalPrerequisiteRetry(
        redis as never,
        "op",
        nowMs,
      );
      expect(retry.attempts).toBe(attempt);
      expect(retry.retryAt! - nowMs).toBe(
        Math.min(300_000 * 2 ** (attempt - 1), 3_600_000),
      );
      nowMs = retry.retryAt!;
    }
    expect(
      await redis.hGet(
        automaticGoalPrerequisiteRetriesKey,
        "op:firstDeferredAt",
      ),
    ).toBe("0");
    await expect(
      nextAutomaticGoalPrerequisiteRetry(
        redis as never,
        "op",
        automaticGoalPrerequisiteMaxAgeMs - 1,
      ),
    ).resolves.toEqual({
      attempts: 11,
      retryAt: automaticGoalPrerequisiteMaxAgeMs,
    });
    await expect(
      nextAutomaticGoalPrerequisiteRetry(
        redis as never,
        "op",
        automaticGoalPrerequisiteMaxAgeMs,
      ),
    ).resolves.toEqual({ attempts: 12, retryAt: null });
  });

  it("deletes both fields on success and starts a fresh window on re-arm", async () => {
    const redis = new TestRedis();
    await nextAutomaticGoalPrerequisiteRetry(redis as never, "op", 1_000);
    await resetAutomaticGoalPrerequisiteRetry(redis as never, "op");
    expect(await redis.hGetAll(automaticGoalPrerequisiteRetriesKey)).toEqual(
      {},
    );
    await nextAutomaticGoalPrerequisiteRetry(redis as never, "op", 2_000);
    await beginAutomaticGoalRetryGeneration(redis as never, "op");
    expect(await redis.hGetAll(automaticGoalPrerequisiteRetriesKey)).toEqual(
      {},
    );
    expect(await redis.hGet(automaticGoalRetryGenerationsKey, "op")).toBe("1");
    await expect(
      nextAutomaticGoalPrerequisiteRetry(
        redis as never,
        "op",
        automaticGoalPrerequisiteMaxAgeMs + 3_000,
      ),
    ).resolves.toEqual({
      attempts: 1,
      retryAt: automaticGoalPrerequisiteMaxAgeMs + 303_000,
    });
  });

  it.each([false, true])(
    "allows one notice per generation, including a lost Modmail response (lost=%s)",
    async (lost) => {
      const redis = new TestRedis();
      const send = vi.fn(async () => {
        if (lost) throw new Error("response lost");
      });
      const reddit = {
        getCurrentSubreddit: vi.fn(async () => ({
          id: "t5_test",
          language: "en",
        })),
        modMail: { createModNotification: send },
      };
      const notify = () =>
        notifyAutomaticGoalExhausted({
          redis: redis as never,
          reddit: reddit as never,
          operationId: "op",
          unresolved: false,
          language: "en",
        });
      await notify();
      await notify();
      expect(send).toHaveBeenCalledOnce();
      await beginAutomaticGoalRetryGeneration(redis as never, "op");
      await notify();
      await notify();
      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it("re-arms exhausted ambiguous lookup without changing its operation or submission marker", async () => {
    const redis = new TestRedis();
    const key = "subscriber_goal_creation_v1:op";
    await redis.hSet(key, {
      status: "submission_unknown",
      submissionMarker: "original",
      subredditId: "t5_test",
      subredditName: "Test",
      reconciliationStatus: "exhausted",
    });
    await nextAutomaticGoalPrerequisiteRetry(redis as never, "op", 1_000);
    await expect(
      rearmAutomaticGoalReconciliation(redis as never, "op", 2_000),
    ).resolves.toBe(true);
    expect(await redis.hGetAll(key)).toMatchObject({
      status: "submission_unknown",
      submissionMarker: "original",
      reconciliationStatus: "pending",
      reconciliationNextAt: "2000",
    });
    expect(await redis.hGetAll(automaticGoalPrerequisiteRetriesKey)).toEqual(
      {},
    );
    expect(await redis.hGet(automaticGoalRetryGenerationsKey, "op")).toBe("1");
    await rearmAutomaticGoalReconciliation(redis as never, "op", 3_000);
    expect(await redis.hGet(automaticGoalRetryGenerationsKey, "op")).toBe("1");
  });
});
