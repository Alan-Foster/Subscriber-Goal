import { describe, expect, it, vi } from "vitest";
import { FakeRedisImpl, Gate } from "../testing/faultHarness";
import type { RedisClient } from "../types";
import { getJobRetry } from "./backoff";
import { dueJobsKey, updateJobRecord } from "./queue";
import { createJobCodec, jobRecordFields, textField } from "./record";
import { defineDueJob, dispatchDueJobs, jobRunnerBudgetMs } from "./runner";

const codec = createJobCodec({ ...jobRecordFields, targetPostId: textField });
const retryPolicy = { baseMs: 300_000, maxMs: 3_600_000 };
const pending = { version: "v1", status: "pending", attempts: 0 } as const;

function storage(id: string) {
  return { id, version: "v1", stateKey: `test_job:${id}`, codec };
}

function worker(
  id: string,
  handle = vi.fn(async () => ({ status: "complete" as const })),
) {
  return defineDueJob({
    storage: storage(id),
    lockKey: `test_job_lock:${id}`,
    lockTtlMs: 60_000,
    backoff: { ...retryPolicy, maxAttempts: 2 },
    handle,
  });
}

async function enqueue(redis: RedisClient, id: string, nextRunAt: number) {
  await updateJobRecord(redis, storage(id), () => ({ ...pending, nextRunAt }));
}

describe("job records and retries", () => {
  it("round-trips existing hash field names and values", () => {
    const raw = {
      version: "v1",
      status: "complete",
      attempts: "4",
      recurring: "false",
      nextRunAt: "",
      startedAt: "0",
      targetPostId: "t3_goal",
    };
    expect(codec.parse(raw)).toEqual({
      version: "v1",
      status: "complete",
      attempts: 4,
      recurring: false,
      nextRunAt: null,
      startedAt: 0,
      targetPostId: "t3_goal",
    });
    expect(codec.serialize(codec.parse(raw))).toEqual(raw);
    expect(codec.parse({ nextRunAt: "invalid", status: "unknown" })).toEqual(
      {},
    );
  });

  it("doubles retry delays with an optional bounded jitter and cap", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => getJobRetry(retryPolicy, n))).toEqual(
      [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000].map(
        (delayMs) => ({ exhausted: false, delayMs }),
      ),
    );
    const policy = { ...retryPolicy, jitterFraction: 0.2, maxAttempts: 6 };
    expect(getJobRetry(policy, 1, () => 0.5)).toEqual({
      exhausted: false,
      delayMs: 330_000,
    });
    expect(getJobRetry(policy, 5, () => 0.5)).toEqual({
      exhausted: false,
      delayMs: 3_600_000,
    });
    expect(getJobRetry(policy, 6)).toEqual({ exhausted: true });
  });
});

