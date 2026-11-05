import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RedisClient } from "../types";
import { subscriberDailyStatsKey } from "../data/subscriberDailyStats";
import { recoverEmergencySubscriberGoal } from "./emergencyGoalRecovery";

const createRedis = (fields: Record<string, string> = {}) =>
  ({
    hGetAll: vi.fn(async (key: string) =>
      key === subscriberDailyStatsKey ? fields : {},
    ),
  }) as unknown as RedisClient;

describe("recoverEmergencySubscriberGoal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the current count and advances exact milestone boundaries", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      recoverEmergencySubscriberGoal({
        redis: createRedis(),
        postId: "t3_missing",
        workflow: "init",
        route: "/api/init",
        currentSubscribers: 100,
        completed: false,
      }),
    ).resolves.toEqual({
      goal: 150,
      subscribers: 100,
      subscriberCountSource: "current",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /subscriber_goal_emergency_fallback.*\/api\/init.*missing_or_invalid_goal.*current.*"recoveredGoal":150/,
      ),
    );
  });

  it("uses the last-known count when the current count is invalid", async () => {
    await expect(
      recoverEmergencySubscriberGoal({
        redis: createRedis({ latestSubscribers: "74" }),
        postId: "t3_missing",
        workflow: "refresh",
        currentSubscribers: Number.NaN,
        completed: false,
      }),
    ).resolves.toEqual({
      goal: 75,
      subscribers: 74,
      subscriberCountSource: "last_known",
    });
  });

  it("falls back to zero and the first milestone when no count exists", async () => {
    await expect(
      recoverEmergencySubscriberGoal({
        redis: createRedis(),
        postId: "t3_missing",
        workflow: "refresh",
        currentSubscribers: undefined,
        completed: false,
      }),
    ).resolves.toEqual({
      goal: 5,
      subscribers: 0,
      subscriberCountSource: "zero_default",
    });
  });

  it("preserves completed state with a reached count instead of a future goal", async () => {
    await expect(
      recoverEmergencySubscriberGoal({
        redis: createRedis(),
        postId: "t3_completed",
        workflow: "init",
        currentSubscribers: 100,
        completed: true,
      }),
    ).resolves.toEqual({
      goal: 100,
      subscribers: 100,
      subscriberCountSource: "current",
    });
  });

  it("uses one as the completed fallback when no positive count exists", async () => {
    await expect(
      recoverEmergencySubscriberGoal({
        redis: createRedis(),
        postId: "t3_completed",
        workflow: "init",
        currentSubscribers: undefined,
        completed: true,
      }),
    ).resolves.toMatchObject({ goal: 1, subscribers: 0 });
  });
});
