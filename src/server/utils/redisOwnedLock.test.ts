import { describe, expect, it, vi } from "vitest";
import type { RedisClient } from "../types";
import { releaseOwnedRedisLock } from "./redisOwnedLock";

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
