import { logDiagnostic } from "../../shared/diagnostics";
import { getAppSettings, type ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import {
  reconcileCompletedGoal,
  type CompletedGoalReconciliationOutcome,
} from "./completedGoalReconciliation";
import {
  ensureExistingSubscriberGoalHighlighted,
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
import {
  CommunityGoalMutationInProgressError,
  withCommunityGoalMutationLease,
  type CommunityGoalMutationLease,
} from "./communityGoalMutation";

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
      highlightStatus: "highlighted" | "not_highlighted";
    }
  | {
      status: CompletedGoalReconciliationOutcome;
      operationId: string;
      sourcePostId: string;
      postId?: string;
    };

/**
 * Reconciles install/upgrade onboarding against Reddit's current highlighted goal.
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
  try {
    return await withCommunityGoalMutationLease(redis, (mutationLease) =>
      reconcileOnboardingForLifecycleUnderLease(reddit, redis, {
        lifecycleSource,
        nowMs,
        appSettings,
        mutationLease,
      }),
    );
  } catch (error) {
    if (error instanceof CommunityGoalMutationInProgressError) {
      return { status: "unchanged", reason: "community_mutation_in_progress" };
    }
    throw error;
  }
}

async function reconcileOnboardingForLifecycleUnderLease(
  reddit: RedditClient,
  redis: RedisClient,
  {
    lifecycleSource,
    nowMs,
    appSettings,
    mutationLease,
  }: {
    lifecycleSource: Extract<OnboardingLifecycleSource, "install" | "upgrade">;
    nowMs: number;
    appSettings: ServerAppSettings;
    mutationLease: CommunityGoalMutationLease;
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

      const highlighted = await ensureExistingSubscriberGoalHighlighted({
        reddit,
        redis,
        nowMs,
        notifyOnFailure: true,
        reconciliationContext:
          lifecycleSource === "upgrade" ? "legacy_upgrade" : "onboarding",
        mutationLease,
      });
      logDiagnostic("info", "onboarding_lifecycle_highlighted_goal_checked", {
        workflow: "onboarding_lifecycle",
        phase: "highlighted_goal_check",
        lifecycleSource,
        found: highlighted.status !== "missing",
        highlightStatus: highlighted.status,
        reconciliationOutcome:
          highlighted.reconciliationOutcome ?? "not_attempted",
        capacityOutcome: highlighted.capacityOutcome ?? "not_attempted",
        cleanupOutcome: highlighted.cleanupOutcome ?? "not_attempted",
        rollbackOutcome: highlighted.rollbackOutcome ?? "not_attempted",
        reorderOutcome: highlighted.reorderOutcome ?? "not_attempted",
        postId: highlighted.postId ?? "none",
        existingSource: highlighted.source ?? "none",
        validated: highlighted.validated,
        highlightedInspected: highlighted.highlightedInspected,
        searchInspected: highlighted.searchInspected,
        failed: highlighted.failed,
      });

      if (
        highlighted.status === "completed" &&
        highlighted.postId &&
        highlighted.source &&
        highlighted.completedTime
      ) {
        const operationId =
          previousGoal?.operationId ?? createOperationId(nowMs);
        const completed = await reconcileCompletedGoal({
          reddit,
          redis,
          appSettings,
          lifecycleSource,
          sourcePostId: highlighted.postId,
          completedTime: highlighted.completedTime,
          autoCreateNextGoal: highlighted.autoCreateNextGoal ?? false,
          nowMs,
          mutationLease,
        });
        const { outcome, successorPostId } = completed;

        const terminalPostId = successorPostId ?? highlighted.postId;
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
          existingSource: highlighted.source,
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
          existingSource: highlighted.source,
          result: outcome,
        };
        await savePairedState(redis, previousGoal, nextGoal, nextReminder);
        logDiagnostic("info", "onboarding_completed_goal_reconciled", {
          workflow: "onboarding_lifecycle",
          phase: "completed_goal_replacement",
          lifecycleSource,
          outcome,
          sourcePostId: highlighted.postId,
          successorPostId: successorPostId ?? "none",
          completedTime: highlighted.completedTime,
          autoCreateNextGoal: highlighted.autoCreateNextGoal ?? false,
        });
        return {
          status: outcome,
          operationId,
          sourcePostId: highlighted.postId,
          ...(successorPostId ? { postId: successorPostId } : {}),
        };
      }

      if (
        highlighted.status !== "missing" &&
        highlighted.status !== "completed" &&
        highlighted.postId &&
        highlighted.source
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
          postId: highlighted.postId,
          existingSource: highlighted.source,
          resultStatus:
            highlighted.status === "existing"
              ? "existing"
              : "existing_not_highlighted",
          ...(highlighted.errorMessage
            ? { errorMessage: highlighted.errorMessage }
            : {}),
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
          postId: highlighted.postId,
          existingSource: highlighted.source,
          result:
            highlighted.status === "existing"
              ? "existing"
              : "existing_not_highlighted",
          ...(highlighted.errorMessage
            ? { errorMessage: highlighted.errorMessage }
            : {}),
        };
        await savePairedState(redis, previousGoal, nextGoal, nextReminder);
        logDiagnostic(
          "info",
          "onboarding_lifecycle_highlighted_goal_preserved",
          {
            workflow: "onboarding_lifecycle",
            phase: "reconcile",
            lifecycleSource,
            decision:
              highlighted.status === "existing"
                ? "existing_highlighted_goal"
                : "existing_goal_pin_failed",
            operationId,
            postId: highlighted.postId,
            existingSource: highlighted.source,
          },
        );
        return {
          status: "existing",
          operationId,
          postId: highlighted.postId,
          existingSource: highlighted.source,
          highlightStatus:
            highlighted.status === "existing"
              ? "highlighted"
              : "not_highlighted",
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
      logDiagnostic(
        "info",
        "onboarding_rearmed_after_missing_highlighted_goal",
        {
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
        },
      );
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
