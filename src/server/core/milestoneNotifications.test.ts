import { describe, expect, it, vi } from "vitest";
import type { MilestoneNotificationJob } from "../../shared/types/api";
import {
  MILESTONE_NOTIFICATION_DELIVERY_ENABLED,
  isMilestoneNotificationJob,
  maybeScheduleMilestoneNotification,
  milestoneNotificationBatchDelayMs,
  milestoneNotificationBatchSize,
  milestoneNotificationBody,
  milestoneNotificationJobName,
  milestoneNotificationTitle,
  processMilestoneNotificationBatch,
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
    const now = 1_800_000_000_000;

    const result = await processMilestoneNotificationBatch(job, campaign, {
      deliveryEnabled: true,
      notificationClient: { listOptedInUsers, enqueue } as never,
      schedulerClient: { runJob } as never,
      dailyBudgetClient: { incrBy, expire } as never,
      now: () => now,
    });

    expect(listOptedInUsers).toHaveBeenCalledWith({
      limit: milestoneNotificationBatchSize,
    });
    expect(enqueue).toHaveBeenCalledWith({
      title: milestoneNotificationTitle,
      body: milestoneNotificationBody,
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
      }),
      processMilestoneNotificationBatch(
        { ...job, postId: "t3_other" },
        { ...campaign, postId: "t3_other" },
        {
          deliveryEnabled: true,
          notificationClient: secondClient as never,
          schedulerClient: { runJob: vi.fn() } as never,
          dailyBudgetClient: dailyBudgetClient as never,
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
      },
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(runJob).not.toHaveBeenCalled();
    expect(result).toMatchObject({ done: true, recipients: 0 });
  });
});
