import { describe, expect, it, vi } from "vitest";
import type { MilestoneNotificationJob } from "../../shared/types/api";
import {
  MILESTONE_NOTIFICATION_DELIVERY_ENABLED,
  isMilestoneNotificationJob,
  maybeScheduleMilestoneNotification,
  milestoneNotificationBatchDelayMs,
  milestoneNotificationBatchSize,
  milestoneNotificationBody,
  milestoneNotificationClaimMs,
  milestoneNotificationDeadline,
  milestoneNotificationJobName,
  milestoneNotificationPageKey,
  milestoneNotificationTitle,
  processMilestoneNotificationBatch,
  recoverMilestoneNotificationContinuations,
  renderMilestoneNotificationCopy,
} from "./milestoneNotifications";

const job: MilestoneNotificationJob = {
  campaign: "milestone-completed",
  postId: "t3_goal",
  completedTime: 1_789_000_000_000,
  cursor: "",
  attemptedRecipients: 0,
};

const campaign = {
  postId: "t3_goal" as const,
  completedTime: job.completedTime,
  subredditName: "ExampleSub",
  goal: 10_000,
};

class StateRedisHarness {
  private readonly values = new Map<string, string>();
  private readonly versions = new Map<string, number>();
  private readonly sorted = new Map<string, Map<string, number>>();

  get = vi.fn(async (key: string) => this.values.get(key));
  set = vi.fn(async (key: string, value: string) => {
    this.values.set(key, value);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    return "OK";
  });
  zAdd = vi.fn(
    async (key: string, member: { member: string; score: number }) => {
      const set = this.sorted.get(key) ?? new Map<string, number>();
      set.set(member.member, member.score);
      this.sorted.set(key, set);
      return 1;
    },
  );
  zRem = vi.fn(async (key: string, members: string[]) => {
    const set = this.sorted.get(key);
    return members.reduce(
      (count, member) => count + (set?.delete(member) ? 1 : 0),
      0,
    );
  });
  zRange = vi.fn(async (key: string, start: number, stop: number) =>
    [...(this.sorted.get(key) ?? [])]
      .filter(([, score]) => score >= start && score <= stop)
      .sort((a, b) => a[1] - b[1])
      .map(([member, score]) => ({ member, score })),
  );
  watch = vi.fn(async (...keys: string[]) => {
    const watched = new Map(
      keys.map((key) => [key, this.versions.get(key) ?? 0]),
    );
    const commands: (() => Promise<unknown>)[] = [];
    return {
      discard: vi.fn(async () => undefined),
      multi: vi.fn(async () => undefined),
      set: vi.fn(async (key: string, value: string) => {
        commands.push(() => this.set(key, value));
        return undefined;
      }),
      zAdd: vi.fn(
        async (key: string, member: { member: string; score: number }) => {
          commands.push(() => this.zAdd(key, member));
          return undefined;
        },
      ),
      zRem: vi.fn(async (key: string, members: string[]) => {
        commands.push(() => this.zRem(key, members));
        return undefined;
      }),
      exec: vi.fn(async () => {
        if (
          [...watched].some(
            ([key, version]) => (this.versions.get(key) ?? 0) !== version,
          )
        )
          return [];
        const results = [];
        for (const command of commands) results.push(await command());
        return results;
      }),
    };
  });
}

