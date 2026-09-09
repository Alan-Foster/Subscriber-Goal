import { notifications } from "@devvit/notifications";
import { redis, scheduler } from "@devvit/web/server";
import type { MilestoneNotificationJob } from "../../shared/types/api";
import type { LinkId } from "../types";
import { isLinkId } from "../types";
import { formatSubscriberCount } from "../../shared/numberFormat";
import { logDiagnostic } from "../../shared/diagnostics";

export const MILESTONE_NOTIFICATION_DELIVERY_ENABLED = false;
export const milestoneNotificationBatchSize = 200;
export const milestoneNotificationBatchDelayMs = 1_500;
export const milestoneNotificationJobName = "milestone-notification-job";
export const milestoneNotificationDailyLimit = 25_000;
export const milestoneNotificationDailyBudgetKeyPrefix =
  "milestone_notification_daily_budget_v1";
export const milestoneNotificationDailyBudgetExpirationSeconds =
  3 * 24 * 60 * 60;

export const milestoneNotificationTitle = "Subscriber milestone reached!";
export const milestoneNotificationBody =
  "r/{{subredditName}} reached {{goalText}} subscribers. Open the goal post to celebrate.";

type NotificationClient = Pick<
  typeof notifications,
  "listOptedInUsers" | "enqueue"
>;

type SchedulerClient = Pick<typeof scheduler, "runJob">;
type DailyBudgetClient = Pick<typeof redis.global, "incrBy" | "expire">;

export type MilestoneNotificationCampaignData = {
  postId: LinkId;
  completedTime: number;
  subredditName: string;
  goal: number;
};

export type MilestoneNotificationBatchResult =
  | { status: "suppressed"; done: true; cursor: "" }
  | {
      status: "processed";
      done: boolean;
      cursor: string;
      recipients: number;
      successCount: number;
      failureCount: number;
    };

export const isMilestoneNotificationJob = (
  value: unknown,
): value is MilestoneNotificationJob => {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<MilestoneNotificationJob>;
  return (
    job.campaign === "milestone-completed" &&
    typeof job.postId === "string" &&
    isLinkId(job.postId) &&
    typeof job.completedTime === "number" &&
    Number.isFinite(job.completedTime) &&
    job.completedTime > 0 &&
    typeof job.cursor === "string" &&
    typeof job.attemptedRecipients === "number" &&
    Number.isSafeInteger(job.attemptedRecipients) &&
    job.attemptedRecipients >= 0 &&
    job.attemptedRecipients <= milestoneNotificationDailyLimit
  );
};

export const renderMilestoneNotificationCopy = (input: {
  subredditName: string;
  goal: number;
}): { title: string; body: string; data: Record<string, string> } => {
  const data = {
    subredditName: input.subredditName,
    goalText: formatSubscriberCount(input.goal),
  };
  const title = milestoneNotificationTitle.replace(
    "{{subredditName}}",
    data.subredditName,
  );
  const body = milestoneNotificationBody
    .replace("{{subredditName}}", data.subredditName)
    .replace("{{goalText}}", data.goalText);
  if (title.length > 60 || body.length > 100) {
    throw new Error("Rendered milestone notification copy exceeds limits.");
  }
  return { title, body, data };
};

export async function maybeScheduleMilestoneNotification(
  input: Omit<
    MilestoneNotificationJob,
    "campaign" | "cursor" | "attemptedRecipients"
  >,
  options: {
    deliveryEnabled?: boolean;
    schedulerClient?: SchedulerClient;
  } = {},
): Promise<"scheduled" | "suppressed"> {
  const deliveryEnabled =
    options.deliveryEnabled ?? MILESTONE_NOTIFICATION_DELIVERY_ENABLED;
  if (!deliveryEnabled) {
    logDiagnostic("info", "milestone_notification_suppressed", {
      workflow: "milestone_notification",
      phase: "schedule",
      postId: input.postId,
      reason: "delivery_disabled",
    });
    return "suppressed";
  }

  await (options.schedulerClient ?? scheduler).runJob({
    name: milestoneNotificationJobName,
    data: {
      campaign: "milestone-completed",
      postId: input.postId,
      completedTime: input.completedTime,
      cursor: "",
      attemptedRecipients: 0,
    } satisfies MilestoneNotificationJob,
    runAt: new Date(),
  });
  return "scheduled";
}

