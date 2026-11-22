import { FakeRedisImpl, Gate } from "../testing/faultHarness";
import { resolveAppAccountHealthGate } from "../jobs/appAccountHealth";
import { dueJobsKey } from "../jobs/queue";
import { watchTestHash, watchTestString } from "../testing/testHashWatch";
import { appAccountRecoveryStateKey } from "./appAccountRecoveryState";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appAccountHealthStateKey,
  appAccountHealthRetryStateKey,
  appAccountInstallerKey,
  checkAppAccountHealth,
  rememberAppInstaller,
} from "./appAccountHealth";

class TestRedis {
  private readonly queue = new FakeRedisImpl();
  zAdd = this.queue.zAdd.bind(this.queue);
  zRem = this.queue.zRem.bind(this.queue);
  zScore = this.queue.zScore.bind(this.queue);
  values = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();

  beforeExec?: () => Promise<void>;
  async watch(key: string) {
    if (this.values.has(key)) return watchTestString(this, key);
    return watchTestHash(this, key, () => this.beforeExec?.());
  }

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
    this.hashes.delete(key);
  }
  async hGetAll(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }
  async hSet(key: string, fields: Record<string, string>): Promise<void> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(fields)) hash.set(field, value);
    this.hashes.set(key, hash);
  }
}

