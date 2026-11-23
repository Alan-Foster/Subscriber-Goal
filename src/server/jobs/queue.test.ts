import { describe, expect, it, vi } from "vitest";
import { FakeRedisImpl } from "../testing/faultHarness";
import type { RedisClient } from "../types";
import {
  dueJobsKey,
  indexStoredJob,
  isDueJobRecord,
  updateJobRecord,
} from "./queue";
import { createJobCodec, jobRecordFields, type JobRecord } from "./record";

const job = {
  id: "example",
  stateKey: "example_job_state",
  version: "v1",
  codec: createJobCodec(jobRecordFields),
};
const now = 100;
const pending: Partial<JobRecord> = {
  version: job.version,
  status: "pending",
  nextRunAt: now - 1,
};

describe("due job index", () => {
  it.each([
    ["past due", pending, now - 1, true],
    ["due now", { ...pending, nextRunAt: now }, now, true],
    ["scheduled later", { ...pending, nextRunAt: now + 1 }, now + 1, false],
    ["old version", { ...pending, version: "old" }, undefined, false],
    [
      "missing status",
      { version: job.version, nextRunAt: now },
      undefined,
      false,
    ],
    [
      "exhausted",
      { ...pending, status: "exhausted", recurring: true },
      undefined,
      false,
    ],
    [
      "completed once",
      { ...pending, status: "complete", recurring: false },
      undefined,
      false,
    ],
    [
      "completed with no recurrence flag",
      { ...pending, status: "complete" },
      undefined,
      false,
    ],
    [
      "completed and recurring",
      { ...pending, status: "complete", recurring: true },
      now - 1,
      true,
    ],
    ["no next run", { ...pending, nextRunAt: null }, undefined, false],
  ] satisfies [string, Partial<JobRecord>, number | undefined, boolean][])(
    "handles a record that is %s",
    async (_description, record, expectedScore, due) => {
      const impl = new FakeRedisImpl();
      const redis = impl as unknown as RedisClient;
      const fields = job.codec.serialize(record);
      await impl.hSet(job.stateKey, fields);

      expect(isDueJobRecord(record, job.version, now)).toBe(due);
      await indexStoredJob(redis, job);

      expect(await impl.zScore(dueJobsKey, job.id)).toBe(expectedScore);
      expect(await impl.hGetAll(job.stateKey)).toEqual(fields);
    },
  );

  it("leaves an existing queue entry alone even if the stored schedule differs", async () => {
    const impl = new FakeRedisImpl();
    const redis = impl as unknown as RedisClient;
    await impl.hSet(job.stateKey, job.codec.serialize(pending));
    await impl.zAdd(dueJobsKey, { member: job.id, score: 0 });
    const watch = vi.spyOn(impl, "watch");

    await indexStoredJob(redis, job);

    expect(watch).not.toHaveBeenCalled();
    expect(await impl.zScore(dueJobsKey, job.id)).toBe(0);
  });

  it.each([4, 5])(
    "allows at most five update attempts after %i conflicts",
    async (conflicts) => {
      const impl = new FakeRedisImpl();
      const redis = impl as unknown as RedisClient;
      const watch = impl.watch.bind(impl);
      const transactions = vi.spyOn(impl, "watch");
      for (let count = 0; count < conflicts; count += 1) {
        transactions.mockImplementationOnce(async (...keys) => ({
          ...(await watch(...keys)),
          exec: async () => [],
        }));
      }

      if (conflicts === 4) {
        await expect(
          updateJobRecord(redis, job, () => pending),
        ).resolves.toEqual({});
        expect(await impl.hGetAll(job.stateKey)).toEqual(
          job.codec.serialize(pending),
        );
        expect(await impl.zScore(dueJobsKey, job.id)).toBe(now - 1);
      } else {
        await expect(
          updateJobRecord(redis, job, () => pending),
        ).rejects.toThrow(
          "Job state changed during every update attempt: example",
        );
        expect(await impl.hGetAll(job.stateKey)).toEqual({});
        expect(await impl.zScore(dueJobsKey, job.id)).toBeUndefined();
      }
      expect(transactions).toHaveBeenCalledTimes(5);
    },
  );
});
