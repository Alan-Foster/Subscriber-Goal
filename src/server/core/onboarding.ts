import { logDiagnostic } from "../../shared/diagnostics";
import type { ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import { processDueOnboardingSubscriberGoal } from "./onboardingSubscriberGoal";
import { processDueOnboardingReminder } from "./onboardingWarning";

export async function processDueOnboarding({
  reddit,
  redis,
  appSettings,
  permissionWorkAllowed,
  nowMs = Date.now(),
  canStart = () => true,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  permissionWorkAllowed: boolean;
  nowMs?: number;
  canStart?: () => boolean;
}): Promise<void> {
  if (!canStart()) return;
  try {
    await processDueOnboardingReminder({ reddit, redis, nowMs, canStart });
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "onboarding_reminder" },
      error,
    );
  }
  if (!permissionWorkAllowed || !canStart()) return;
  try {
    await processDueOnboardingSubscriberGoal({
      reddit,
      redis,
      appSettings,
      nowMs,
      canStart,
    });
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "onboarding_subscriber_goal" },
      error,
    );
  }
}
