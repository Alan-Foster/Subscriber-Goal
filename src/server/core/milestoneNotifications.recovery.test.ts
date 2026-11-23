import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MilestoneNotificationJob } from "../../shared/types/api";
import type { SubGoalData } from "../data/subGoalData";
import type { RedditClient, RedisClient } from "../types";
import { FakeRedisImpl } from "../testing/faultHarness";
import {
  milestoneNotificationJobName,
  milestoneNotificationPageKey,
  milestoneNotificationRecoveryKey,
  type MilestoneNotificationCampaignData,
  type MilestoneNotificationPageState,
} from "./milestoneNotifications";
import { dispatchMilestoneNotificationRecovery } from "../jobs/milestoneNotificationRecovery";

const { getSubGoalData, observeCampaign } = vi.hoisted(() => ({
  getSubGoalData:
    vi.fn<
      () => Promise<
        Pick<
          SubGoalData,
          "completedTime" | "goal" | "subredditDisplayName" | "language"
        >
      >
    >(),
  observeCampaign:
    vi.fn<(campaign: MilestoneNotificationCampaignData | undefined) => void>(),
}));
vi.mock("../data/subGoalData", () => ({ getSubGoalData }));
vi.mock("./milestoneNotifications", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./milestoneNotifications")>();
  return {
    ...actual,
    MILESTONE_NOTIFICATION_DELIVERY_ENABLED: true,
    // Exercise real recovery in this suite while production delivery is off.
    recoverMilestoneNotificationContinuations: (
      options: Parameters<
        typeof actual.recoverMilestoneNotificationContinuations
      >[0],
    ) =>
      actual.recoverMilestoneNotificationContinuations({
        ...options,
        deliveryEnabled: true,
        getCampaign: async (job) => {
          const campaign = await options.getCampaign(job);
          observeCampaign(campaign);
          return campaign;
        },
      }),
  };
});

describe("milestone notification campaign recovery", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    {
      label: "matching goal",
      goal: 200,
      completedTimeOffset: 0,
      displayName: "ExampleSub",
      scheduled: true,
    },
    {
      label: "missing display name",
      goal: 200,
      completedTimeOffset: 0,
      displayName: null,
      scheduled: true,
    },
    {
      label: "stale completion",
      goal: 200,
      completedTimeOffset: 1,
      displayName: "ExampleSub",
      scheduled: false,
    },
    {
      label: "zero goal",
      goal: 0,
      completedTimeOffset: 0,
      displayName: "ExampleSub",
      scheduled: false,
    },
  ])(
    "checks the $label before scheduling the saved child",
    async ({ goal, completedTimeOffset, displayName, scheduled }) => {
      const now = Date.now();
      const impl = new FakeRedisImpl();
      const redis = impl as unknown as RedisClient;
      const job: MilestoneNotificationJob = {
        campaign: "milestone-completed",
        postId: "t3_goal",
        completedTime: now - 10_000,
        cursor: "",
        attemptedRecipients: 0,
      };
      const child = { ...job, cursor: "saved-cursor", attemptedRecipients: 1 };
      const key = milestoneNotificationPageKey(job);
      const state: MilestoneNotificationPageState = {
        version: 2,
        job,
        phase: "confirmed",
        child,
        continuation: "pending",
        recoveryAttempts: 0,
        nextRecoveryAt: now,
        updatedAt: now,
      };
      await impl.set(key, JSON.stringify(state));
      await impl.zAdd(milestoneNotificationRecoveryKey, {
        member: key,
        score: now,
      });
      getSubGoalData.mockResolvedValue({
        goal,
        completedTime: job.completedTime + completedTimeOffset,
        subredditDisplayName: displayName,
        language: "en",
      });
      const getCurrentSubreddit = vi.fn(async () => ({ name: "CanonicalSub" }));
      const reddit = { getCurrentSubreddit } as unknown as RedditClient;
      const runJob = vi
        .fn<() => Promise<string>>()
        .mockResolvedValue("scheduled-job");

      await dispatchMilestoneNotificationRecovery(
        reddit,
        redis,
        { runJob },
        now + 20_000,
      );

      expect(getSubGoalData).toHaveBeenCalledExactlyOnceWith(redis, job.postId);
      expect(getCurrentSubreddit).toHaveBeenCalledTimes(scheduled ? 1 : 0);
      if (scheduled) {
        expect(observeCampaign).toHaveBeenCalledExactlyOnceWith({
          postId: job.postId,
          completedTime: job.completedTime,
          goal,
          language: "en",
          subredditName: displayName ?? "CanonicalSub",
        });
        expect(runJob).toHaveBeenCalledExactlyOnceWith({
          name: milestoneNotificationJobName,
          data: child,
          runAt: expect.any(Date),
        });
        expect(await impl.get(key)).toContain('"continuation":"scheduled"');
      } else {
        expect(observeCampaign).toHaveBeenCalledExactlyOnceWith(undefined);
        expect(runJob).not.toHaveBeenCalled();
        expect(await impl.get(key)).toContain('"continuation":"terminal"');
      }
      expect(
        await impl.zScore(milestoneNotificationRecoveryKey, key),
      ).toBeUndefined();
    },
  );
});
