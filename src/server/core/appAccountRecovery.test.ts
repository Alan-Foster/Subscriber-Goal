import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  checkAppAccountHealth: vi.fn(),
}));

vi.mock("./appAccountHealth", () => ({
  appAccountHealthRetryStateKey: "app_account_health_v1_retry_state",
  checkAppAccountHealth: hoisted.checkAppAccountHealth,
  subscriberGoalAppUsername: "subscriber-goal",
}));

import { ModeratorInviteRejectedError } from "../utils/moderatorInviteApi";
import {
  appAccountInstallationStateKey,
  appAccountRecoveryDelayMs,
  appAccountRecoveryJobName,
  appAccountRecoveryLockKey,
  appAccountRecoveryStateKey,
  handleAppAccountModeratorAction,
  processAppAccountRecovery,
  recordLifecycleAndScheduleRecovery,
  scheduleAppAccountRecovery,
} from "./appAccountRecovery";

class TestRedis {
  values = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();

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

describe("app account recovery", () => {
  let redis: TestRedis;
  let permissions: string[];
  let moderatorResponses: Array<unknown[] | Error>;
  let reddit: {
    getAppUser: ReturnType<typeof vi.fn>;
    getModerators: ReturnType<typeof vi.fn>;
    sendPrivateMessage: ReturnType<typeof vi.fn>;
  };
  let scheduler: { runJob: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetAllMocks();
    redis = new TestRedis();
    permissions = ["posts"];
    moderatorResponses = [];
    reddit = {
      getAppUser: vi.fn().mockImplementation(async () => ({
        username: "subscriber-goal",
        getModPermissionsForSubreddit: vi.fn(async () => permissions),
      })),
      getModerators: vi.fn().mockImplementation(() => ({
        get: vi.fn(async () => {
          const response = moderatorResponses.shift() ?? [];
          if (response instanceof Error) throw response;
          return response;
        }),
      })),
      sendPrivateMessage: vi.fn().mockResolvedValue(undefined),
    };
    scheduler = {
      runJob: vi
        .fn()
        .mockImplementation(
          async () => `job-${scheduler.runJob.mock.calls.length}`,
        ),
    };
    hoisted.checkAppAccountHealth.mockResolvedValue({
      status: "healthy",
      healthy: true,
      permissions: ["posts"],
    });
  });

  const moderator = () => ({ username: "subscriber-goal" });

  it("records install time, preserves it on upgrade, and deduplicates scheduling", async () => {
    const installToken = await recordLifecycleAndScheduleRecovery({
      redis: redis as never,
      scheduler,
      lifecycleSource: "install",
      subredditName: "ExampleSub",
      installerUsername: "u/InstallingMod",
      nowMs: 1_000,
    });
    const duplicateToken = await recordLifecycleAndScheduleRecovery({
      redis: redis as never,
      scheduler,
      lifecycleSource: "install",
      subredditName: "ExampleSub",
      installerUsername: "InstallingMod",
      nowMs: 1_001,
    });
    expect(duplicateToken).toBe(installToken);
    expect(scheduler.runJob).toHaveBeenCalledOnce();
    expect(scheduler.runJob).toHaveBeenCalledWith({
      name: appAccountRecoveryJobName,
      runAt: new Date(1_000 + appAccountRecoveryDelayMs),
      data: { incidentToken: installToken },
    });

    await recordLifecycleAndScheduleRecovery({
      redis: redis as never,
      scheduler,
      lifecycleSource: "upgrade",
      subredditName: "ExampleSub",
      nowMs: 10_000,
    });
    expect(await redis.hGetAll(appAccountInstallationStateKey)).toMatchObject({
      installedAt: "1000",
      latestLifecycleAt: "10000",
      latestLifecycleSource: "upgrade",
      installerUsername: "InstallingMod",
    });
  });

  it("resets install time and creates a new incident for a genuine reinstall", async () => {
    const firstToken = await recordLifecycleAndScheduleRecovery({
      redis: redis as never,
      scheduler,
      lifecycleSource: "install",
      subredditName: "ExampleSub",
      nowMs: 1_000,
    });
    await redis.hSet(appAccountRecoveryStateKey, { status: "healthy" });

    const reinstallToken = await recordLifecycleAndScheduleRecovery({
      redis: redis as never,
      scheduler,
      lifecycleSource: "install",
      subredditName: "ExampleSub",
      nowMs: 600_000,
    });

    expect(reinstallToken).not.toBe(firstToken);
    expect(scheduler.runJob).toHaveBeenCalledTimes(2);
    expect(scheduler.runJob).toHaveBeenLastCalledWith({
      name: appAccountRecoveryJobName,
      runAt: new Date(600_000 + appAccountRecoveryDelayMs),
      data: { incidentToken: reinstallToken },
    });
    expect(await redis.hGetAll(appAccountInstallationStateKey)).toMatchObject({
      installedAt: "600000",
      latestLifecycleAt: "600000",
      latestLifecycleSource: "install",
    });
  });

  it("does not let an upgrade replace a pending removal incident", async () => {
    const removalToken = await scheduleAppAccountRecovery({
      redis: redis as never,
      scheduler,
      reason: "removal",
      subredditName: "ExampleSub",
      removedBy: "RemovingMod",
      nowMs: 100_000,
    });

    const upgradeToken = await recordLifecycleAndScheduleRecovery({
      redis: redis as never,
      scheduler,
      lifecycleSource: "upgrade",
      subredditName: "ExampleSub",
      installerUsername: "UpgradingMod",
      nowMs: 101_000,
    });

    expect(upgradeToken).toBe(removalToken);
    expect(scheduler.runJob).toHaveBeenCalledOnce();
    expect(await redis.hGetAll(appAccountRecoveryStateKey)).toMatchObject({
      incidentToken: removalToken,
      status: "pending",
      reason: "removal",
      removedBy: "RemovingMod",
      dueAt: "160000",
    });
    expect(await redis.hGetAll(appAccountInstallationStateKey)).toMatchObject({
      latestLifecycleAt: "101000",
      latestLifecycleSource: "upgrade",
      installerUsername: "UpgradingMod",
    });
  });

  it("records an already healthy moderator without accepting an invitation", async () => {
    moderatorResponses = [[moderator()]];
    const acceptInvite = vi.fn();
    const token = await scheduleAppAccountRecovery({
      redis: redis as never,
      scheduler,
      reason: "upgrade",
      subredditName: "ExampleSub",
      nowMs: 0,
      dueAtMs: 0,
    });

    await expect(
      processAppAccountRecovery({
        reddit: reddit as never,
        redis: redis as never,
        scheduler,
        incidentToken: token,
        nowMs: 0,
        acceptInvite,
      }),
    ).resolves.toMatchObject({ status: "healthy" });
    expect(acceptInvite).not.toHaveBeenCalled();
    expect(await redis.hGetAll(appAccountRecoveryStateKey)).toMatchObject({
      status: "healthy",
      permissions: "posts",
    });
  });

  it("ignores stale and overlapping scheduler jobs", async () => {
    moderatorResponses = [[moderator()]];
    const token = await scheduleAppAccountRecovery({
      redis: redis as never,
      scheduler,
      reason: "upgrade",
      subredditName: "ExampleSub",
      nowMs: 0,
      dueAtMs: 0,
    });

    await expect(
      processAppAccountRecovery({
        reddit: reddit as never,
        redis: redis as never,
        scheduler,
        incidentToken: "obsolete-token",
        nowMs: 0,
      }),
    ).resolves.toMatchObject({ status: "stale" });
    await redis.set(appAccountRecoveryLockKey, "another-worker");
    await expect(
      processAppAccountRecovery({
        reddit: reddit as never,
        redis: redis as never,
        scheduler,
        incidentToken: token,
        nowMs: 0,
      }),
    ).resolves.toMatchObject({ status: "locked" });
    expect(reddit.getModerators).not.toHaveBeenCalled();
  });

  it("accepts a valid invitation and verifies membership and permissions", async () => {
    moderatorResponses = [[], [moderator()]];
    const acceptInvite = vi.fn().mockResolvedValue(undefined);
    const token = await scheduleAppAccountRecovery({
      redis: redis as never,
      scheduler,
      reason: "reinvite",
      subredditName: "ExampleSub",
      nowMs: 0,
      dueAtMs: 0,
    });

    await expect(
      processAppAccountRecovery({
        reddit: reddit as never,
        redis: redis as never,
        scheduler,
        incidentToken: token,
        nowMs: 0,
        acceptInvite,
      }),
    ).resolves.toMatchObject({ status: "healthy" });
    expect(acceptInvite).toHaveBeenCalledWith("ExampleSub");
    expect(reddit.getModerators).toHaveBeenCalledTimes(2);
  });

  it("accepts a private invitation and retries only propagation verification", async () => {
    moderatorResponses = [
      new Error("7 PERMISSION_DENIED: 403 Forbidden: private"),
      new Error("7 PERMISSION_DENIED: 403 Forbidden: private"),
      [moderator()],
    ];
    const acceptInvite = vi.fn().mockResolvedValue(undefined);
    const token = await scheduleAppAccountRecovery({
      redis: redis as never,
      scheduler,
      reason: "removal",
      subredditName: "PrivateSub",
      nowMs: 0,
      dueAtMs: 0,
    });

    await expect(
      processAppAccountRecovery({
        reddit: reddit as never,
        redis: redis as never,
        scheduler,
        incidentToken: token,
        nowMs: 0,
        acceptInvite,
      }),
    ).resolves.toMatchObject({ status: "pending" });
    await expect(
      processAppAccountRecovery({
        reddit: reddit as never,
        redis: redis as never,
        scheduler,
        incidentToken: token,
        nowMs: appAccountRecoveryDelayMs,
        acceptInvite,
      }),
    ).resolves.toMatchObject({ status: "healthy" });
    expect(acceptInvite).toHaveBeenCalledWith("PrivateSub");
    expect(acceptInvite).toHaveBeenCalledOnce();
    expect(reddit.getModerators).toHaveBeenCalledTimes(3);
  });

  it("records a private subreddit with no valid invitation as terminally missing", async () => {
    moderatorResponses = [
      new Error("7 PERMISSION_DENIED: 403 Forbidden: private"),
    ];
    const acceptInvite = vi
      .fn()
      .mockRejectedValue(new ModeratorInviteRejectedError(["NO_INVITE"]));
    const token = await scheduleAppAccountRecovery({
      redis: redis as never,
      scheduler,
      reason: "removal",
      subredditName: "PrivateSub",
      nowMs: 0,
      dueAtMs: 0,
    });

    await expect(
      processAppAccountRecovery({
        reddit: reddit as never,
        redis: redis as never,
        scheduler,
        incidentToken: token,
        nowMs: 0,
        acceptInvite,
      }),
    ).resolves.toMatchObject({ status: "missing" });
    expect(scheduler.runJob).toHaveBeenCalledOnce();
    expect(await redis.hGetAll(appAccountRecoveryStateKey)).toMatchObject({
      status: "missing",
      lastError: "NO_INVITE",
    });
  });

  it("does not claim success until accepted membership can be verified", async () => {
    moderatorResponses = [[], []];
    const acceptInvite = vi.fn().mockResolvedValue(undefined);
    const token = await scheduleAppAccountRecovery({
      redis: redis as never,
      scheduler,
      reason: "reinvite",
      subredditName: "ExampleSub",
      nowMs: 0,
      dueAtMs: 0,
    });

    await expect(
      processAppAccountRecovery({
        reddit: reddit as never,
        redis: redis as never,
        scheduler,
        incidentToken: token,
        nowMs: 0,
        acceptInvite,
      }),
    ).resolves.toMatchObject({ status: "pending" });
    expect(await redis.hGetAll(appAccountRecoveryStateKey)).toMatchObject({
      status: "pending",
      attempts: "1",
      dueAt: "60000",
    });
  });

  it("records a structured rejection as missing without retrying", async () => {
    moderatorResponses = [[]];
    const acceptInvite = vi
      .fn()
      .mockRejectedValue(new ModeratorInviteRejectedError(["NO_INVITE"]));
    const token = await scheduleAppAccountRecovery({
      redis: redis as never,
      scheduler,
      reason: "removal",
      subredditName: "ExampleSub",
      nowMs: 0,
      dueAtMs: 0,
    });

    await expect(
      processAppAccountRecovery({
        reddit: reddit as never,
        redis: redis as never,
        scheduler,
        incidentToken: token,
        nowMs: 0,
        acceptInvite,
      }),
    ).resolves.toMatchObject({ status: "missing" });
    expect(scheduler.runJob).toHaveBeenCalledTimes(1);
    expect(await redis.hGetAll(appAccountRecoveryStateKey)).toMatchObject({
      status: "missing",
      lastError: "NO_INVITE",
    });
  });

  it("suppresses the general fallback after delivering the removal PM", async () => {
    moderatorResponses = [[]];
    const acceptInvite = vi
      .fn()
      .mockRejectedValue(new ModeratorInviteRejectedError(["NO_INVITE"]));
    const token = await scheduleAppAccountRecovery({
      redis: redis as never,
      scheduler,
      reason: "removal",
      subredditName: "ExampleSub",
      removedBy: "RemovingMod",
      nowMs: 0,
      dueAtMs: 0,
    });

    await processAppAccountRecovery({
      reddit: reddit as never,
      redis: redis as never,
      scheduler,
      incidentToken: token,
      nowMs: 0,
      acceptInvite,
    });

    expect(reddit.sendPrivateMessage).toHaveBeenCalledOnce();
    expect(hoisted.checkAppAccountHealth).toHaveBeenCalledWith(
      expect.objectContaining({ notify: false }),
    );
  });

  it("retains general recovery guidance when the removal PM fails", async () => {
    moderatorResponses = [[]];
    reddit.sendPrivateMessage.mockRejectedValue(new Error("PM unavailable"));
    const acceptInvite = vi
      .fn()
      .mockRejectedValue(new ModeratorInviteRejectedError(["NO_INVITE"]));
    const token = await scheduleAppAccountRecovery({
      redis: redis as never,
      scheduler,
      reason: "removal",
      subredditName: "ExampleSub",
      removedBy: "RemovingMod",
      nowMs: 0,
      dueAtMs: 0,
    });

    await processAppAccountRecovery({
      reddit: reddit as never,
      redis: redis as never,
      scheduler,
      incidentToken: token,
      nowMs: 0,
      acceptInvite,
    });

    expect(hoisted.checkAppAccountHealth).toHaveBeenCalledWith(
      expect.objectContaining({ notify: true }),
    );
  });

  it("deduplicates a removal event even after its incident is terminal", async () => {
    moderatorResponses = [[]];
    const acceptInvite = vi
      .fn()
      .mockRejectedValue(new ModeratorInviteRejectedError(["NO_INVITE"]));
    const event = {
      reddit: reddit as never,
      redis: redis as never,
      scheduler,
      action: "removemoderator",
      actionedAt: "2026-11-01T12:00:00.000Z",
      moderatorName: "RemovingMod",
      subredditName: "ExampleSub",
      nowMs: 0,
      acceptInvite,
    };
    const scheduled = await handleAppAccountModeratorAction(event);
    await processAppAccountRecovery({
      reddit: reddit as never,
      redis: redis as never,
      scheduler,
      incidentToken: scheduled!.incidentToken!,
      nowMs: 60_000,
      acceptInvite,
    });

    await expect(
      handleAppAccountModeratorAction({ ...event, nowMs: 60_001 }),
    ).resolves.toMatchObject({
      status: "missing",
      incidentToken: scheduled!.incidentToken,
    });
    expect(scheduler.runJob).toHaveBeenCalledOnce();
    expect(reddit.sendPrivateMessage).toHaveBeenCalledOnce();
  });

  it("retries a transport failure once, then records acceptance failure", async () => {
    moderatorResponses = [[], []];
    const acceptInvite = vi.fn().mockRejectedValue(new Error("gateway down"));
    const token = await scheduleAppAccountRecovery({
      redis: redis as never,
      scheduler,
      reason: "removal",
      subredditName: "ExampleSub",
      nowMs: 0,
      dueAtMs: 0,
    });

    await processAppAccountRecovery({
      reddit: reddit as never,
      redis: redis as never,
      scheduler,
      incidentToken: token,
      nowMs: 0,
      acceptInvite,
    });
    await expect(
      processAppAccountRecovery({
        reddit: reddit as never,
        redis: redis as never,
        scheduler,
        incidentToken: token,
        nowMs: 60_000,
        acceptInvite,
      }),
    ).resolves.toMatchObject({ status: "acceptance_failed" });
    expect(acceptInvite).toHaveBeenCalledTimes(2);
    expect(scheduler.runJob).toHaveBeenCalledTimes(2);
  });

  it("records insufficient permissions without trying invitation acceptance", async () => {
    permissions = ["flair"];
    moderatorResponses = [[moderator()]];
    const acceptInvite = vi.fn();
    const token = await scheduleAppAccountRecovery({
      redis: redis as never,
      scheduler,
      reason: "upgrade",
      subredditName: "ExampleSub",
      nowMs: 0,
      dueAtMs: 0,
    });

    await expect(
      processAppAccountRecovery({
        reddit: reddit as never,
        redis: redis as never,
        scheduler,
        incidentToken: token,
        nowMs: 0,
        acceptInvite,
      }),
    ).resolves.toMatchObject({ status: "insufficient_permissions" });
    expect(acceptInvite).not.toHaveBeenCalled();
  });

  it("delays and deduplicates the exact removal notification", async () => {
    moderatorResponses = [[moderator()]];
    const token = await scheduleAppAccountRecovery({
      redis: redis as never,
      scheduler,
      reason: "removal",
      subredditName: "ExampleSub",
      removedBy: "RemovingMod",
      nowMs: 0,
      dueAtMs: 60_000,
    });
    await expect(
      processAppAccountRecovery({
        reddit: reddit as never,
        redis: redis as never,
        scheduler,
        incidentToken: token,
        nowMs: 59_999,
      }),
    ).resolves.toMatchObject({ status: "not_due" });
    expect(reddit.sendPrivateMessage).not.toHaveBeenCalled();

    await processAppAccountRecovery({
      reddit: reddit as never,
      redis: redis as never,
      scheduler,
      incidentToken: token,
      nowMs: 60_000,
    });
    await processAppAccountRecovery({
      reddit: reddit as never,
      redis: redis as never,
      scheduler,
      incidentToken: token,
      nowMs: 60_001,
    });
    expect(reddit.sendPrivateMessage).toHaveBeenCalledOnce();
    expect(reddit.sendPrivateMessage).toHaveBeenCalledWith({
      to: "RemovingMod",
      subject: "Subscriber Goal Moderator Account Removed",
      text:
        "Hi u/RemovingMod,\n\n" +
        "You removed u/subscriber-goal from the moderator team of r/ExampleSub.\n\n" +
        "Subscriber Goal requires its app account to have moderator permissions to work correctly.\n\n" +
        "If you want to remove Subscriber Goal, please uninstall it from your community's App Installation Page:\n\n" +
        "[https://developers.reddit.com/r/ExampleSub/apps/subscriber-goal](https://developers.reddit.com/r/ExampleSub/apps/subscriber-goal)\n\n" +
        "If you removed the account by accident, please invite u/subscriber-goal back to the moderator team with the required permissions. Subscriber Goal will automatically accept the invitation.\n\n" +
        "This is an automated message.",
    });
  });

  it("does not guess a recipient when the removing moderator is masked", async () => {
    moderatorResponses = [[moderator()]];
    const token = await scheduleAppAccountRecovery({
      redis: redis as never,
      scheduler,
      reason: "removal",
      subredditName: "ExampleSub",
      nowMs: 0,
      dueAtMs: 0,
    });
    await processAppAccountRecovery({
      reddit: reddit as never,
      redis: redis as never,
      scheduler,
      incidentToken: token,
      nowMs: 0,
    });
    expect(reddit.sendPrivateMessage).not.toHaveBeenCalled();
  });

  it("does not accept reinvitations during the initial setup window", async () => {
    await redis.hSet(appAccountInstallationStateKey, { installedAt: "1000" });
    const acceptInvite = vi.fn();
    await expect(
      handleAppAccountModeratorAction({
        reddit: reddit as never,
        redis: redis as never,
        scheduler,
        action: "invitemoderator",
        subredditName: "ExampleSub",
        nowMs: 60_999,
        acceptInvite,
      }),
    ).resolves.toMatchObject({ status: "not_due" });
    expect(acceptInvite).not.toHaveBeenCalled();
    expect(scheduler.runJob).not.toHaveBeenCalled();
  });

  it("accepts a subsequent reinvitation after the setup window", async () => {
    await redis.hSet(appAccountInstallationStateKey, { installedAt: "1000" });
    moderatorResponses = [[], [moderator()]];
    const acceptInvite = vi.fn().mockResolvedValue(undefined);
    await expect(
      handleAppAccountModeratorAction({
        reddit: reddit as never,
        redis: redis as never,
        scheduler,
        action: "invitemoderator",
        subredditName: "ExampleSub",
        nowMs: 61_000,
        acceptInvite,
      }),
    ).resolves.toMatchObject({ status: "healthy" });
    expect(acceptInvite).toHaveBeenCalledOnce();
  });

  it("deduplicates redelivered reinvitation events", async () => {
    await redis.hSet(appAccountInstallationStateKey, { installedAt: "1" });
    moderatorResponses = [[], [moderator()]];
    const acceptInvite = vi.fn().mockResolvedValue(undefined);
    const event = {
      reddit: reddit as never,
      redis: redis as never,
      scheduler,
      action: "invitemoderator",
      actionedAt: "2026-11-01T12:01:00.000Z",
      subredditName: "ExampleSub",
      nowMs: 61_000,
      acceptInvite,
    };

    await handleAppAccountModeratorAction(event);
    await handleAppAccountModeratorAction({ ...event, nowMs: 61_001 });

    expect(acceptInvite).toHaveBeenCalledOnce();
    expect(scheduler.runJob).toHaveBeenCalledOnce();
  });

  it("accepts a reinvitation without replacing the delayed removal incident", async () => {
    await redis.hSet(appAccountInstallationStateKey, { installedAt: "1" });
    moderatorResponses = [[], [moderator()], [moderator()]];
    const acceptInvite = vi.fn().mockResolvedValue(undefined);
    const removalToken = await scheduleAppAccountRecovery({
      redis: redis as never,
      scheduler,
      reason: "removal",
      subredditName: "ExampleSub",
      removedBy: "RemovingMod",
      nowMs: 60_000,
      dueAtMs: 120_000,
    });

    await expect(
      handleAppAccountModeratorAction({
        reddit: reddit as never,
        redis: redis as never,
        scheduler,
        action: "invitemoderator",
        subredditName: "ExampleSub",
        nowMs: 61_000,
        acceptInvite,
      }),
    ).resolves.toMatchObject({
      status: "healthy",
      incidentToken: removalToken,
    });
    expect(reddit.sendPrivateMessage).not.toHaveBeenCalled();
    expect(await redis.hGetAll(appAccountRecoveryStateKey)).toMatchObject({
      status: "pending",
      reason: "removal",
      incidentToken: removalToken,
      recoveredAt: "61000",
    });

    await processAppAccountRecovery({
      reddit: reddit as never,
      redis: redis as never,
      scheduler,
      incidentToken: removalToken,
      nowMs: 120_000,
      acceptInvite,
    });
    expect(reddit.sendPrivateMessage).toHaveBeenCalledOnce();
    expect(acceptInvite).toHaveBeenCalledOnce();
  });
});
