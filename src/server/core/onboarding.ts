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
}: {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  permissionWorkAllowed: boolean;
}): Promise<void> {
  try {
    await processDueOnboardingReminder({ reddit, redis });
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "onboarding_reminder" },
      error,
    );
  }
  if (!permissionWorkAllowed) return;
  try {
    await processDueOnboardingSubscriberGoal({ reddit, redis, appSettings });
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "onboarding_subscriber_goal" },
      error,
    );
  }
}
