import type { RedisClient } from "../types";
import type { JobCodec, JobRecord } from "./record";

export const dueJobsKey = "server_due_jobs_v1";

export type JobStorage<T extends JobRecord> = {
  id: string;
  stateKey: string;
  version: string;
  codec: JobCodec<T>;
};

function getDueAt(record: Partial<JobRecord>, version: string): number | null {
  return record.version === version &&
    record.status !== undefined &&
    record.status !== "exhausted" &&
    (record.status !== "complete" || record.recurring === true)
    ? (record.nextRunAt ?? null)
    : null;
}

export async function updateJobRecord<T extends JobRecord>(
  redis: RedisClient,
  job: JobStorage<T>,
  update: (
    record: Partial<T>,
  ) => Partial<JobRecord> | Partial<T> | null | undefined,
): Promise<Partial<T> | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tx = await redis.watch(job.stateKey);
    let multiStarted = false;
    try {
      const record = job.codec.parse(await redis.hGetAll(job.stateKey));
      const patch = update(record);
      if (patch === undefined) {
        await tx.unwatch();
        return undefined;
      }
      const fields =
        patch === null ? {} : job.codec.serialize(patch as Partial<T>);
      const dueAt =
        patch === null ? null : getDueAt({ ...record, ...patch }, job.version);
      await tx.multi();
      multiStarted = true;
      if (patch === null) await tx.del(job.stateKey);
      else if (Object.keys(fields).length > 0)
        await tx.hSet(job.stateKey, fields);
      if (dueAt === null) await tx.zRem(dueJobsKey, [job.id]);
      else await tx.zAdd(dueJobsKey, { member: job.id, score: dueAt });
      if ((await tx.exec()).length > 0) return record;
    } catch (error) {
      try {
        await (multiStarted ? tx.discard() : tx.unwatch());
      } catch {
        // diagnostic-allow-silent: rethrow the original transaction failure.
      }
      throw error;
    }
  }
  throw new Error(`Job state changed during every update attempt: ${job.id}`);
}

/** Indexes pre-queue records in place without resetting their schedules. */
export async function indexStoredJob<T extends JobRecord>(
  redis: RedisClient,
  job: JobStorage<T>,
): Promise<void> {
  if ((await redis.zScore(dueJobsKey, job.id)) != null) return;
  await updateJobRecord(redis, job, (record) =>
    getDueAt(record, job.version) === null ? undefined : {},
  );
}

export function isDueJobRecord(
  record: Partial<JobRecord>,
  version: string,
  nowMs: number,
): boolean {
  const dueAt = getDueAt(record, version);
  return dueAt !== null && dueAt <= nowMs;
}
