import { logDiagnostic } from "../../shared/diagnostics";
import { getAppSettings, type ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import {
  reconcileCompletedGoal,
  type CompletedGoalReconciliationOutcome,
} from "./completedGoalReconciliation";
import {
  ensureExistingSubscriberGoalPinned,
  getOnboardingSubscriberGoalState,
  onboardingSubscriberGoalLockKey,
  onboardingSubscriberGoalLockTtlMs,
  onboardingSubscriberGoalStateKey,
  onboardingSubscriberGoalVersion,
  saveOnboardingState,
  selectOnboardingGoalStaggerMinutes,
  type OnboardingExistingSource,
  type OnboardingLifecycleSource,
  type OnboardingSubscriberGoalState,
} from "./onboardingSubscriberGoal";
import {
  getOnboardingReminderState,
  onboardingReminderLockKey,
  onboardingReminderLockTtlMs,
  onboardingReminderStateKey,
  onboardingReminderVersion,
  saveOnboardingReminderState,
  selectOnboardingReminderStaggerMinutes,
  type OnboardingReminderState,
} from "./onboardingReminder";

export type OnboardingLifecycleReconciliation =
  | { status: "unchanged"; reason: string }
  | {
      status: "rearmed";
      operationId: string;
    }
  | {
      status: "existing";
      operationId: string;
      postId: string;
      existingSource: OnboardingExistingSource;
      pinStatus: "pinned" | "not_pinned";
    }
  | {
      status: CompletedGoalReconciliationOutcome;
      operationId: string;
      sourcePostId: string;
      postId?: string;
    };

/**
 * Reconciles install/upgrade onboarding against Reddit's current pinned goal.
 * Both workflow locks are held while the paired goal/reminder state is replaced.
 */
export async function reconcileOnboardingForLifecycle(
  reddit: RedditClient,
  redis: RedisClient,
  {
    lifecycleSource,
    nowMs = Date.now(),
    appSettings = getAppSettings(),
  }: {
    lifecycleSource: Extract<OnboardingLifecycleSource, "install" | "upgrade">;
    nowMs?: number;
    appSettings?: ServerAppSettings;
  },
): Promise<OnboardingLifecycleReconciliation> {
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
      const [rawGoal, rawReminder, previousGoal, previousReminder] =
        await Promise.all([
          redis.hGetAll(onboardingSubscriberGoalStateKey),
          redis.hGetAll(onboardingReminderStateKey),
          getOnboardingSubscriberGoalState(redis),
          getOnboardingReminderState(redis),
        ]);
      if (
        (!previousGoal && Object.keys(rawGoal).length > 0) ||
        (!previousReminder && Object.keys(rawReminder).length > 0)
      ) {
        const reason = "unparseable_nonempty_state_preserved";
        logReconciliationDecision(
          lifecycleSource,
          "unchanged",
          reason,
          previousGoal,
          previousReminder,
        );
        return { status: "unchanged", reason };
      }

      const pinned = await ensureExistingSubscriberGoalPinned({
        reddit,
        redis,
        nowMs,
        notifyOnFailure: true,
      });
      logDiagnostic("info", "onboarding_lifecycle_pinned_goal_checked", {
        workflow: "onboarding_lifecycle",
        phase: "pinned_goal_check",
        lifecycleSource,
        found: pinned.status !== "missing",
        pinStatus: pinned.status,
        postId: pinned.postId ?? "none",
        existingSource: pinned.source ?? "none",
        validated: pinned.validated,
        pinnedInspected: pinned.pinnedInspected,
        searchInspected: pinned.searchInspected,
        failed: pinned.failed,
      });

      if (
        pinned.status === "completed" &&
        pinned.postId &&
        pinned.source &&
        pinned.completedTime
      ) {
        const operationId =
          previousGoal?.operationId ?? createOperationId(nowMs);
        const completed = await reconcileCompletedGoal({
          reddit,
          redis,
          appSettings,
          lifecycleSource,
          sourcePostId: pinned.postId,
          completedTime: pinned.completedTime,
          autoCreateNextGoal: pinned.autoCreateNextGoal ?? false,
          nowMs,
        });
        const { outcome, successorPostId } = completed;

        const terminalPostId = successorPostId ?? pinned.postId;
        const nextGoal: OnboardingSubscriberGoalState = {
          version: onboardingSubscriberGoalVersion,
          status: "complete",
          armedAt: previousGoal?.armedAt ?? nowMs,
          lifecycleSource,
          creationStaggerMinutes:
            previousGoal?.creationStaggerMinutes ??
            selectOnboardingGoalStaggerMinutes(),
          operationId,
          completedAt: nowMs,
          postId: terminalPostId,
          existingSource: pinned.source,
          resultStatus: outcome,
        };
        const nextReminder: OnboardingReminderState = {
          version: onboardingReminderVersion,
          status: "complete",
          armedAt: previousReminder?.armedAt ?? nextGoal.armedAt,
          nextRunAt: previousReminder?.nextRunAt ?? nowMs,
          lifecycleSource,
          reminderStaggerMinutes:
            previousReminder?.reminderStaggerMinutes ??
            selectOnboardingReminderStaggerMinutes(),
          completedAt: nowMs,
          postId: terminalPostId,
          existingSource: pinned.source,
          result: outcome,
        };
        await savePairedState(redis, previousGoal, nextGoal, nextReminder);
        logDiagnostic("info", "onboarding_completed_goal_reconciled", {
          workflow: "onboarding_lifecycle",
          phase: "completed_goal_replacement",
          lifecycleSource,
          outcome,
          sourcePostId: pinned.postId,
          successorPostId: successorPostId ?? "none",
          completedTime: pinned.completedTime,
          autoCreateNextGoal: pinned.autoCreateNextGoal ?? false,
        });
        return {
          status: outcome,
          operationId,
          sourcePostId: pinned.postId,
          ...(successorPostId ? { postId: successorPostId } : {}),
        };
      }

      if (
        pinned.status !== "missing" &&
        pinned.status !== "completed" &&
        pinned.postId &&
        pinned.source
      ) {
        const operationId =
          previousGoal?.operationId ?? createOperationId(nowMs);
        const nextGoal: OnboardingSubscriberGoalState = {
          version: onboardingSubscriberGoalVersion,
          status: "complete",
          armedAt: previousGoal?.armedAt ?? nowMs,
          lifecycleSource,
          creationStaggerMinutes:
            previousGoal?.creationStaggerMinutes ??
            selectOnboardingGoalStaggerMinutes(),
          operationId,
          completedAt: nowMs,
          postId: pinned.postId,
          existingSource: pinned.source,
          resultStatus:
            pinned.status === "existing" ? "existing" : "existing_not_pinned",
          ...(pinned.errorMessage ? { errorMessage: pinned.errorMessage } : {}),
        };
        const nextReminder: OnboardingReminderState = {
          version: onboardingReminderVersion,
          status: "complete",
          armedAt: previousReminder?.armedAt ?? nextGoal.armedAt,
          nextRunAt: previousReminder?.nextRunAt ?? nowMs,
          lifecycleSource,
          reminderStaggerMinutes:
            previousReminder?.reminderStaggerMinutes ??
            selectOnboardingReminderStaggerMinutes(),
          completedAt: nowMs,
          postId: pinned.postId,
          existingSource: pinned.source,
          result:
            pinned.status === "existing" ? "existing" : "existing_not_pinned",
          ...(pinned.errorMessage ? { errorMessage: pinned.errorMessage } : {}),
        };
        await savePairedState(redis, previousGoal, nextGoal, nextReminder);
        logDiagnostic("info", "onboarding_lifecycle_pinned_goal_preserved", {
          workflow: "onboarding_lifecycle",
          phase: "reconcile",
          lifecycleSource,
          decision:
            pinned.status === "existing"
              ? "existing_pinned_goal"
              : "existing_goal_pin_failed",
          operationId,
          postId: pinned.postId,
          existingSource: pinned.source,
        });
        return {
          status: "existing",
          operationId,
          postId: pinned.postId,
          existingSource: pinned.source,
          pinStatus: pinned.status === "existing" ? "pinned" : "not_pinned",
        };
      }

      if (isWorkflowActive(previousGoal, previousReminder)) {
        const reason = "active_workflow_preserved";
        logReconciliationDecision(
          lifecycleSource,
          "unchanged",
          reason,
          previousGoal,
          previousReminder,
        );
        return { status: "unchanged", reason };
      }

      const creationStaggerMinutes = selectOnboardingGoalStaggerMinutes();
      const reminderStaggerMinutes = selectOnboardingReminderStaggerMinutes();
      const operationId = createOperationId(nowMs);
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
      await savePairedState(redis, previousGoal, nextGoal, nextReminder);
      logDiagnostic("info", "onboarding_rearmed_after_missing_pinned_goal", {
        workflow: "onboarding_lifecycle",
        phase: "rearm",
        lifecycleSource,
        previousGoalResult: previousGoal?.resultStatus ?? "none",
        previousReminderResult: previousReminder?.result ?? "none",
        operationId,
        armedAt: nowMs,
        creationStaggerMinutes,
        reminderStaggerMinutes,
        reminderNextRunAt: nextReminder.nextRunAt,
        reminderNextRunAtIso: new Date(nextReminder.nextRunAt).toISOString(),
      });
      return { status: "rearmed", operationId };
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

function isWorkflowActive(
  goal: OnboardingSubscriberGoalState | undefined,
  reminder: OnboardingReminderState | undefined,
): boolean {
  return (
    (goal !== undefined && goal.status !== "complete") ||
    (reminder !== undefined && reminder.status !== "complete")
  );
}

function createOperationId(nowMs: number): string {
  return `onboarding:${onboardingSubscriberGoalVersion}:${nowMs}`;
}

async function savePairedState(
  redis: RedisClient,
  previousGoal: OnboardingSubscriberGoalState | undefined,
  nextGoal: OnboardingSubscriberGoalState,
  nextReminder: OnboardingReminderState,
): Promise<void> {
  await saveOnboardingState(redis, nextGoal);
  try {
    await saveOnboardingReminderState(redis, nextReminder);
  } catch (error) {
    if (previousGoal) await saveOnboardingState(redis, previousGoal);
    else await redis.del(onboardingSubscriberGoalStateKey);
    throw error;
  }
}

function logReconciliationDecision(
  lifecycleSource: Extract<OnboardingLifecycleSource, "install" | "upgrade">,
  decision: "unchanged",
  reason: string,
  goal: OnboardingSubscriberGoalState | undefined,
  reminder: OnboardingReminderState | undefined,
): void {
  logDiagnostic("info", "onboarding_lifecycle_reconciliation_checked", {
    workflow: "onboarding_lifecycle",
    phase: "reconcile",
    lifecycleSource,
    decision,
    reason,
    goalState: goal?.status ?? "missing_or_unparseable",
    goalResult: goal?.resultStatus ?? "none",
    goalOperationId: goal?.operationId ?? "none",
    goalNextRunAt: goal?.nextRunAt ?? "none",
    reminderState: reminder?.status ?? "missing_or_unparseable",
    reminderResult: reminder?.result ?? "none",
    reminderNextRunAt: reminder?.nextRunAt ?? "none",
  });
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
