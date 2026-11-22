import {
  hasOnboardingGoalFields,
  migrateOnboardingWarning,
  readOnboardingWarningFields,
} from "./onboardingState";
import {
  rearmAutomaticGoalReconciliation,
  beginAutomaticGoalRetryGeneration,
  resetAutomaticGoalPrerequisiteRetry,
} from "./automaticGoalRetry";
import { logDiagnostic } from "../../shared/diagnostics";
import { getAppSettings, type ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import { cancelAutoCreateNextGoal } from "../data/subGoalData";
import {
  reconcileCompletedGoal,
  type CompletedGoalReconciliationOutcome,
} from "./completedGoalReconciliation";
import { ensureExistingSubscriberGoalHighlighted } from "./highlightReconciliation";
import {
  initializeOnboardingSubscriberGoal,
  onboardingSubscriberGoalLockKey,
  onboardingSubscriberGoalLockTtlMs,
  onboardingSubscriberGoalStateKey,
  onboardingSubscriberGoalVersion,
  saveOnboardingState,
  selectOnboardingGoalStaggerMinutes,
  type OnboardingSubscriberGoalState,
} from "./onboardingSubscriberGoal";
import type {
  OnboardingExistingSource,
  OnboardingLifecycleSource,
} from "./goalDiscovery";
import {
  parseOnboardingReminderState,
  onboardingReminderVersion,
  serializeOnboardingReminderState,
  selectOnboardingReminderStaggerMinutes,
  type OnboardingReminderState,
} from "./onboardingWarning";
import { parseOnboardingState } from "./onboardingGoalState";
import {
  CommunityGoalMutationInProgressError,
  withCommunityGoalMutationLease,
  type CommunityGoalMutationLease,
} from "./communityGoalMutation";
import { checkAppAccountHealth } from "./appAccountHealth";
import { acquireRedisLock, releaseRedisLock } from "../utils/redisOwnedLock";

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
 * The workflow lock serializes lifecycle changes with warning and creation.
 */
export async function reconcileOnboardingForLifecycle(
  reddit: RedditClient,
  redis: RedisClient,
  {
    lifecycleSource,
    nowMs = Date.now(),
    appSettings = getAppSettings(),
    allowOnboardingRearm = true,
  }: {
    lifecycleSource: Extract<OnboardingLifecycleSource, "install" | "upgrade">;
    nowMs?: number;
    appSettings?: ServerAppSettings;
    allowOnboardingRearm?: boolean;
  },
): Promise<OnboardingLifecycleReconciliation> {
  try {
    return await withCommunityGoalMutationLease(redis, (mutationLease) =>
      reconcileOnboardingForLifecycleUnderLease(reddit, redis, {
        lifecycleSource,
        nowMs,
        appSettings,
        allowOnboardingRearm,
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

type LifecycleOptions = {
  lifecycleSource: Extract<OnboardingLifecycleSource, "install" | "upgrade">;
  nowMs: number;
  appSettings: ServerAppSettings;
  allowOnboardingRearm: boolean;
  mutationLease: CommunityGoalMutationLease;
};

type LifecycleWork = LifecycleOptions & {
  reddit: RedditClient;
  redis: RedisClient;
  previousGoal: OnboardingSubscriberGoalState | undefined;
  previousReminder: OnboardingReminderState | undefined;
};

type LifecycleHighlights = Awaited<
  ReturnType<typeof ensureExistingSubscriberGoalHighlighted>
>;

async function reconcileOnboardingForLifecycleUnderLease(
  reddit: RedditClient,
  redis: RedisClient,
  {
    lifecycleSource,
    nowMs,
    appSettings,
    allowOnboardingRearm,
    mutationLease,
  }: {
    lifecycleSource: Extract<OnboardingLifecycleSource, "install" | "upgrade">;
    nowMs: number;
    appSettings: ServerAppSettings;
    allowOnboardingRearm: boolean;
    mutationLease: CommunityGoalMutationLease;
  },
): Promise<OnboardingLifecycleReconciliation> {
  const goalLockToken = await acquireRedisLock(
    redis,
    onboardingSubscriberGoalLockKey,
    onboardingSubscriberGoalLockTtlMs,
    { nowMs },
  );
  if (!goalLockToken) {
    throw new Error(
      `Onboarding lifecycle state is currently locked: ${onboardingSubscriberGoalLockKey}`,
    );
  }
  try {
    if (!(await migrateOnboardingWarning(redis, nowMs, true)))
      return { status: "unchanged", reason: "legacy_workflow_in_progress" };
    let rawGoal = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    if (!hasOnboardingGoalFields(rawGoal)) {
      await initializeOnboardingSubscriberGoal(redis, {
        lifecycleSource,
        nowMs,
        migrationOnly: true,
        workflowLockHeld: true,
      });
      rawGoal = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    }
    const rawReminder = await readOnboardingWarningFields(redis, rawGoal);
    const previousGoal = parseOnboardingState(rawGoal);
    const previousReminder = parseOnboardingReminderState(rawReminder);
    if (
      (!previousGoal && hasOnboardingGoalFields(rawGoal)) ||
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

    const work = {
      reddit,
      redis,
      lifecycleSource,
      nowMs,
      appSettings,
      allowOnboardingRearm,
      mutationLease,
      previousGoal,
      previousReminder,
    };
    const submission = await reconcileLifecycleSubmission(work);
    if (submission) return submission;

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
      postId: highlighted.postId ?? "none",
      existingSource: highlighted.source ?? "none",
      validated: highlighted.validated,
      highlightedInspected: highlighted.highlightedInspected,
      searchInspected: highlighted.searchInspected,
      failed: highlighted.failed,
    });

    const completed = await reconcileLifecycleCompletedGoal(work, highlighted);
    if (completed) return completed;
    const existing = await reconcileLifecycleExistingGoal(work, highlighted);
    if (existing) return existing;

    if (previousReminder?.result === "delivery_unknown")
      return {
        status: "unchanged",
        reason: "warning_delivery_unknown_preserved",
      };
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

    if (!allowOnboardingRearm) {
      const reason = "onboarding_ineligible";
      logReconciliationDecision(
        lifecycleSource,
        "unchanged",
        reason,
        previousGoal,
        previousReminder,
      );
      return { status: "unchanged", reason };
    }

    return await rearmLifecycleOnboarding(work);
  } finally {
    await releaseRedisLock(
      redis,
      onboardingSubscriberGoalLockKey,
      goalLockToken,
    );
  }
}

async function reconcileLifecycleSubmission({
  redis,
  nowMs,
  previousGoal,
}: LifecycleWork): Promise<OnboardingLifecycleReconciliation | undefined> {
  if (previousGoal?.resultStatus === "submission_reconciliation_exhausted") {
    const rearmed = await rearmAutomaticGoalReconciliation(
      redis,
      previousGoal.operationId,
      nowMs,
      true,
    );
    if (!rearmed)
      return {
        status: "unchanged",
        reason: "legacy_ambiguous_submission_preserved",
      };
    await saveOnboardingState(redis, {
      ...previousGoal,
      status: "pending",
      nextRunAt: nowMs,
      resultStatus: "submission_reconciliation_pending",
    });
    return { status: "rearmed", operationId: previousGoal.operationId };
  }
  if (previousGoal?.resultStatus === "submission_reconciliation_pending") {
    return {
      status: "unchanged",
      reason: "submission_reconciliation_pending",
    };
  }
}

async function reconcileLifecycleCompletedGoal(
  {
    reddit,
    redis,
    nowMs,
    lifecycleSource,
    appSettings,
    mutationLease,
    previousGoal,
    previousReminder,
  }: LifecycleWork,
  highlighted: LifecycleHighlights,
): Promise<OnboardingLifecycleReconciliation | undefined> {
  if (
    highlighted.status === "completed" &&
    highlighted.postId &&
    highlighted.source &&
    highlighted.completedTime
  ) {
    const operationId = previousGoal?.operationId ?? createOperationId(nowMs);
    for (const supersededPostId of highlighted.supersededCompletedPostIds ??
      []) {
      await cancelAutoCreateNextGoal(redis, supersededPostId);
      logDiagnostic("info", "superseded_completed_goal_cancelled", {
        workflow: "onboarding_lifecycle",
        phase: "completed_goal_classification",
        lifecycleSource,
        sourcePostId: supersededPostId,
        authoritativePostId: highlighted.postId,
      });
    }
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
    await saveOnboardingState(
      redis,
      nextGoal,
      serializeLifecycleWarning(previousReminder, nextReminder),
    );
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
}

async function reconcileLifecycleExistingGoal(
  work: LifecycleWork,
  highlighted: LifecycleHighlights,
): Promise<OnboardingLifecycleReconciliation | undefined> {
  const { redis, nowMs, lifecycleSource, previousGoal, previousReminder } =
    work;
  if (
    highlighted.status !== "missing" &&
    highlighted.status !== "completed" &&
    highlighted.postId &&
    highlighted.source
  ) {
    await reconcileProtectedUpgrade(work, highlighted, highlighted.postId);
    const operationId = previousGoal?.operationId ?? createOperationId(nowMs);
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
    await saveOnboardingState(
      redis,
      nextGoal,
      serializeLifecycleWarning(previousReminder, nextReminder),
    );
    logDiagnostic("info", "onboarding_lifecycle_highlighted_goal_preserved", {
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
    });
    return {
      status: "existing",
      operationId,
      postId: highlighted.postId,
      existingSource: highlighted.source,
      highlightStatus:
        highlighted.status === "existing" ? "highlighted" : "not_highlighted",
    };
  }
}

function serializeLifecycleWarning(
  previous: OnboardingReminderState | undefined,
  next: OnboardingReminderState,
): Record<string, string> {
  return serializeOnboardingReminderState(
    previous?.result === "delivery_unknown" ? previous : next,
  );
}

async function rearmLifecycleOnboarding({
  reddit,
  redis,
  nowMs,
  lifecycleSource,
  previousGoal,
  previousReminder,
}: LifecycleWork): Promise<OnboardingLifecycleReconciliation> {
  let accountHealthy = true;
  if (lifecycleSource === "upgrade") {
    const subreddit = await reddit.getCurrentSubreddit();
    const accountHealth = await checkAppAccountHealth({
      reddit,
      redis,
      subredditName: subreddit.name,
      subredditId: subreddit.id,
      language: subreddit.language,
      notify: false,
      scheduleUnknownRetry: true,
      nowMs,
    });
    accountHealthy =
      accountHealth.healthy && accountHealth.status === "healthy";
  }
  const creationStaggerMinutes = selectOnboardingGoalStaggerMinutes();
  const reminderStaggerMinutes = selectOnboardingReminderStaggerMinutes();
  const operationId =
    previousGoal?.resultStatus === "retry_exhausted"
      ? previousGoal.operationId
      : createOperationId(nowMs);
  if (previousGoal) {
    if (previousGoal.operationId !== operationId)
      await resetAutomaticGoalPrerequisiteRetry(
        redis,
        previousGoal.operationId,
      );
    await beginAutomaticGoalRetryGeneration(redis, operationId);
  }
  const nextGoal: OnboardingSubscriberGoalState = {
    version: onboardingSubscriberGoalVersion,
    status: "awaiting_warning",
    armedAt: nowMs,
    lifecycleSource,
    creationStaggerMinutes,
    operationId,
    intent: "missing_goal",
    ...(!accountHealthy ? { pausedForAccountRecovery: true } : {}),
  };
  const nextReminder: OnboardingReminderState = {
    version: onboardingReminderVersion,
    status: "pending",
    armedAt: nowMs,
    nextRunAt: accountHealthy
      ? nowMs + reminderStaggerMinutes * 60 * 1000
      : nowMs + 5 * 60 * 1000,
    lifecycleSource,
    reminderStaggerMinutes,
  };
  await saveOnboardingState(
    redis,
    nextGoal,
    serializeOnboardingReminderState(nextReminder),
  );
  logDiagnostic("info", "onboarding_rearmed_after_missing_highlighted_goal", {
    workflow: "onboarding_lifecycle",
    phase: "rearm",
    lifecycleSource,
    previousGoalResult: previousGoal?.resultStatus ?? "none",
    previousReminderResult: previousReminder?.result ?? "none",
    operationId,
    armedAt: nowMs,
    creationStaggerMinutes,
    reminderStaggerMinutes,
    accountRecoveryPaused: !accountHealthy,
    reminderNextRunAt: nextReminder.nextRunAt,
    reminderNextRunAtIso: new Date(nextReminder.nextRunAt).toISOString(),
  });
  return { status: "rearmed", operationId };
}

async function reconcileProtectedUpgrade(
  {
    reddit,
    redis,
    nowMs,
    lifecycleSource,
    appSettings,
    mutationLease,
  }: LifecycleWork,
  highlighted: LifecycleHighlights,
  postId: string,
): Promise<void> {
  const compactSelected =
    highlighted.classification === "tiny" ||
    highlighted.classification === "cta";
  if (
    lifecycleSource === "upgrade" &&
    (compactSelected || highlighted.deferredCompletedGoal)
  ) {
    for (const supersededPostId of highlighted.supersededCompletedPostIds ??
      []) {
      await cancelAutoCreateNextGoal(redis, supersededPostId);
    }
    if (highlighted.deferredCompletedGoal) {
      const deferred = highlighted.deferredCompletedGoal;
      const recovery = await reconcileCompletedGoal({
        reddit,
        redis,
        appSettings,
        lifecycleSource,
        sourcePostId: deferred.postId,
        completedTime: deferred.completedTime,
        autoCreateNextGoal: deferred.autoCreateNextGoal,
        nowMs,
        mutationLease,
      });
      logDiagnostic("info", "upgrade_protected_successor_reconciled", {
        workflow: "onboarding_lifecycle",
        phase: "upgrade_classification",
        lifecycleSource,
        protectedPostId: highlighted.eligiblePostIds[0] ?? postId,
        sourcePostId: deferred.postId,
        outcome: recovery.outcome,
      });
    }
    if (compactSelected) {
      logDiagnostic("info", "upgrade_protected_experience_preserved", {
        workflow: "onboarding_lifecycle",
        phase: "upgrade_classification",
        lifecycleSource,
        postId: postId,
        classification: highlighted.classification,
      });
    }
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
