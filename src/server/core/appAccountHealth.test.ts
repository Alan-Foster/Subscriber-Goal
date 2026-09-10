import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appAccountHealthStateKey,
  appAccountInstallerKey,
  checkAppAccountHealth,
  rememberAppInstaller,
} from "./appAccountHealth";

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
    getAppUser: ReturnType<typeof vi.fn>;
    modMail: { createModNotification: ReturnType<typeof vi.fn> };
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
      modMail: { createModNotification: vi.fn().mockResolvedValue("conv_1") },
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

  it("stores a normalized installer username", async () => {
    await rememberAppInstaller(redis as never, "u/InstallingMod");
    expect(await redis.get(appAccountInstallerKey)).toBe("InstallingMod");
  });

  it("accepts Posts without requiring Flair and records healthy state", async () => {
    await expect(check()).resolves.toMatchObject({
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

  it("records lookup failures as unhealthy without throwing", async () => {
    reddit.getAppUser.mockRejectedValue(new Error("permission denied"));

    await expect(check()).resolves.toMatchObject({
      healthy: false,
      permissions: [],
    });
  });
});
