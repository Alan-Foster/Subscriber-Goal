import { randomUUID } from "node:crypto";
import type { RedisClient } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";

type LockOptions = {
  nowMs?: number;
  token?: string;
};

type ReleaseDiagnostic = {
  event: string;
  context: Parameters<typeof logDiagnostic>[2];
};

export async function acquireRedisLock(
  redis: RedisClient,
  key: string,
  ttlMs: number,
  { nowMs = Date.now(), token = randomUUID() }: LockOptions = {},
): Promise<string | undefined> {
  await redis.set(key, token, {
    nx: true,
    expiration: new Date(nowMs + ttlMs),
  });
  // Confirm ownership by value because SET's return type does not distinguish NX contention.
  return (await redis.get(key)) === token ? token : undefined;
}

export async function releaseRedisLock(
  redis: RedisClient,
  key: string,
  token: string,
  diagnostic: ReleaseDiagnostic = {
    event: "redis_lock_release_failed",
    context: { phase: "lock_release" },
  },
): Promise<void> {
  try {
    await releaseOwnedRedisLock(redis, key, token);
  } catch (error) {
    logDiagnostic("warn", diagnostic.event, diagnostic.context, error);
  }
}

export async function withRedisLock<T>(
  redis: RedisClient,
  key: string,
  ttlMs: number,
  fn: (token: string) => Promise<T>,
  options?: LockOptions & { releaseDiagnostic?: ReleaseDiagnostic },
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const token = await acquireRedisLock(redis, key, ttlMs, options);
  if (!token) return { acquired: false };
  try {
    return { acquired: true, result: await fn(token) };
  } finally {
    await releaseRedisLock(redis, key, token, options?.releaseDiagnostic);
  }
}

type OwnedLockTransaction = {
  multi(): Promise<void>;
  del(...keys: string[]): Promise<unknown>;
  exec(): Promise<unknown>;
  discard(): Promise<unknown>;
  unwatch(): Promise<unknown>;
};

type TransactionRedis = RedisClient & {
  watch(...keys: string[]): Promise<OwnedLockTransaction>;
};

/** Atomically deletes a lock only while it is still owned by `token`. */
export async function releaseOwnedRedisLock(
  redis: RedisClient,
  key: string,
  token: string,
): Promise<boolean> {
  const transactionRedis = redis as TransactionRedis;
  if (typeof transactionRedis.watch !== "function") {
    throw new Error("redis_watch_not_supported");
  }

  const transaction = await transactionRedis.watch(key);
  let multiStarted = false;
  let closed = false;
  try {
    const storedToken = await redis.get(key);
    if (storedToken !== token) {
      await transaction.unwatch();
      closed = true;
      return false;
    }

    await transaction.multi();
    multiStarted = true;
    await transaction.del(key);
    const result = await transaction.exec();
    closed = true;
    return !Array.isArray(result) || result.length > 0;
  } catch (error) {
    if (!closed) {
      try {
        if (multiStarted) {
          await transaction.discard();
        } else {
          await transaction.unwatch();
        }
      } catch {
        // diagnostic-allow-silent: preserve the primary transaction failure; the lease TTL is the cleanup fallback.
        // The original failure is more useful; the lock TTL remains the fallback.
      }
    }
    throw error;
  }
}