describe("milestone notifications", () => {
  it("keeps production delivery disabled", () => {
    expect(MILESTONE_NOTIFICATION_DELIVERY_ENABLED).toBe(false);
  });

  it("validates scheduler payloads", () => {
    expect(isMilestoneNotificationJob(job)).toBe(true);
    expect(isMilestoneNotificationJob({ ...job, postId: "bad" })).toBe(false);
    expect(isMilestoneNotificationJob({ ...job, completedTime: 0 })).toBe(
      false,
    );
    expect(
      isMilestoneNotificationJob({ ...job, attemptedRecipients: -1 }),
    ).toBe(false);
    expect(
      isMilestoneNotificationJob({
        ...job,
        attemptedRecipients: 25_001,
      }),
    ).toBe(false);
  });

  it("renders provisional copy within Reddit limits", () => {
    const copy = renderMilestoneNotificationCopy(campaign);
    expect(copy.title).toBe(milestoneNotificationTitle);
    expect(copy.body).toContain("r/ExampleSub reached 10k subscribers");
    expect(copy.title.length).toBeLessThanOrEqual(60);
    expect(copy.body.length).toBeLessThanOrEqual(100);
  });

  it("does not schedule when the production gate is disabled", async () => {
    const runJob = vi.fn();
    await expect(
      maybeScheduleMilestoneNotification(
        { postId: job.postId, completedTime: job.completedTime },
        { schedulerClient: { runJob } as never },
      ),
    ).resolves.toBe("suppressed");
    expect(runJob).not.toHaveBeenCalled();
  });

  it("suppresses delivery before listing recipients", async () => {
    const listOptedInUsers = vi.fn();
    const enqueue = vi.fn();
    const runJob = vi.fn();
    const incrBy = vi.fn();
    const expire = vi.fn();
    const result = await processMilestoneNotificationBatch(job, campaign, {
      notificationClient: { listOptedInUsers, enqueue } as never,
      schedulerClient: { runJob } as never,
      dailyBudgetClient: { incrBy, expire } as never,
    });
    expect(result).toEqual({ status: "suppressed", done: true, cursor: "" });
    expect(listOptedInUsers).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(runJob).not.toHaveBeenCalled();
    expect(incrBy).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
  });

  it("builds a bounded batch and schedules the next cursor when enabled", async () => {
    const listOptedInUsers = vi.fn().mockResolvedValue({
      userIds: ["t2_alice", "invalid", "t2_bob"],
      next: "next-cursor",
    });
    const enqueue = vi.fn().mockResolvedValue({
      successCount: 1,
      failureCount: 1,
      errors: [{ userId: "t2_bob", message: "failed" }],
    });
    const runJob = vi.fn().mockResolvedValue("job-id");
    const incrBy = vi.fn().mockResolvedValue(2);
    const expire = vi.fn().mockResolvedValue(undefined);
    const now = job.completedTime + 1_000;

    const result = await processMilestoneNotificationBatch(job, campaign, {
      deliveryEnabled: true,
      notificationClient: { listOptedInUsers, enqueue } as never,
      schedulerClient: { runJob } as never,
      dailyBudgetClient: { incrBy, expire } as never,
      stateClient: new StateRedisHarness() as never,
      now: () => now,
    });

    expect(listOptedInUsers).toHaveBeenCalledWith({
      limit: milestoneNotificationBatchSize,
    });
    expect(enqueue).toHaveBeenCalledWith({
      title: milestoneNotificationTitle,
      body: "r/ExampleSub reached 10k subscribers. Open the goal post to celebrate.",
      recipients: [
        {
          userId: "t2_alice",
          link: "t3_goal",
          data: { subredditName: "ExampleSub", goalText: "10k" },
        },
        {
          userId: "t2_bob",
          link: "t3_goal",
          data: { subredditName: "ExampleSub", goalText: "10k" },
        },
      ],
    });
    expect(runJob).toHaveBeenCalledWith({
      name: milestoneNotificationJobName,
      data: { ...job, cursor: "next-cursor", attemptedRecipients: 2 },
      runAt: new Date(now + milestoneNotificationBatchDelayMs),
    });
    expect(result).toMatchObject({
      status: "processed",
      done: false,
      recipients: 2,
      successCount: 1,
      failureCount: 1,
    });
  });

  it("shares the 25K daily budget across concurrent campaigns", async () => {
    let reserved = 24_950;
    const dailyBudgetClient = {
      incrBy: vi.fn(async (_key: string, value: number) => {
        reserved += value;
        return reserved;
      }),
      expire: vi.fn().mockResolvedValue(undefined),
    };
    const userIds = Array.from(
      { length: 200 },
      (_, index) => `t2_user${index}`,
    );
    const makeClient = () => ({
      listOptedInUsers: vi.fn().mockResolvedValue({
        userIds,
        next: "next-cursor",
      }),
      enqueue: vi.fn().mockImplementation(async ({ recipients }) => ({
        successCount: recipients.length,
        failureCount: 0,
        errors: [],
      })),
    });
    const firstClient = makeClient();
    const secondClient = makeClient();

    const results = await Promise.all([
      processMilestoneNotificationBatch(job, campaign, {
        deliveryEnabled: true,
        notificationClient: firstClient as never,
        schedulerClient: { runJob: vi.fn() } as never,
        dailyBudgetClient: dailyBudgetClient as never,
        stateClient: new StateRedisHarness() as never,
        now: () => job.completedTime + 1_000,
      }),
      processMilestoneNotificationBatch(
        { ...job, postId: "t3_other" },
        { ...campaign, postId: "t3_other" },
        {
          deliveryEnabled: true,
          notificationClient: secondClient as never,
          schedulerClient: { runJob: vi.fn() } as never,
          dailyBudgetClient: dailyBudgetClient as never,
          stateClient: new StateRedisHarness() as never,
          now: () => job.completedTime + 1_000,
        },
      ),
    ]);

    expect(
      results.reduce(
        (sum, result) =>
          sum + (result.status === "processed" ? result.recipients : 0),
        0,
      ),
    ).toBe(50);
    expect(firstClient.enqueue.mock.calls[0]?.[0].recipients).toHaveLength(50);
    expect(secondClient.enqueue).not.toHaveBeenCalled();
  });

  it("does not enqueue or continue for an empty final page", async () => {
    const enqueue = vi.fn();
    const runJob = vi.fn();
    const result = await processMilestoneNotificationBatch(
      { ...job, cursor: "cursor" },
      campaign,
      {
        deliveryEnabled: true,
        notificationClient: {
          listOptedInUsers: vi
            .fn()
            .mockResolvedValue({ userIds: [], next: undefined }),
          enqueue,
        } as never,
        schedulerClient: { runJob } as never,
        stateClient: new StateRedisHarness() as never,
        now: () => job.completedTime + 1_000,
      },
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(runJob).not.toHaveBeenCalled();
    expect(result).toMatchObject({ done: true, recipients: 0 });
  });

  it("converges sequential and concurrent replays on one debit and send", async () => {
    const stateClient = new StateRedisHarness();
    const dailyBudgetClient = {
      incrBy: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(undefined),
    };
    const notificationClient = {
      listOptedInUsers: vi.fn().mockResolvedValue({ userIds: ["t2_alice"] }),
      enqueue: vi.fn().mockResolvedValue({ successCount: 1, failureCount: 0 }),
    };
    const options = {
      deliveryEnabled: true,
      stateClient: stateClient as never,
      dailyBudgetClient: dailyBudgetClient as never,
      notificationClient: notificationClient as never,
      schedulerClient: { runJob: vi.fn() } as never,
      now: () => job.completedTime + 1_000,
    };

    const [first, replay] = await Promise.all([
      processMilestoneNotificationBatch(job, campaign, options),
      processMilestoneNotificationBatch(job, campaign, options),
    ]);
    const sequential = await processMilestoneNotificationBatch(
      job,
      campaign,
      options,
    );

    expect([first.status, replay.status]).toContain("processed");
    expect(sequential.status).toBe("duplicate");
    expect(dailyBudgetClient.incrBy).toHaveBeenCalledOnce();
    expect(notificationClient.enqueue).toHaveBeenCalledOnce();
  });

  it("fences a stale owner before debit and after the send boundary", async () => {
    const stateClient = new StateRedisHarness();
    let now = job.completedTime + 1_000;
    let releaseList!: (value: { userIds: string[] }) => void;
    const pausedList = new Promise<{ userIds: string[] }>((resolve) => {
      releaseList = resolve;
    });
    const dailyBudgetClient = {
      incrBy: vi.fn().mockResolvedValue(1),
      expire: vi.fn(),
    };
    const enqueue = vi
      .fn()
      .mockResolvedValue({ successCount: 1, failureCount: 0 });
    const first = processMilestoneNotificationBatch(job, campaign, {
      deliveryEnabled: true,
      stateClient: stateClient as never,
      dailyBudgetClient: dailyBudgetClient as never,
      notificationClient: {
        listOptedInUsers: vi.fn(() => pausedList),
        enqueue,
      } as never,
      now: () => now,
    });
    await vi.waitFor(() => expect(stateClient.get).toHaveBeenCalled());
    now += milestoneNotificationClaimMs + 1;
    await processMilestoneNotificationBatch(job, campaign, {
      deliveryEnabled: true,
      stateClient: stateClient as never,
      dailyBudgetClient: dailyBudgetClient as never,
      notificationClient: {
        listOptedInUsers: vi.fn().mockResolvedValue({ userIds: ["t2_alice"] }),
        enqueue,
      } as never,
      now: () => now,
    });
    releaseList({ userIds: ["t2_alice"] });
    await first;
    expect(dailyBudgetClient.incrBy).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();

    const sendState = new StateRedisHarness();
    let releaseSend!: (value: {
      successCount: number;
      failureCount: number;
    }) => void;
    const pausedSend = new Promise<{
      successCount: number;
      failureCount: number;
    }>((resolve) => {
      releaseSend = resolve;
    });
    now = job.completedTime + 1_000;
    const sending = processMilestoneNotificationBatch(
      { ...job, cursor: "send" },
      campaign,
      {
        deliveryEnabled: true,
        stateClient: sendState as never,
        dailyBudgetClient: {
          incrBy: vi.fn().mockResolvedValue(1),
          expire: vi.fn(),
        } as never,
        notificationClient: {
          listOptedInUsers: vi.fn().mockResolvedValue({ userIds: ["t2_bob"] }),
          enqueue: vi.fn(() => pausedSend),
        } as never,
        now: () => now,
      },
    );
    await vi.waitFor(async () => {
      const saved = await sendState.get(
        milestoneNotificationPageKey({ ...job, cursor: "send" }),
      );
      expect(saved).toContain('"phase":"enqueue_started"');
    });
    now += milestoneNotificationClaimMs + 1;
    const takeover = await processMilestoneNotificationBatch(
      { ...job, cursor: "send" },
      campaign,
      {
        deliveryEnabled: true,
        stateClient: sendState as never,
        notificationClient: {
          listOptedInUsers: vi.fn(),
          enqueue: vi.fn(),
        } as never,
        now: () => now,
      },
    );
    expect(takeover.status).toBe("unresolved");
    releaseSend({ successCount: 1, failureCount: 0 });
    await expect(sending).resolves.toMatchObject({ status: "unresolved" });
  });

  it("blocks replay after an ambiguous enqueue result and exposes the boundary", async () => {
    const stateClient = new StateRedisHarness();
    const enqueue = vi.fn().mockRejectedValue(new Error("response lost"));
    const options = {
      deliveryEnabled: true,
      stateClient: stateClient as never,
      dailyBudgetClient: {
        incrBy: vi.fn().mockResolvedValue(1),
        expire: vi.fn(),
      } as never,
      notificationClient: {
        listOptedInUsers: vi.fn().mockResolvedValue({ userIds: ["t2_alice"] }),
        enqueue,
      } as never,
      now: () => job.completedTime + 1_000,
    };
    await expect(
      processMilestoneNotificationBatch(job, campaign, options),
    ).rejects.toThrow("response lost");
    await expect(
      processMilestoneNotificationBatch(job, campaign, options),
    ).resolves.toMatchObject({ status: "unresolved" });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(await stateClient.get(milestoneNotificationPageKey(job))).toContain(
      '"phase":"enqueue_started"',
    );
  });

  it("recovers the exact saved child and rejects work at the deadline", async () => {
    const stateClient = new StateRedisHarness();
    const failedScheduler = {
      runJob: vi.fn().mockRejectedValue(new Error("down")),
    };
    await processMilestoneNotificationBatch(job, campaign, {
      deliveryEnabled: true,
      stateClient: stateClient as never,
      dailyBudgetClient: {
        incrBy: vi.fn().mockResolvedValue(1),
        expire: vi.fn(),
      } as never,
      notificationClient: {
        listOptedInUsers: vi
          .fn()
          .mockResolvedValue({ userIds: ["t2_alice"], next: "saved-cursor" }),
        enqueue: vi
          .fn()
          .mockResolvedValue({ successCount: 1, failureCount: 0 }),
      } as never,
      schedulerClient: failedScheduler as never,
      now: () => job.completedTime + 1_000,
    });
    const runJob = vi.fn().mockResolvedValue("accepted");
    const summary = await recoverMilestoneNotificationContinuations({
      deliveryEnabled: true,
      redisClient: stateClient as never,
      schedulerClient: { runJob } as never,
      getCampaign: vi.fn().mockResolvedValue(campaign),
      now: () => job.completedTime + 2_000,
    });
    expect(summary.scheduled).toBe(1);
    expect(runJob.mock.calls[0]?.[0].data).toEqual({
      ...job,
      cursor: "saved-cursor",
      attemptedRecipients: 1,
    });

    const reads = vi.fn();
    const expired = await processMilestoneNotificationBatch(job, campaign, {
      deliveryEnabled: true,
      stateClient: { get: reads } as never,
      notificationClient: {
        listOptedInUsers: vi.fn(),
        enqueue: vi.fn(),
      } as never,
      now: () => milestoneNotificationDeadline(job.completedTime),
    });
    expect(expired.status).toBe("expired");
    expect(reads).not.toHaveBeenCalled();
  });
});
