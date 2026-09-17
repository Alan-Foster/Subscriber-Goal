import { logDiagnostic } from "../../shared/diagnostics";
import type { RedisClient } from "../types";
import {
  getOnboardingSubscriberGoalState,
  onboardingSubscriberGoalLockKey,
  onboardingSubscriberGoalLockTtlMs,
  onboardingSubscriberGoalVersion,
  saveOnboardingState,
  selectOnboardingGoalStaggerMinutes,
  type OnboardingLifecycleSource,
  type OnboardingSubscriberGoalState,
} from "./onboardingSubscriberGoal";
import {
  getOnboardingReminderState,
  onboardingReminderLockKey,
  onboardingReminderLockTtlMs,
  onboardingReminderVersion,
  saveOnboardingReminderState,
  selectOnboardingReminderStaggerMinutes,
  type OnboardingReminderState,
} from "./onboardingReminder";

export type OnboardingLifecycleReconciliation =
  | { status: "unchanged" }
  | {
      status: "rearmed";
      operationId: string;
      previousSubscriberCount?: number;
    };

/**
 * Reopens only a completed ineligible attempt during an install/upgrade.
 * Both workflow locks are held while the paired goal/reminder state is replaced.
 */
export async function rearmPreviouslyIneligibleOnboarding(
  redis: RedisClient,
  {
    lifecycleSource,
    nowMs = Date.now(),
  }: {
    lifecycleSource: Extract<OnboardingLifecycleSource, "install" | "upgrade">;
    nowMs?: number;
  },
): Promise<OnboardingLifecycleReconciliation> {
  const initialGoal = await getOnboardingSubscriberGoalState(redis);
  const initialReminder = await getOnboardingReminderState(redis);
  if (!isRearmablePair(initialGoal, initialReminder)) {
    return { status: "unchanged" };
  }

  const goalLockToken = await acquireLock(
    redis,
    onboardingSubscriberGoalLockKey,
    onboardingSubscriberGoalLockTtlMs,
    nowMs,
  );
  try {
    const reminderLockToken = await acquireLock(
      redis,
      onboardingReminderLockKey,
      onboardingReminderLockTtlMs,
      nowMs,
    );
    try {
      const previousGoal = await getOnboardingSubscriberGoalState(redis);
      const previousReminder = await getOnboardingReminderState(redis);
      if (!isRearmablePair(previousGoal, previousReminder)) {
        return { status: "unchanged" };
      }

      const creationStaggerMinutes = selectOnboardingGoalStaggerMinutes();
      const reminderStaggerMinutes = selectOnboardingReminderStaggerMinutes();
      const operationId = `onboarding:${onboardingSubscriberGoalVersion}:${nowMs}`;
      const nextGoal: OnboardingSubscriberGoalState = {
        version: onboardingSubscriberGoalVersion,
        status: "awaiting_warning",
        armedAt: nowMs,
        lifecycleSource,
        creationStaggerMinutes,
        operationId,
      };
      const nextReminder: OnboardingReminderState = {
        version: onboardingReminderVersion,
        status: "pending",
        armedAt: nowMs,
        nextRunAt: nowMs + reminderStaggerMinutes * 60 * 1000,
        lifecycleSource,
        reminderStaggerMinutes,
      };

      await saveOnboardingState(redis, nextGoal);
      try {
        await saveOnboardingReminderState(redis, nextReminder);
      } catch (error) {
        await saveOnboardingState(redis, previousGoal);
        throw error;
      }

      logDiagnostic("info", "onboarding_rearmed_after_eligibility_change", {
        workflow: "onboarding_lifecycle",
        phase: "rearm",
        lifecycleSource,
        previousResult: previousGoal.resultStatus,
        previousSubscriberCount:
          previousGoal.eligibilitySubscriberCount ?? "unknown",
        previousIneligibilityReason:
          previousGoal.ineligibilityReason ??
          previousReminder?.ineligibilityReason ??
          "unknown",
        operationId,
        armedAt: nowMs,
        creationStaggerMinutes,
        reminderStaggerMinutes,
        reminderNextRunAt: nextReminder.nextRunAt,
      });
      return {
        status: "rearmed",
        operationId,
        ...(previousGoal.eligibilitySubscriberCount !== undefined
          ? {
              previousSubscriberCount: previousGoal.eligibilitySubscriberCount,
            }
          : {}),
      };
    } finally {
      await releaseOwnedLock(
        redis,
        onboardingReminderLockKey,
        reminderLockToken,
      );
    }
  } finally {
    await releaseOwnedLock(
      redis,
      onboardingSubscriberGoalLockKey,
      goalLockToken,
    );
  }
}

function isRearmablePair(
  goal: OnboardingSubscriberGoalState | undefined,
  reminder: OnboardingReminderState | undefined,
): goal is OnboardingSubscriberGoalState & {
  status: "complete";
  resultStatus: "ineligible";
} {
  return (
    goal?.status === "complete" &&
    goal.resultStatus === "ineligible" &&
    (reminder === undefined ||
      (reminder.status === "complete" && reminder.result === "ineligible"))
  );
}

async function acquireLock(
  redis: RedisClient,
  key: string,
  ttlMs: number,
  nowMs: number,
): Promise<string> {
  const token = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(key, token, {
    nx: true,
    expiration: new Date(nowMs + ttlMs),
  });
  if ((await redis.get(key)) !== token) {
    throw new Error(`Onboarding lifecycle state is currently locked: ${key}`);
  }
  return token;
}

async function releaseOwnedLock(
  redis: RedisClient,
  key: string,
  token: string,
): Promise<void> {
  if ((await redis.get(key)) === token) await redis.del(key);
}