export async function processMilestoneNotificationBatch(
  job: MilestoneNotificationJob,
  campaign: MilestoneNotificationCampaignData,
  options: {
    deliveryEnabled?: boolean;
    notificationClient?: NotificationClient;
    schedulerClient?: SchedulerClient;
    dailyBudgetClient?: DailyBudgetClient;
    now?: () => number;
  } = {},
): Promise<MilestoneNotificationBatchResult> {
  const deliveryEnabled =
    options.deliveryEnabled ?? MILESTONE_NOTIFICATION_DELIVERY_ENABLED;
  if (!deliveryEnabled) {
    logDiagnostic("info", "milestone_notification_suppressed", {
      workflow: "milestone_notification",
      phase: "delivery",
      postId: job.postId,
      reason: "delivery_disabled",
    });
    return { status: "suppressed", done: true, cursor: "" };
  }
  if (
    campaign.postId !== job.postId ||
    campaign.completedTime !== job.completedTime ||
    campaign.goal <= 0 ||
    campaign.subredditName.trim().length === 0
  ) {
    throw new Error("Milestone notification campaign data is invalid.");
  }

  const notificationClient = options.notificationClient ?? notifications;
  const now = (options.now ?? Date.now)();
  const remainingCampaignCapacity = Math.max(
    0,
    milestoneNotificationDailyLimit - job.attemptedRecipients,
  );
  if (remainingCampaignCapacity === 0) {
    logDiagnostic("warn", "milestone_notification_daily_limit_reached", {
      workflow: "milestone_notification",
      phase: "budget",
      postId: job.postId,
      attemptedRecipients: job.attemptedRecipients,
    });
    return {
      status: "processed",
      done: true,
      cursor: job.cursor,
      recipients: 0,
      successCount: 0,
      failureCount: 0,
    };
  }
  const page = await notificationClient.listOptedInUsers({
    limit: Math.min(milestoneNotificationBatchSize, remainingCampaignCapacity),
    ...(job.cursor ? { after: job.cursor } : {}),
  });
  const copy = renderMilestoneNotificationCopy(campaign);
  const eligibleRecipients = page.userIds
    .filter((userId): userId is `t2_${string}` => /^t2_[\w]+$/.test(userId))
    .map((userId) => ({
      userId,
      link: campaign.postId,
      data: copy.data,
    }));

  let recipients = eligibleRecipients;
  if (eligibleRecipients.length > 0) {
    const budgetClient = options.dailyBudgetClient ?? redis.global;
    const utcDate = new Date(now).toISOString().slice(0, 10);
    const budgetKey = `${milestoneNotificationDailyBudgetKeyPrefix}:${utcDate}`;
    const reservedTotal = await budgetClient.incrBy(
      budgetKey,
      eligibleRecipients.length,
    );
    await budgetClient.expire(
      budgetKey,
      milestoneNotificationDailyBudgetExpirationSeconds,
    );
    const reservedBefore = reservedTotal - eligibleRecipients.length;
    const available = Math.max(
      0,
      milestoneNotificationDailyLimit - reservedBefore,
    );
    recipients = eligibleRecipients.slice(0, available);
    const unusedReservation = eligibleRecipients.length - recipients.length;
    if (unusedReservation > 0) {
      await budgetClient.incrBy(budgetKey, -unusedReservation);
    }
  }

  let successCount = 0;
  let failureCount = 0;
  if (recipients.length > 0) {
    const result = await notificationClient.enqueue({
      title: milestoneNotificationTitle,
      body: milestoneNotificationBody,
      recipients,
    });
    successCount = result.successCount;
    failureCount = result.failureCount;
  }

  const attemptedRecipients = job.attemptedRecipients + recipients.length;
  const cursor = page.next ?? "";
  const done =
    cursor.length === 0 ||
    attemptedRecipients >= milestoneNotificationDailyLimit ||
    recipients.length < eligibleRecipients.length;
  if (!done) {
    await (options.schedulerClient ?? scheduler).runJob({
      name: milestoneNotificationJobName,
      data: {
        ...job,
        cursor,
        attemptedRecipients,
      } satisfies MilestoneNotificationJob,
      runAt: new Date(now + milestoneNotificationBatchDelayMs),
    });
  }
  logDiagnostic("info", "milestone_notification_batch_processed", {
    workflow: "milestone_notification",
    phase: done ? "complete" : "continuation",
    postId: job.postId,
    recipients: recipients.length,
    successCount,
    failureCount,
    hasNextCursor: !done,
    attemptedRecipients,
  });
  return {
    status: "processed",
    done,
    cursor,
    recipients: recipients.length,
    successCount,
    failureCount,
  };
}
