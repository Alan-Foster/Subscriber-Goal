import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { subscriberGoalPostRegistryKey } from "../data/subscriberGoalPostRegistry";
import {
  autoCreateNextGoalDelayMs,
  autoCreateNextGoalExhaustedKey,
  autoCreateNextGoalQueueKey,
  autoCreateNextGoalRetryAttemptsKey,
  subscriberGoalsKey,
} from "../data/subGoalData";
import { appRepairStateKey } from "../data/highlightRepair";
import { FakeRedisImpl } from "../testing/faultHarness";
import { appAccountHealthStateKey } from "./appAccountHealth";
import { goalHealthThrottleKey, runGoalHealthCheck } from "./goalHealth";
import { retiredSubscriberGoalKeyPrefix } from "./postRetirement";
import {
  onboardingSubscriberGoalVersion,
  onboardingSubscriberGoalStateKey,
} from "./onboardingState";
import { communityGoalMutationLockKey } from "./communityGoalMutation";

const hourMs = 3_600_000;
const startedAt = Date.UTC(2026, 10, 24, 19);

class GoalHealthRedis extends FakeRedisImpl {
  async mGet(keys: string[]) {
    return Promise.all(keys.map(async (key) => (await this.get(key)) ?? null));
  }
}

describe("goal health check", () => {
  let redis: GoalHealthRedis;
  let warn: MockInstance<typeof console.warn>;
  const community = {
    id: "t5_community",
    name: "ExampleSub",
    type: "public",
    numberOfSubscribers: 10_000,
  };
  const getCurrentSubreddit = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(startedAt);
    redis = new GoalHealthRedis();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getCurrentSubreddit.mockReset().mockResolvedValue(community);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function run(budgetMs = 8_000) {
    return runGoalHealthCheck({
      redis: redis as never,
      reddit: { getCurrentSubreddit } as never,
      deadlineMs: Date.now() + budgetMs,
    });
  }

  async function seedGoal(completedAt: number, registered = true) {
    await redis.hSet(subscriberGoalsKey, {
      t3_goal_goal: "10000",
      t3_goal_completed_time: String(completedAt),
    });
    if (registered)
      await redis.zAdd(subscriberGoalPostRegistryKey, {
        member: "t3_goal",
        score: startedAt - 90 * hourMs,
      });
  }

  function reports() {
    return warn.mock.calls.map(([line]) =>
      JSON.parse(String(line).slice("[diagnostic] ".length)),
    );
  }

  it.each([true, false])(
    "is quiet for an unfinished goal (registered: %s)",
    async (registered) => {
      await seedGoal(0, registered);
      await run();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("is quiet for a completed goal with a queued successor inside the 24-hour window", async () => {
    const completedAt = startedAt - hourMs;
    await seedGoal(completedAt);
    await redis.zAdd(autoCreateNextGoalQueueKey, {
      member: "t3_goal",
      score: completedAt + autoCreateNextGoalDelayMs,
    });
    await run();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs successor and repair state for a completed goal without a successor", async () => {
    const completedAt = startedAt - 2 * autoCreateNextGoalDelayMs;
    await seedGoal(completedAt);
    await redis.hSet(autoCreateNextGoalRetryAttemptsKey, { t3_goal: "3" });
    await redis.hSet(appRepairStateKey, {
      status: "pending",
      reason: "upgrade",
      nextRunAt: String(startedAt + hourMs),
    });
    await redis.hSet(appAccountHealthStateKey, { status: "unhealthy" });
    const set = vi.spyOn(redis, "set");
    const zAdd = vi.spyOn(redis, "zAdd");
    const hSet = vi.spyOn(redis, "hSet");
    const del = vi.spyOn(redis, "del");
    await run();
    expect(reports()).toEqual([
      expect.objectContaining({
        event: "goal_missing",
        workflow: "goal_health",
        subredditName: "ExampleSub",
        reason: "successor_missing",
        postId: "t3_goal",
        goalStatus: "completed",
        completedAt,
        successorQueued: false,
        successorRetries: 3,
        successorExhausted: false,
        cancellationReason: "unknown",
        onboardingStatus: "none",
        appRepairStatus: "pending",
        appRepairReason: "upgrade",
        appRepairNextRunAt: startedAt + hourMs,
        appAccountHealthStatus: "unhealthy",
      }),
    ]);
    expect(
      set.mock.calls.every(
        ([key, , options]) =>
          key === goalHealthThrottleKey && options?.expiration instanceof Date,
      ),
    ).toBe(true);
    expect(redis.strings.get(goalHealthThrottleKey)?.expiresAt).toBeGreaterThan(
      startedAt,
    );
    expect(zAdd).not.toHaveBeenCalled();
    expect(hSet).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("avoids flagging a closed community or an unonboarded community below the onboarding threshold", async () => {
    getCurrentSubreddit.mockResolvedValueOnce({
      ...community,
      type: "private",
    });
    await run();
    vi.setSystemTime(startedAt + hourMs);
    getCurrentSubreddit.mockResolvedValueOnce({
      ...community,
      numberOfSubscribers: 999,
    });
    await run();
    expect(warn).not.toHaveBeenCalled();
  });

  it("honors a recorded opt-out for the same classic goal", async () => {
    await seedGoal(startedAt - 25 * hourMs);
    await redis.hSet(onboardingSubscriberGoalStateKey, {
      version: onboardingSubscriberGoalVersion,
      status: "complete",
      armedAt: String(startedAt - 72 * hourMs),
      creationStaggerMinutes: "0",
      operationId: "onboarding:1",
      resultStatus: "completed_auto_disabled",
      postId: "t3_goal",
    });
    await run();
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a newer Tiny surface as intentional even if an older classic completed later", async () => {
    await seedGoal(startedAt - 40 * hourMs);
    await redis.hSet(subscriberGoalsKey, { t3_tiny_post_height: "tiny" });
    await redis.zAdd(subscriberGoalPostRegistryKey, {
      member: "t3_tiny",
      score: startedAt - 50 * hourMs,
    });
    await run();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["confirmed_missing_post", "app_menu_deletion"])(
    "remembers a retired goal with reason %s",
    async (reason) => {
      await seedGoal(0);
      if (reason === "app_menu_deletion") {
        await redis.hSet(subscriberGoalsKey, {
          t3_older_goal: "5000",
          t3_older_completed_time: String(startedAt - 100 * hourMs),
        });
        await redis.zAdd(subscriberGoalPostRegistryKey, {
          member: "t3_older",
          score: startedAt - 150 * hourMs,
        });
      }
      await run();
      const retiredAt = startedAt + 10 * 60_000;
      await redis.zRem(subscriberGoalPostRegistryKey, ["t3_goal"]);
      await redis.hDel(subscriberGoalsKey, [
        "t3_goal_goal",
        "t3_goal_completed_time",
      ]);
      await redis.set(
        `${retiredSubscriberGoalKeyPrefix}:t3_goal`,
        JSON.stringify({ reason, retiredAt }),
      );
      vi.setSystemTime(startedAt + hourMs);
      await run();
      if (reason === "app_menu_deletion") {
        await redis.del(`${retiredSubscriberGoalKeyPrefix}:t3_goal`);
        vi.setSystemTime(startedAt + 2 * hourMs);
        await run();
        expect(warn).not.toHaveBeenCalled();
        await redis.hSet(subscriberGoalsKey, {
          t3_newer_goal: "5000",
          t3_newer_completed_time: String(startedAt + hourMs),
        });
        await redis.zAdd(subscriberGoalPostRegistryKey, {
          member: "t3_newer",
          score: startedAt + 30 * 60_000,
        });
        vi.setSystemTime(startedAt + 3 * hourMs);
        await run();
        expect(reports()).toEqual([
          expect.objectContaining({
            postId: "t3_newer",
            reason: "successor_missing",
          }),
        ]);
      } else
        expect(reports()).toEqual([
          expect.objectContaining({
            event: "goal_missing",
            postId: "t3_goal",
            reason: "goal_retired",
            goalStatus: "retired",
            retiredAt,
          }),
        ]);
    },
  );

  it("reports an overdue successor and the oldest observed pending age", async () => {
    const completedAt = startedAt - 35 * hourMs;
    const dueAt = completedAt + autoCreateNextGoalDelayMs;
    await seedGoal(completedAt);
    await redis.zAdd(autoCreateNextGoalQueueKey, {
      member: "t3_goal",
      score: dueAt,
    });
    await run();
    expect(reports()).toEqual([
      expect.objectContaining({
        reason: "successor_overdue",
        successorQueued: true,
        successorDueAt: dueAt,
        oldestPendingAgeMs: 35 * hourMs,
      }),
    ]);
  });

  it("allows fresh onboarding, known creation records, and a held mutation lease", async () => {
    await redis.hSet(onboardingSubscriberGoalStateKey, {
      version: onboardingSubscriberGoalVersion,
      status: "pending",
      armedAt: String(startedAt - hourMs),
      nextRunAt: String(startedAt + hourMs),
      creationStaggerMinutes: "0",
      operationId: "onboarding:1",
    });
    await run();
    expect(warn).not.toHaveBeenCalled();
    vi.setSystemTime(startedAt + 5 * hourMs);
    await redis.hSet("subscriber_goal_creation_v1:onboarding:1", {
      status: "submitting",
      startedAt: String(Date.now()),
    });
    await run();
    expect(warn).not.toHaveBeenCalled();
    vi.setSystemTime(startedAt + 9 * hourMs);
    await redis.set(communityGoalMutationLockKey, "active");
    await run();
    expect(warn).not.toHaveBeenCalled();
    vi.setSystemTime(startedAt + 10 * hourMs);
    await redis.del(communityGoalMutationLockKey);
    await run();
    expect(reports()).toEqual([
      expect.objectContaining({
        reason: "onboarding_overdue",
        oldestPendingAgeMs: 11 * hourMs,
      }),
    ]);
  });

  it("deduplicates the same warning until 24 hours and logs a changed reason sooner", async () => {
    await seedGoal(startedAt - 100 * hourMs);
    await run();
    vi.setSystemTime(startedAt + hourMs);
    await run();
    expect(warn).toHaveBeenCalledOnce();
    await redis.hSet(autoCreateNextGoalExhaustedKey, { t3_goal: "5" });
    vi.setSystemTime(startedAt + 2 * hourMs);
    await run();
    vi.setSystemTime(startedAt + 25 * hourMs);
    await run();
    expect(warn).toHaveBeenCalledTimes(2);
    vi.setSystemTime(startedAt + 26 * hourMs);
    await run();
    expect(reports().map(({ reason }) => reason)).toEqual([
      "successor_missing",
      "successor_exhausted",
      "successor_exhausted",
    ]);
  });

  it("caps each scan and continues next hour without warning on a partial inventory", async () => {
    const scan = vi
      .spyOn(redis, "hScan")
      .mockImplementation(async (_key, cursor) => ({
        cursor: cursor < 6 ? cursor + 1 : 0,
        fieldValues: [],
      }));
    await run();
    expect(scan).toHaveBeenCalledTimes(6);
    expect(warn).not.toHaveBeenCalled();
    vi.setSystemTime(startedAt + hourMs);
    await run();
    expect(scan).toHaveBeenLastCalledWith(
      subscriberGoalsKey,
      6,
      undefined,
      500,
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  it("honors the remaining budget and runs at most hourly", async () => {
    await run(2_999);
    expect(await redis.get(goalHealthThrottleKey)).toBeUndefined();
    expect(getCurrentSubreddit).not.toHaveBeenCalled();
    await run();
    vi.setSystemTime(startedAt + hourMs - 1);
    await run();
    expect(getCurrentSubreddit).toHaveBeenCalledOnce();
    vi.setSystemTime(startedAt + hourMs);
    await run();
    expect(getCurrentSubreddit).toHaveBeenCalledTimes(2);
  });

  it("skips a check when another updater wins the hourly claim", async () => {
    const watch = redis.watch.bind(redis);
    vi.spyOn(redis, "watch").mockImplementationOnce(async (...keys) => ({
      ...(await watch(...keys)),
      exec: async () => [],
    }));
    await run();
    expect(getCurrentSubreddit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(await redis.get(goalHealthThrottleKey)).toBeUndefined();
  });

  it("contains Redis and Reddit errors in the check", async () => {
    getCurrentSubreddit.mockRejectedValueOnce(new Error("Reddit unavailable"));
    await expect(run()).resolves.toBeUndefined();
    vi.setSystemTime(startedAt + hourMs);
    vi.spyOn(redis, "get").mockRejectedValueOnce(
      new Error("Redis unavailable"),
    );
    await expect(run()).resolves.toBeUndefined();
    expect(reports()).toEqual([
      expect.objectContaining({
        event: "goal_health_check_failed",
        errorMessage: "Reddit unavailable",
      }),
      expect.objectContaining({
        event: "goal_health_check_failed",
        errorMessage: "Redis unavailable",
      }),
    ]);
  });

  it("returns at the deadline even when the Reddit lookup is still pending", async () => {
    let resolveLookup: ((value: typeof community) => void) | undefined;
    getCurrentSubreddit.mockImplementationOnce(
      () =>
        new Promise<typeof community>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const inventory = vi.spyOn(redis, "hScan");
    const running = run(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(running).resolves.toBeUndefined();
    expect(reports()).toEqual([
      expect.objectContaining({
        event: "goal_health_check_failed",
        errorMessage: "Goal health check exceeded the runner budget.",
      }),
    ]);
    expect(resolveLookup).toBeDefined();
    resolveLookup?.(community);
    await vi.advanceTimersByTimeAsync(0);
    expect(inventory).not.toHaveBeenCalled();
  });
});