describe("app account health", () => {
  let redis: TestRedis;
  let permissions: string[];
  let reddit: {
    getAppUser: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
    modMail: {
      createModNotification: ReturnType<typeof vi.fn<() => Promise<string>>>;
    };
    sendPrivateMessage: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    redis = new TestRedis();
    permissions = ["posts"];
    reddit = {
      getAppUser: vi.fn().mockResolvedValue({
        username: "subscriber-goal",
        getModPermissionsForSubreddit: vi.fn(async () => permissions),
      }),
      modMail: {
        createModNotification: vi
          .fn<() => Promise<string>>()
          .mockResolvedValue("conv_1"),
      },
      sendPrivateMessage: vi.fn().mockResolvedValue(undefined),
    };
  });

  const check = () =>
    checkAppAccountHealth({
      reddit: reddit as never,
      redis: redis as never,
      subredditName: "ExampleSub",
      subredditId: "t5_example",
      nowMs: 100,
    });

  const tick = (nowMs: number, deadlineMs?: number) =>
    resolveAppAccountHealthGate({
      reddit: reddit as never,
      redis: redis as never,
      now: () => nowMs,
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    });

  it("stores a normalized installer username", async () => {
    await rememberAppInstaller(redis as never, "u/InstallingMod");
    expect(await redis.get(appAccountInstallerKey)).toBe("InstallingMod");
  });

  it("accepts Posts without requiring Flair and records healthy state", async () => {
    await expect(check()).resolves.toMatchObject({
      status: "healthy",
      healthy: true,
      permissions: ["posts"],
      notification: "not_needed",
    });
    expect(await redis.hGetAll(appAccountHealthStateKey)).toMatchObject({
      status: "healthy",
      permissions: "posts",
    });
    expect(reddit.modMail.createModNotification).not.toHaveBeenCalled();
  });

  it("sends one mod notification per unhealthy incident", async () => {
    permissions = [];

    await expect(check()).resolves.toMatchObject({
      status: "unhealthy",
      healthy: false,
      notification: "modmail",
    });
    await expect(check()).resolves.toMatchObject({
      healthy: false,
      notification: "deduplicated",
    });
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();

    permissions = ["all"];
    await check();
    permissions = [];
    await check();
    expect(reddit.modMail.createModNotification).toHaveBeenCalledTimes(2);
  });

  it("falls back to the stored installer when modmail fails", async () => {
    permissions = [];
    await rememberAppInstaller(redis as never, "InstallingMod");
    reddit.modMail.createModNotification.mockRejectedValue(
      new Error("not a moderator"),
    );

    await expect(check()).resolves.toMatchObject({
      healthy: false,
      notification: "installer_dm",
    });
    expect(reddit.sendPrivateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: "InstallingMod" }),
    );
  });

  it("does not duplicate alerts during overlapping health checks", async () => {
    permissions = [];
    let releaseNotification!: () => void;
    let markNotificationStarted!: () => void;
    const notificationStarted = new Promise<void>((resolve) => {
      markNotificationStarted = resolve;
    });
    reddit.modMail.createModNotification.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          markNotificationStarted();
          releaseNotification = () => resolve("conv_1");
        }),
    );

    const first = check();
    await notificationStarted;
    const second = await check();
    releaseNotification();

    await expect(first).resolves.toMatchObject({ notification: "modmail" });
    expect(second).toMatchObject({ notification: "deduplicated" });
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
  });

  it("records lookup failures as unknown without changing incident state or notifying", async () => {
    reddit.getAppUser.mockRejectedValue(new Error("permission denied"));

    await expect(check()).resolves.toMatchObject({
      status: "unknown",
      healthy: false,
      permissions: [],
      notification: "not_needed",
    });
    expect(await redis.hGetAll(appAccountHealthStateKey)).toEqual({});
    expect(await redis.hGetAll(appAccountHealthRetryStateKey)).toMatchObject({
      status: "pending",
      attempts: "1",
      subredditName: "ExampleSub",
    });
    expect(reddit.modMail.createModNotification).not.toHaveBeenCalled();
  });

  it("marks repeated unknown-health failures for continued backoff", async () => {
    reddit.getAppUser.mockRejectedValue(new Error("permission denied"));

    await check();
    await check();
    await check();

    expect(await redis.hGetAll(appAccountHealthRetryStateKey)).toMatchObject({
      status: "exhausted",
      attempts: "3",
      subredditName: "ExampleSub",
    });
  });

  it.each([
    { failure: "unhealthy", restoredPermission: "posts" },
    { failure: "unhealthy", restoredPermission: "all" },
    { failure: "unknown", restoredPermission: "posts" },
    { failure: "unknown", restoredPermission: "all" },
  ])(
    "rechecks exhausted $failure health and restores $restoredPermission without an event",
    async ({ failure, restoredPermission }) => {
      permissions = [];
      if (failure === "unknown")
        reddit.getAppUser.mockRejectedValue(
          new Error("temporary Reddit failure"),
        );
      await check();
      for (let attempt = 2; attempt <= 3; attempt++) {
        const retry = await redis.hGetAll(appAccountHealthRetryStateKey);
        await tick(Number(retry.nextRunAt));
      }
      const exhausted = await redis.hGetAll(appAccountHealthRetryStateKey);
      expect(exhausted).toMatchObject({ status: "exhausted", attempts: "3" });
      permissions = [restoredPermission];
      reddit.getAppUser.mockResolvedValue({
        username: "subscriber-goal",
        getModPermissionsForSubreddit: async () => permissions,
      });
      const calls = reddit.getAppUser.mock.calls.length;
      await expect(
        tick(Number(exhausted.nextRunAt) - 1),
      ).resolves.toMatchObject({ healthy: false, status: failure });
      expect(reddit.getAppUser).toHaveBeenCalledTimes(calls);
      await expect(tick(Number(exhausted.nextRunAt))).resolves.toMatchObject({
        status: "healthy",
        healthy: true,
      });
      expect(reddit.getAppUser).toHaveBeenCalledTimes(calls + 1);
      expect(await redis.hGetAll(appAccountHealthRetryStateKey)).toEqual({});
      expect(
        await redis.hGetAll("app_repair_community_highlights_v3_state"),
      ).toMatchObject({ status: "pending", reason: "permissions_restored" });
      expect(reddit.modMail.createModNotification).toHaveBeenCalledTimes(
        failure === "unhealthy" ? 1 : 0,
      );
    },
  );

  it.each(["unhealthy", "unknown"])(
    "continues %s checks with bounded counters and at most hourly backoff",
    async (failure) => {
      permissions = [];
      if (failure === "unknown")
        reddit.getAppUser.mockRejectedValue(
          new Error("temporary Reddit failure"),
        );
      await check();
      for (let attempt = 2; attempt <= 12; attempt++) {
        const nowMs = Number(
          (await redis.hGetAll(appAccountHealthRetryStateKey)).nextRunAt,
        );
        await tick(nowMs);
        const next = await redis.hGetAll(appAccountHealthRetryStateKey);
        expect(next.attempts).toBe(String(Math.min(7, attempt)));
        expect(Number(next.nextRunAt) - nowMs).toBe(
          Math.min(3_600_000, 60_000 * 2 ** (attempt - 1)),
        );
      }
      expect(reddit.getAppUser).toHaveBeenCalledTimes(12);
      expect(reddit.modMail.createModNotification).toHaveBeenCalledTimes(
        failure === "unhealthy" ? 1 : 0,
      );
    },
  );

  it("indexes a legacy retry at its original time and runs it once across overlapping ticks", async () => {
    const dueAt = 5_000;
    const legacyRetry = {
      status: "exhausted",
      attempts: "5",
      nextRunAt: String(dueAt),
      subredditName: "ExampleSub",
      lastError: "missing_posts_permission",
    };
    await redis.hSet(appAccountHealthRetryStateKey, legacyRetry);
    await redis.zAdd(
      dueJobsKey,
      ...Array.from({ length: 25 }, (_, index) => ({
        member: `other_job_${index}`,
        score: dueAt - 1,
      })),
    );
    await expect(tick(dueAt - 1)).resolves.toMatchObject({ healthy: false });
    expect(await redis.zScore(dueJobsKey, "app_account_health")).toBe(dueAt);
    expect(await redis.hGetAll(appAccountHealthRetryStateKey)).toEqual(
      legacyRetry,
    );

    const permissionLookup = new Gate();
    reddit.getAppUser.mockImplementationOnce(async () => {
      permissionLookup.arrive();
      await permissionLookup.released;
      return {
        username: "subscriber-goal",
        getModPermissionsForSubreddit: async () => ["posts"],
      };
    });
    const first = tick(dueAt);
    try {
      await Promise.race([
        permissionLookup.reached,
        first.then(() => {
          throw new Error("The due health retry did not start");
        }),
      ]);
      await expect(tick(dueAt)).resolves.toMatchObject({ healthy: false });
      expect(reddit.getAppUser).toHaveBeenCalledOnce();
    } finally {
      permissionLookup.release();
      await first;
    }
    await expect(first).resolves.toMatchObject({ healthy: true });
    await expect(tick(dueAt)).resolves.toBeUndefined();
    expect(reddit.getAppUser).toHaveBeenCalledOnce();
    expect(await redis.hGetAll(appAccountHealthRetryStateKey)).toEqual({});
    expect(await redis.hGetAll("app_account_health_job_v1_state")).toEqual({});
    expect(
      await redis.zScore(dueJobsKey, "app_account_health"),
    ).toBeUndefined();
  });

  it("keeps the gate closed when the scheduler budget defers a due retry", async () => {
    await redis.hSet(appAccountHealthRetryStateKey, {
      status: "pending",
      attempts: "1",
      nextRunAt: "1000",
      subredditName: "ExampleSub",
    });
    await expect(tick(1_000, 1_000)).resolves.toMatchObject({
      status: "unknown",
      healthy: false,
    });
    expect(reddit.getAppUser).not.toHaveBeenCalled();
    expect(await redis.hGetAll(appAccountHealthRetryStateKey)).toMatchObject({
      nextRunAt: "1000",
      attempts: "1",
    });
    await expect(tick(1_001)).resolves.toMatchObject({ healthy: true });
  });

  it("backs off and retries after a Redis failure during a scheduled health check", async () => {
    const dueAt = 1_000;
    await redis.hSet(appAccountHealthRetryStateKey, {
      status: "pending",
      attempts: "1",
      nextRunAt: String(dueAt),
      subredditName: "ExampleSub",
    });
    const nextAttemptAt = dueAt + 60_000;
    vi.spyOn(redis, "del").mockRejectedValueOnce(
      new Error("Redis unavailable"),
    );

    await expect(tick(dueAt)).resolves.toMatchObject({ healthy: false });
    expect(await redis.zScore(dueJobsKey, "app_account_health")).toBe(
      nextAttemptAt,
    );
    await expect(tick(nextAttemptAt - 1)).resolves.toMatchObject({
      healthy: false,
    });
    expect(reddit.getAppUser).toHaveBeenCalledOnce();
    await expect(tick(nextAttemptAt)).resolves.toMatchObject({ healthy: true });
    expect(reddit.getAppUser).toHaveBeenCalledTimes(2);
    expect(
      await redis.zScore(dueJobsKey, "app_account_health"),
    ).toBeUndefined();
  });

  it("can fail closed without scheduling a permission retry", async () => {
    reddit.getAppUser.mockRejectedValue(new Error("permission denied"));

    await expect(
      checkAppAccountHealth({
        reddit: reddit as never,
        redis: redis as never,
        subredditName: "ExampleSub",
        subredditId: "t5_example",
        scheduleUnknownRetry: false,
        nowMs: 100,
      }),
    ).resolves.toMatchObject({ status: "unknown", healthy: false });
    await expect(redis.hGetAll(appAccountHealthRetryStateKey)).resolves.toEqual(
      {},
    );
  });
  it.each([undefined, [], ["access"], "error"])(
    "leaves terminal recovery unverified for %j",
    async (result) => {
      await redis.hSet(appAccountRecoveryStateKey, {
        status: "missing",
        incidentToken: "old",
      });
      if (result === "error")
        reddit.getAppUser.mockRejectedValueOnce(new Error("inaccessible"));
      else if (result === undefined)
        reddit.getAppUser.mockResolvedValueOnce(undefined);
      else permissions = result as string[];
      expect((await check()).healthy).toBe(false);
      expect(await redis.hGetAll(appAccountRecoveryStateKey)).toMatchObject({
        status: "missing",
        incidentToken: "old",
      });
    },
  );

  it("rejects a new incident arriving between the comparison and transaction commit", async () => {
    await redis.hSet(appAccountRecoveryStateKey, {
      status: "missing",
      incidentToken: "old",
    });
    redis.beforeExec = async () => {
      await redis.hSet(appAccountRecoveryStateKey, {
        status: "pending",
        incidentToken: "new",
      });
    };
    await expect(check()).resolves.toMatchObject({
      status: "unknown",
      healthy: false,
    });
    expect(await redis.hGetAll(appAccountRecoveryStateKey)).toMatchObject({
      status: "pending",
      incidentToken: "new",
    });
    expect(
      await redis.hGetAll("app_repair_community_highlights_v3_state"),
    ).toEqual({});
  });

  it("does not clear active recovery on a healthy permission event", async () => {
    await redis.hSet(appAccountRecoveryStateKey, {
      status: "pending",
      incidentToken: "active",
    });
    await check();
    expect(await redis.hGetAll(appAccountRecoveryStateKey)).toMatchObject({
      status: "pending",
      incidentToken: "active",
    });
  });
});
