import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RedisClient } from "../types";

const lock = vi.hoisted(() => ({
  owner: undefined as string | undefined,
}));

vi.mock("../utils/redisOwnedLock", () => ({
  acquireRedisLock: vi.fn(async () => {
    if (lock.owner) return undefined;
    lock.owner = "token";
    return "token";
  }),
  releaseRedisLock: vi.fn(async () => {
    lock.owner = undefined;
  }),
}));

import {
  CommunityGoalMutationInProgressError,
  withCommunityGoalMutationLease,
} from "./communityGoalMutation";
import {
  communityGoalMutationHolderKey,
  leaseHoldLogThresholdMs,
} from "./communityGoalLeaseDiagnostics";

function createRedis() {
  const values = new Map<string, string>();
  return {
    values,
    redis: {
      get: vi.fn(async (key: string) => values.get(key)),
      set: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
        return "OK";
      }),
    } as unknown as RedisClient,
  };
}

const events = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(
    (call) =>
      JSON.parse(String(call[0]).replace("[diagnostic] ", "")) as Record<
        string,
        unknown
      >,
  );

beforeEach(() => {
  lock.owner = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("community lease diagnostics", () => {
  it("records the holder and names it when another caller finds the lease busy", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { redis, values } = createRedis();

    await withCommunityGoalMutationLease(
      redis,
      async () => {
        expect(
          JSON.parse(values.get(communityGoalMutationHolderKey) ?? "{}"),
        ).toMatchObject({ label: "completed_update_cleanup" });
        await expect(
          withCommunityGoalMutationLease(
            redis,
            async () => "never",
            undefined,
            undefined,
            "goal_creation",
          ),
        ).rejects.toBeInstanceOf(CommunityGoalMutationInProgressError);
      },
      undefined,
      undefined,
      "completed_update_cleanup",
    );

    const busy = events(info).find((e) => e.event === "community_lease_busy");
    expect(busy).toMatchObject({
      label: "goal_creation",
      holder: "completed_update_cleanup",
      reason: "lock_busy",
    });
  });

  it("logs long holds at release, and stays quiet for short ones", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { redis } = createRedis();

    await withCommunityGoalMutationLease(
      redis,
      async () => "fast",
      undefined,
      undefined,
      "fast_caller",
    );
    await withCommunityGoalMutationLease(
      redis,
      async () => {
        vi.advanceTimersByTime(leaseHoldLogThresholdMs + 1);
        return "slow";
      },
      undefined,
      undefined,
      "slow_caller",
    );

    const timing = events(info).filter(
      (e) => e.event === "community_lease_timing",
    );
    expect(timing).toHaveLength(1);
    expect(timing[0]).toMatchObject({ label: "slow_caller" });
    expect(Number(timing[0]?.heldMs)).toBeGreaterThan(leaseHoldLogThresholdMs);
  });

  it("keeps leasing working when the holder record can't be written or read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const redis = {
      get: vi.fn(async () => {
        throw new Error("redis down");
      }),
      set: vi.fn(async () => {
        throw new Error("redis down");
      }),
    } as unknown as RedisClient;

    await expect(
      withCommunityGoalMutationLease(
        redis,
        async () => {
          await expect(
            withCommunityGoalMutationLease(redis, async () => "x"),
          ).rejects.toBeInstanceOf(CommunityGoalMutationInProgressError);
          return "ok";
        },
        undefined,
        undefined,
        "holder",
      ),
    ).resolves.toBe("ok");
    expect(events(warn).map((e) => e.event)).toEqual([
      "community_lease_holder_unrecorded",
      "community_lease_holder_unreadable",
    ]);
  });

  it("reports an unknown holder when the record is missing or unreadable", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { redis, values } = createRedis();
    lock.owner = "someone-else";
    values.set(communityGoalMutationHolderKey, "not json");
    await expect(
      withCommunityGoalMutationLease(redis, async () => "x"),
    ).rejects.toBeInstanceOf(CommunityGoalMutationInProgressError);
    expect(
      events(info).find((e) => e.event === "community_lease_busy"),
    ).toMatchObject({ holder: "unknown", label: "unlabeled" });
  });
});
