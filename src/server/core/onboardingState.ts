import type { RedisClient } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";

export const onboardingSubscriberGoalStateKey =
  "onboarding_subscriber_goal_v4_state";
export const onboardingSubscriberGoalVersion = "onboarding_subscriber_goal_v4";
export const onboardingSubscriberGoalLockKey =
  "onboarding_subscriber_goal_v4_lock";
export const onboardingSubscriberGoalLockTtlMs = 15 * 60 * 1000;
export const onboardingReminderStateKey = "onboarding_reminder_v3_state";
export const onboardingWarningDeliveryUnknownMessage =
  "A previous modmail dispatch could not be confirmed.";

const warningField = "warningState";
const legacyLocks = [
  "onboarding_reminder_v3_lock",
  "onboarding_reminder_v3_init_lock",
  "onboarding_subscriber_goal_v4_init_lock",
] as const;

export function hasEmbeddedOnboardingWarning(
  workflow: Record<string, string>,
): boolean {
  return workflow[warningField] !== undefined;
}

export function onboardingWarningFields(
  raw: Record<string, string>,
): Record<string, string> {
  return { [warningField]: JSON.stringify(raw) };
}

export async function readOnboardingWarningFields(
  redis: RedisClient,
  workflow?: Record<string, string>,
): Promise<Record<string, string>> {
  const encoded = workflow
    ? workflow[warningField]
    : await redis.hGet(onboardingSubscriberGoalStateKey, warningField);
  if (encoded === undefined) return redis.hGetAll(onboardingReminderStateKey);
  try {
    const warning: unknown = JSON.parse(encoded);
    if (
      warning &&
      typeof warning === "object" &&
      !Array.isArray(warning) &&
      Object.values(warning).every((value) => typeof value === "string")
    )
      return warning as Record<string, string>;
    throw new Error("Invalid onboarding warning fields");
  } catch (error) {
    logDiagnostic(
      "warn",
      "onboarding_warning_state_invalid",
      { workflow: "onboarding_reminder", phase: "read_state" },
      error,
    );
    throw error;
  }
}

// Call while holding the workflow lock. The original hash remains readable
// during upgrade, but is never written by the unified workflow.
export async function migrateOnboardingWarning(
  redis: RedisClient,
  nowMs: number,
  recoverDispatch = false,
): Promise<boolean> {
  const workflow = await redis.hGetAll(onboardingSubscriberGoalStateKey);
  const migrated = workflow[warningField] !== undefined;
  if (migrated && !recoverDispatch) return true;
  if (!migrated) {
    for (const key of legacyLocks) {
      if (await redis.get(key)) return false;
    }
  }
  const warning = await readOnboardingWarningFields(redis, workflow);
  if (Object.keys(warning).length === 0) return true;
  if (
    warning.version === "onboarding_reminder_v3" &&
    warning.status === "dispatching"
  ) {
    await migrateUncertainWarning(redis, workflow, warning, nowMs);
  } else if (!migrated) {
    await redis.hSet(
      onboardingSubscriberGoalStateKey,
      onboardingWarningFields(warning),
    );
  }
  return true;
}

async function migrateUncertainWarning(
  redis: RedisClient,
  goal: Record<string, string>,
  warning: Record<string, string>,
  nowMs: number,
): Promise<void> {
  const completedAt = String(nowMs);
  const errorMessage = onboardingWarningDeliveryUnknownMessage;
  const fields = onboardingWarningFields({
    ...warning,
    status: "complete",
    result: "delivery_unknown",
    completedAt,
    errorMessage,
  });
  // Pending or processing creation already has its own replay identity. An
  // old uncertain warning only cancels a goal still waiting for that warning.
  if (
    goal.version === onboardingSubscriberGoalVersion &&
    goal.status === "awaiting_warning"
  ) {
    Object.assign(fields, {
      status: "complete",
      resultStatus: "delivery_unknown",
      completedAt,
      errorMessage,
    });
  }
  await redis.hSet(onboardingSubscriberGoalStateKey, fields);
  logDiagnostic("warn", "onboarding_modmail_delivery_unknown", {
    workflow: "onboarding_reminder",
    phase: "dispatch_recovery",
    lifecycleSource: warning.lifecycleSource,
    reason: "stale_dispatch_state",
  });
}

export function hasOnboardingGoalFields(raw: Record<string, string>): boolean {
  return Object.keys(raw).some((field) => field !== warningField);
}
