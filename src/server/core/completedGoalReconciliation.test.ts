import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAppSettings } from "../settings";
import {
  CommunityGoalMutationInProgressError,
  communityGoalMutationLockKey,
  type CommunityGoalMutationLease,
} from "./communityGoalMutation";

const appSettings: ServerAppSettings = {
  promoSubreddit: "SubGoal",
  crosspostAuthoritySubreddit: "SubGoal",
  crosspostMaxSourcePostAgeMinutes: 10,
  crosspostIngestionEnabled: true,
  crosspostMaxRevisionAgeMinutes: 10,
  maxCrosspostsPerRun: 2,
  maxCrosspostsPerHour: 10,
  crosspostRetryWindowMinutes: 1_440,
  crosspostRetryBaseDelaySeconds: 60,
  crosspostRetryMaxDelayMinutes: 30,
  crosspostPendingBatchSize: 25,
};

const hoisted = vi.hoisted(() => ({
  clearAutomaticSuccessorSuppression: vi.fn(),
  repairAutoCreateNextGoal: vi.fn(),
  processDueAutoCreateNextGoals: vi.fn(),
}));

vi.mock("../data/subGoalData", () => ({
  clearAutomaticSuccessorSuppression:
    hoisted.clearAutomaticSuccessorSuppression,
  repairAutoCreateNextGoal: hoisted.repairAutoCreateNextGoal,
}));

vi.mock("./autoCreateNextGoal", () => ({
  autoCreateNextGoalSuccessorsKey: "auto_create_next_goal_v1_successors",
  processDueAutoCreateNextGoals: hoisted.processDueAutoCreateNextGoals,
}));

import { reconcileCompletedGoal } from "./completedGoalReconciliation";

class TestRedis {
  values = new Map<string, string>();
  successors = new Map<string, string>();
  suppression = new Set<string>();
  queued = new Set<string>();

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean },
  ): Promise<void> {
    if (options?.nx && this.values.has(key)) return;
    this.values.set(key, value);
  }

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  async hGet(_key: string, field: string): Promise<string | undefined> {
    expect(this.values.has(communityGoalMutationLockKey)).toBe(true);
    return this.successors.get(field);
  }
}

describe("reconcileCompletedGoal community mutation lease", () => {
  let redis: TestRedis;

  beforeEach(() => {
    vi.restoreAllMocks();
    redis = new TestRedis();
    redis.suppression.add("t3_source");
    hoisted.clearAutomaticSuccessorSuppression.mockReset();
    hoisted.clearAutomaticSuccessorSuppression.mockImplementation(
      async (_redis: unknown, postId: string) => {
        expect(redis.values.has(communityGoalMutationLockKey)).toBe(true);
        redis.suppression.delete(postId);
      },
    );
    hoisted.repairAutoCreateNextGoal.mockReset();
    hoisted.repairAutoCreateNextGoal.mockImplementation(
      async (_redis: unknown, postId: string) => {
        expect(redis.values.has(communityGoalMutationLockKey)).toBe(true);
        redis.queued.add(postId);
        return { status: "scheduled", runAt: 1_000, failureCount: 0 };
      },
    );
    hoisted.processDueAutoCreateNextGoals.mockReset();
    hoisted.processDueAutoCreateNextGoals.mockResolvedValue({
      due: 1,
      created: 1,
      skipped: 0,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });
  });

  it("acquires a lease before reading and repairing, then reuses it for the inline worker", async () => {
    await expect(
      reconcileCompletedGoal({
        reddit: {} as never,
        redis: redis as never,
        lifecycleSource: "install",
        sourcePostId: "t3_source",
        completedTime: 1_000,
        autoCreateNextGoal: true,
        nowMs: 2_000,
        appSettings,
      }),
    ).resolves.toMatchObject({ outcome: "replacement_created" });

    const workerLease = hoisted.processDueAutoCreateNextGoals.mock.calls[0]?.[0]
      ?.mutationLease as CommunityGoalMutationLease;
    expect(workerLease.key).toBe(communityGoalMutationLockKey);
    expect(redis.suppression.has("t3_source")).toBe(false);
    expect(redis.queued.has("t3_source")).toBe(true);
    expect(redis.values.has(communityGoalMutationLockKey)).toBe(false);
  });

  it("reuses an inherited lease without acquiring or releasing it", async () => {
    const mutationLease: CommunityGoalMutationLease = {
      key: communityGoalMutationLockKey,
      token: "inherited",
    };
    redis.values.set(communityGoalMutationLockKey, mutationLease.token);
    const setSpy = vi.spyOn(redis, "set");
    const delSpy = vi.spyOn(redis, "del");

    await reconcileCompletedGoal({
      reddit: {} as never,
      redis: redis as never,
      lifecycleSource: "upgrade",
      sourcePostId: "t3_source",
      completedTime: 1_000,
      autoCreateNextGoal: true,
      nowMs: 2_000,
      appSettings,
      mutationLease,
    });

    expect(setSpy).not.toHaveBeenCalled();
    expect(delSpy).not.toHaveBeenCalled();
    expect(hoisted.processDueAutoCreateNextGoals).toHaveBeenCalledWith(
      expect.objectContaining({ mutationLease }),
    );
    expect(redis.values.get(communityGoalMutationLockKey)).toBe("inherited");
  });

  it("leaves suppression and queue state intact when lease acquisition contends", async () => {
    redis.values.set(communityGoalMutationLockKey, "other-owner");

    await expect(
      reconcileCompletedGoal({
        reddit: {} as never,
        redis: redis as never,
        lifecycleSource: "install",
        sourcePostId: "t3_source",
        completedTime: 1_000,
        autoCreateNextGoal: true,
        nowMs: 2_000,
        appSettings,
      }),
    ).rejects.toBeInstanceOf(CommunityGoalMutationInProgressError);

    expect(redis.suppression.has("t3_source")).toBe(true);
    expect(redis.queued.has("t3_source")).toBe(false);
    expect(hoisted.clearAutomaticSuccessorSuppression).not.toHaveBeenCalled();
    expect(hoisted.repairAutoCreateNextGoal).not.toHaveBeenCalled();
    expect(hoisted.processDueAutoCreateNextGoals).not.toHaveBeenCalled();
  });
});
