import { describe, expect, it, vi } from "vitest";
import type { RedisClient } from "../types";
import { releaseOwnedRedisLock, withRedisLock } from "./redisOwnedLock";
import { watchTestString } from "./testHashWatch";

function lockFixture() {
  const values = new Map<string, string>();
  const commands = {
    get: async (key: string) => values.get(key),
    del: async (key: string) => values.delete(key),
  };
  const watch = vi.fn((key: string) => watchTestString(commands, key));
  const set = vi.fn(
    async (key: string, token: string, options?: { nx?: boolean }) => {
      if (!options?.nx || !values.has(key)) values.set(key, token);
    },
  );
  return {
    redis: { ...commands, set, watch } as unknown as RedisClient,
    values,
    set,
    watch,
  };
}

describe("withRedisLock", () => {
  it("skips a concurrent caller and releases the lease so a subsequent caller can run", async () => {
    const { redis, values, set } = lockFixture();
    const skipped = vi.fn();
    const first = await withRedisLock(
      redis,
      "lease",
      30_000,
      async (token) => {
        expect(values.get("lease")).toBe(token);
        await expect(
          withRedisLock(redis, "lease", 30_000, skipped),
        ).resolves.toEqual({
          acquired: false,
        });
        expect(values.get("lease")).toBe(token);
        return "first";
      },
      { nowMs: 1_000 },
    );
    expect(first).toEqual({ acquired: true, result: "first" });
    expect(skipped).not.toHaveBeenCalled();
    expect(set).toHaveBeenNthCalledWith(1, "lease", expect.any(String), {
      nx: true,
      expiration: new Date(31_000),
    });
    expect(values.has("lease")).toBe(false);
    await expect(
      withRedisLock(redis, "lease", 30_000, async () => "second"),
    ).resolves.toEqual({ acquired: true, result: "second" });
  });

  it("keeps a successor's lease after the original lease expires", async () => {
    const { redis, values } = lockFixture();
    await withRedisLock(redis, "lease", 30_000, async () => {
      values.delete("lease");
      values.set("lease", "successor");
    });
    expect(values.get("lease")).toBe("successor");
  });

  it("releases the lease when work fails and lets the next attempt run", async () => {
    const { redis, values } = lockFixture();
    const failure = new Error("work failed");
    await expect(
      withRedisLock(redis, "lease", 30_000, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(values.has("lease")).toBe(false);
    await expect(
      withRedisLock(redis, "lease", 30_000, async () => "retried"),
    ).resolves.toEqual({ acquired: true, result: "retried" });
  });

  it("logs a release failure and preserves the work result or error", async () => {
    const { redis, watch, values } = lockFixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = new Error("work failed");
    watch.mockRejectedValue(new Error("Redis unavailable"));
    try {
      await expect(
        withRedisLock(redis, "lease", 30_000, async () => 42),
      ).resolves.toEqual({ acquired: true, result: 42 });
      expect(values.has("lease")).toBe(true);
      await expect(
        withRedisLock(redis, "other-lease", 30_000, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("redis_lock_release_failed"),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("releaseOwnedRedisLock", () => {
  it("deletes a lease when the watched token still belongs to the caller", async () => {
    const values = new Map([["lease", "owner-a"]]);
    let queuedDelete: string | undefined;
    const transaction = {
      multi: vi.fn(async () => undefined),
      del: vi.fn(async (key: string) => {
        queuedDelete = key;
      }),
      exec: vi.fn(async () => {
        if (queuedDelete) values.delete(queuedDelete);
        return [1];
      }),
      discard: vi.fn(async () => undefined),
      unwatch: vi.fn(async () => transaction),
    };
    const redis = {
      get: vi.fn(async (key: string) => values.get(key)),
      watch: vi.fn(async () => transaction),
    } as unknown as RedisClient;

    await expect(
      releaseOwnedRedisLock(redis, "lease", "owner-a"),
    ).resolves.toBe(true);
    expect(values.has("lease")).toBe(false);
  });

  it("cannot delete a successor lease when ownership changes before EXEC", async () => {
    const values = new Map([["lease", "owner-a"]]);
    let version = 1;
    let watchedVersion = 0;
    const transaction = {
      multi: vi.fn(async () => undefined),
      del: vi.fn(async () => undefined),
      exec: vi.fn(async () => {
        values.set("lease", "owner-b");
        version += 1;
        if (version !== watchedVersion) throw new Error("watch_conflict");
        values.delete("lease");
        return [1];
      }),
      discard: vi.fn(async () => undefined),
      unwatch: vi.fn(async () => transaction),
    };
    const redis = {
      get: vi.fn(async (key: string) => values.get(key)),
      watch: vi.fn(async () => {
        watchedVersion = version;
        return transaction;
      }),
    } as unknown as RedisClient;

    await expect(
      releaseOwnedRedisLock(redis, "lease", "owner-a"),
    ).rejects.toThrow("watch_conflict");
    expect(values.get("lease")).toBe("owner-b");
    expect(transaction.discard).toHaveBeenCalledOnce();
  });

  it("unwatches without deleting when the token does not match", async () => {
    const transaction = {
      multi: vi.fn(),
      del: vi.fn(),
      exec: vi.fn(),
      discard: vi.fn(),
      unwatch: vi.fn(async () => transaction),
    };
    const redis = {
      get: vi.fn(async () => "owner-b"),
      watch: vi.fn(async () => transaction),
    } as unknown as RedisClient;

    await expect(
      releaseOwnedRedisLock(redis, "lease", "owner-a"),
    ).resolves.toBe(false);
    expect(transaction.unwatch).toHaveBeenCalledOnce();
    expect(transaction.del).not.toHaveBeenCalled();
  });
});