describe("due job dispatcher", () => {
  it("retries an interrupted enqueue without leaving half of a record behind", async () => {
    const impl = new FakeRedisImpl();
    const redis = impl as unknown as RedisClient;
    const now = Date.now();
    const watch = impl.watch.bind(impl);
    vi.spyOn(impl, "watch").mockImplementationOnce(async (...keys) => ({
      ...(await watch(...keys)),
      exec: async () => {
        throw new Error("transaction interrupted before commit");
      },
    }));

    await expect(enqueue(redis, "job", now)).rejects.toThrow(
      "transaction interrupted",
    );
    expect(await impl.zScore(dueJobsKey, "job")).toBeUndefined();
    expect(await impl.hGetAll(storage("job").stateKey)).toEqual({});

    await enqueue(redis, "job", now);
    await enqueue(redis, "job", now);
    expect(await impl.zRange(dueJobsKey, 0, -1)).toEqual([
      { member: "job", score: now },
    ]);
  });

  it("restores the due job when the claim uses the remaining budget", async () => {
    const impl = new FakeRedisImpl();
    const redis = impl as unknown as RedisClient;
    let now = Date.now();
    const due = now;
    const handle = vi.fn(async () => ({ status: "complete" as const }));
    const jobs = [worker("job", handle)];
    await enqueue(redis, "job", due);
    const watch = impl.watch.bind(impl);
    vi.spyOn(impl, "watch").mockImplementationOnce(async (...keys) => {
      const tx = await watch(...keys);
      return {
        ...tx,
        exec: async () => {
          const result = await tx.exec();
          now += jobRunnerBudgetMs;
          return result;
        },
      };
    });

    await dispatchDueJobs(redis, jobs, { now: () => now });
    expect(handle).not.toHaveBeenCalled();
    expect(await impl.zScore(dueJobsKey, "job")).toBe(due);
    expect(await impl.hGet(storage("job").stateKey, "status")).toBe("pending");
    await dispatchDueJobs(redis, jobs, { now: () => now });
    expect(handle).toHaveBeenCalledOnce();
  });

  it("deduplicates enqueue and defers a later job without changing its deadline", async () => {
    const impl = new FakeRedisImpl();
    const redis = impl as unknown as RedisClient;
    let now = Date.now();
    const due = now;
    const first = vi.fn(async () => {
      now += jobRunnerBudgetMs;
      return { status: "complete" as const };
    });
    const second = vi.fn(async () => ({ status: "complete" as const }));
    const jobs = [worker("a", first), worker("b", second)];
    await enqueue(redis, "a", due - 1);
    await enqueue(redis, "a", due - 1);
    await enqueue(redis, "b", due);
    expect(await impl.zRange(dueJobsKey, 0, -1)).toHaveLength(2);

    await dispatchDueJobs(redis, jobs, { now: () => now });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(await impl.zScore(dueJobsKey, "b")).toBe(due);
    expect(await impl.hGet(storage("b").stateKey, "nextRunAt")).toBe(
      String(due),
    );

    await dispatchDueJobs(redis, jobs, { now: () => now });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(await impl.zRange(dueJobsKey, 0, -1)).toEqual([]);
  });

  it("runs a job only once across overlapping cron deliveries", async () => {
    const impl = new FakeRedisImpl();
    const redis = impl as unknown as RedisClient;
    const gate = new Gate();
    const handle = vi.fn(async () => {
      gate.arrive();
      await gate.released;
      return { status: "complete" as const };
    });
    const jobs = [worker("job", handle)];
    await enqueue(redis, "job", Date.now());
    const first = dispatchDueJobs(redis, jobs);
    try {
      await Promise.race([
        gate.reached,
        first.then(() => {
          throw new Error("Job was not claimed");
        }),
      ]);
      const competing = await dispatchDueJobs(redis, jobs);
      expect(competing.get("job")).toBe("not_due");
    } finally {
      gate.release();
      await first;
    }
    expect(handle).toHaveBeenCalledOnce();
    expect(await impl.zScore(dueJobsKey, "job")).toBeUndefined();
    expect(await impl.get("test_job_lock:job")).toBeUndefined();
  });

  it("isolates a handler failure, retries when due, and records exhaustion", async () => {
    const impl = new FakeRedisImpl();
    const redis = impl as unknown as RedisClient;
    let now = Date.now();
    const failing = vi.fn(async () => {
      throw new Error("interrupted");
    });
    const healthy = vi.fn(async () => ({ status: "complete" as const }));
    const jobs = [worker("failed", failing), worker("healthy", healthy)];
    await enqueue(redis, "failed", now - 1);
    await enqueue(redis, "healthy", now);
    const first = await dispatchDueJobs(redis, jobs, { now: () => now });
    expect(first.get("failed")).toBe("retry");
    expect(healthy).toHaveBeenCalledOnce();
    expect(await impl.zScore(dueJobsKey, "failed")).toBe(
      now + retryPolicy.baseMs,
    );
    now += retryPolicy.baseMs;
    const second = await dispatchDueJobs(redis, jobs, { now: () => now });
    expect(second.get("failed")).toBe("exhausted");
    expect(failing).toHaveBeenCalledTimes(2);
    expect(await impl.hGetAll(storage("failed").stateKey)).toMatchObject({
      status: "exhausted",
      attempts: "2",
      lastError: "interrupted",
      nextRunAt: "",
    });
    expect(await impl.zScore(dueJobsKey, "failed")).toBeUndefined();
  });
});
