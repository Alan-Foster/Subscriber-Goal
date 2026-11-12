import type { RedisClient } from "../types";

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
