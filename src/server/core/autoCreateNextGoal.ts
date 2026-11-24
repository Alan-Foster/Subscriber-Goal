import { ensureExistingSubscriberGoalHighlighted } from "./highlightReconciliation";
import {
  nextAutomaticGoalPrerequisiteRetry,
  resetAutomaticGoalPrerequisiteRetry,
  isAutomaticGoalPrerequisiteError,
  notifyAutomaticGoalExhausted,
} from "./automaticGoalRetry";
import type { ServerAppSettings } from "../settings";
import type { LinkId, RedditClient, RedisClient } from "../types";
import {
  autoCreateNextGoalSuccessorsKey,
  cancelAutoCreateNextGoal,
  getAutoCreateNextGoalRunAt,
  getDueAutoCreateNextGoalPostIds,
  getSubGoalData,
  markAutoCreateNextGoalExhausted,
  markAutoCreateNextGoalReconciliationExhausted,
  recordAutoCreateNextGoalFailure,
  scheduleAutoCreateNextGoalReconciliation,
} from "../data/subGoalData";
import type { HighlightResult } from "../utils/communityHighlights";
import { getDefaultSubscriberGoal } from "../utils/numberUtils";
import {
  createSubscriberGoal,
  getStoredTerminalSubscriberGoalCreation,
  SubscriberGoalCreationInProgressError,
  SubscriberGoalCreationOutcomeUnknownError,
} from "./createSubscriberGoal";
import { getSubGoalPostMessages } from "../../shared/subGoalPostI18n";
import {
  getPostAvailability,
  PostTemporarilyUnavailableError,
  temporarilyRemovedPostRecheckDelayMs,
  isMissingPostError,
} from "../utils/postStatus";
import { isLinkId } from "../types";
import {
  getPostUrl,
  notifyHighlightFailure,
  notifyHighlightFailureIncident,
} from "../utils/highlightFailureNotifications";
import { logDiagnostic } from "../../shared/diagnostics";
import { isCrosspostEligible } from "../utils/subredditSafety";
import {
  acquireCommunityGoalMutationLease,
  releaseCommunityGoalMutationLease,
  type CommunityGoalMutationLease,
} from "./communityGoalMutation";
import { retireSubscriberGoalPost } from "./postRetirement";
import {
  getAutomaticGoalEligibility,
  isAutomaticGoalEligibilityUncertain,
} from "./automaticGoalEligibility";
import { checkAppAccountHealth } from "./appAccountHealth";

export type AutoCreateNextGoalSummary = {
  due: number;
  created: number;
  skipped: number;
  failed: number;
  rescheduled: number;
  exhausted: number;
  unresolved?: number;
  reconciliationRescheduled?: number;
  reconciliationExhausted?: number;
};

export const autoCreateNextGoalLockKeyPrefix = "auto_create_next_goal_v1_lock";
export { autoCreateNextGoalSuccessorsKey } from "../data/subGoalData";
const terminalRecoveryInventoryDelayMs = 60 * 1000;
const protectedSurfaceRecheckDelayMs = 60 * 60 * 1000;
const closedSubredditRecheckDelayMs = 12 * 60 * 60 * 1000;
const creationContentionRecheckDelayMs = 5 * 60 * 1000;
const onboardingSubscriberGoalStateKey = "onboarding_subscriber_goal_v4_state";

export async function processDueAutoCreateNextGoals({
  reddit,
  redis,
  appSettings,
  nowMs = Date.now(),
  mutationLease: existingMutationLease,
  canStart,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  nowMs?: number;
  mutationLease?: CommunityGoalMutationLease;
  canStart?: () => boolean;
}): Promise<AutoCreateNextGoalSummary> {
  const duePostIds = await getDueAutoCreateNextGoalPostIds(redis, nowMs);
  const summary: AutoCreateNextGoalSummary = {
    due: duePostIds.length,
    created: 0,
    skipped: 0,
    failed: 0,
    rescheduled: 0,
    exhausted: 0,
  };

  const run = { reddit, redis, appSettings, nowMs, summary, canStart };
  for (const sourcePostId of duePostIds) {
    if (canStart && !canStart()) break;
    const outcome = await processDueSource(
      run,
      sourcePostId,
      existingMutationLease,
    );
    if (outcome === "stop") break;
  }
  return summary;
}

type AutoGoalRun = {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  nowMs: number;
  summary: AutoCreateNextGoalSummary;
  canStart: (() => boolean) | undefined;
};

type AutoGoalAttempt = AutoGoalRun & {
  sourcePostId: string;
  operationId: string;
  language?: unknown;
  scheduledAt?: number;
  creationAttempted: boolean;
  creationFinished: boolean;
};

type SourceGoalData = Awaited<ReturnType<typeof getSubGoalData>>;
type CurrentSubreddit = Awaited<
  ReturnType<RedditClient["getCurrentSubreddit"]>
>;
type GoalCreation = Awaited<ReturnType<typeof createSubscriberGoal>>;
type BatchOutcome = "continue" | "stop";

async function processDueSource(
  run: AutoGoalRun,
  sourcePostId: string,
  existingMutationLease: CommunityGoalMutationLease | undefined,
): Promise<BatchOutcome> {
  const { redis, nowMs, summary } = run;
  const lockKey = `${autoCreateNextGoalLockKeyPrefix}:${sourcePostId}`;
  const attempt: AutoGoalAttempt = {
    ...run,
    sourcePostId,
    operationId: `auto-next:${sourcePostId}`,
    creationAttempted: false,
    creationFinished: false,
  };
  let mutationLease: CommunityGoalMutationLease | undefined;
  let acquiredMutationLease = false;
  try {
    if (!isLinkId(sourcePostId)) {
      summary.skipped += 1;
      await cancelAutoCreateNextGoal(redis, sourcePostId);
      console.info(
        `[autoCreateNextGoal] skipping inactive source post: sourcePostId=${sourcePostId} reason=invalid_post_id`,
      );
      return "continue";
    }

    mutationLease =
      existingMutationLease ??
      (await acquireCommunityGoalMutationLease(redis, nowMs));
    if (!mutationLease) {
      // Leave scheduler state untouched so the same due work is retried.
      summary.skipped += 1;
      return "continue";
    }
    acquiredMutationLease = existingMutationLease === undefined;

    const currentRunAt = await getAutoCreateNextGoalRunAt(redis, sourcePostId);
    if (currentRunAt === undefined || currentRunAt > nowMs) {
      // The initial due list is only a snapshot. Another serialized worker
      // may have removed the source or moved it into retry backoff.
      summary.skipped += 1;
      return "continue";
    }
    attempt.scheduledAt = currentRunAt;

    // A pre-upgrade worker may still own the old source lock. New workers
    // serialize through the community lease and the creation operation lock.
    if (await redis.get(lockKey)) {
      summary.skipped += 1;
      return "continue";
    }
    return await processLeasedSource(attempt, sourcePostId, mutationLease);
  } catch (error) {
    if (error instanceof PostTemporarilyUnavailableError) {
      await pauseRemovedSource(attempt, error);
    } else if (error instanceof SubscriberGoalCreationOutcomeUnknownError) {
      await recordUnresolvedSubmission(attempt, error);
    } else if (
      error instanceof SubscriberGoalCreationInProgressError ||
      (error instanceof Error &&
        error.cause instanceof SubscriberGoalCreationInProgressError)
    ) {
      await rescheduleExpectedWait(attempt, creationContentionRecheckDelayMs);
      summary.skipped += 1;
    } else {
      logDiagnostic(
        "error",
        "auto_create_goal_failed",
        {
          workflow: "auto_create_next_goal",
          phase: "create",
          postId: sourcePostId,
        },
        error,
      );
      await retryAfterAutoGoalFailure(attempt, error);
    }
    return "continue";
  } finally {
    if (mutationLease && acquiredMutationLease) {
      await releaseCommunityGoalMutationLease(redis, mutationLease);
    }
  }
}

async function processLeasedSource(
  attempt: AutoGoalAttempt,
  sourcePostId: LinkId,
  mutationLease: CommunityGoalMutationLease,
): Promise<BatchOutcome> {
  const sourceGoalData = await loadCompletedSourceGoal(attempt);
  if (!sourceGoalData) return "continue";
  const subreddit = await checkAutoGoalPrerequisites(attempt);
  if (!subreddit) return "continue";
  if (!(await checkSourcePostAvailability(attempt, sourcePostId)))
    return "continue";
  if (!(await checkSuccessorInventory(attempt, mutationLease)))
    return "continue";

  const creation = await createSuccessor(
    attempt,
    mutationLease,
    sourceGoalData,
    subreddit,
  );
  await persistSuccessor(attempt, sourceGoalData, subreddit, creation);
  return "stop";
}

async function loadCompletedSourceGoal(
  attempt: AutoGoalAttempt,
): Promise<SourceGoalData | undefined> {
  const { redis, sourcePostId, summary } = attempt;
  const [onboardingIntent, replacementSourcePostId, onboardingStatus] =
    await redis.hMGet(onboardingSubscriberGoalStateKey, [
      "intent",
      "replacementSourcePostId",
      "status",
    ]);
  if (
    onboardingIntent === "orphaned_completed_goal" &&
    replacementSourcePostId === sourcePostId &&
    onboardingStatus !== "complete"
  ) {
    await cancelAutoCreateNextGoal(redis, sourcePostId);
    summary.skipped += 1;
    logDiagnostic("info", "auto_create_goal_suppressed", {
      workflow: "auto_create_next_goal",
      phase: "onboarding_takeover",
      postId: sourcePostId,
      reason: "orphaned_goal_onboarding_active",
    });
    return;
  }

  const existingSuccessor = await redis.hGet(
    autoCreateNextGoalSuccessorsKey,
    sourcePostId,
  );
  if (existingSuccessor && isLinkId(existingSuccessor)) {
    summary.skipped += 1;
    await cancelAutoCreateNextGoal(redis, sourcePostId);
    return;
  }

  const sourceGoalData = await getSubGoalData(redis, sourcePostId);
  attempt.language = sourceGoalData.language;
  if (!sourceGoalData.goal || !sourceGoalData.completedTime) {
    summary.skipped += 1;
    await cancelAutoCreateNextGoal(redis, sourcePostId);
    return;
  }
  return sourceGoalData;
}

async function checkAutoGoalPrerequisites(
  attempt: AutoGoalAttempt,
): Promise<CurrentSubreddit | undefined> {
  const { reddit, redis, sourcePostId, nowMs, summary } = attempt;
  const subreddit = await reddit.getCurrentSubreddit();
  const automaticEligibility = getAutomaticGoalEligibility(subreddit);
  if (!automaticEligibility.eligible) {
    let disposition: "cancelled" | "rescheduled" | "exhausted";
    if (isAutomaticGoalEligibilityUncertain(automaticEligibility)) {
      disposition = await deferPrerequisite(attempt);
    } else if (automaticEligibility.subredditType === "user") {
      // A profile surface cannot reopen as a public subreddit.
      await cancelAutoCreateNextGoal(redis, sourcePostId);
      disposition = "cancelled";
    } else {
      await rescheduleExpectedWait(attempt, closedSubredditRecheckDelayMs);
      disposition = "rescheduled";
    }
    summary.skipped += 1;
    logDiagnostic("info", "auto_create_goal_suppressed", {
      workflow: "auto_create_next_goal",
      phase: "eligibility",
      postId: sourcePostId,
      reason: automaticEligibility.reason,
      subredditType: automaticEligibility.subredditType,
      disposition,
    });
    return;
  }
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
  if (!accountHealth.healthy || accountHealth.status !== "healthy") {
    await deferPrerequisite(attempt);
    summary.skipped += 1;
    logDiagnostic("info", "auto_create_goal_suppressed", {
      workflow: "auto_create_next_goal",
      phase: "permission_preflight",
      postId: sourcePostId,
      reason: "account_recovery_required",
    });
    return;
  }
  return subreddit;
}

async function checkSourcePostAvailability(
  attempt: AutoGoalAttempt,
  sourcePostId: LinkId,
): Promise<boolean> {
  const { reddit, redis, nowMs, summary } = attempt;
  try {
    const sourcePost = await reddit.getPostById(sourcePostId);
    const availability = getPostAvailability(sourcePost);
    if (availability.status === "temporarily_removed") {
      throw new PostTemporarilyUnavailableError(
        sourcePostId,
        availability.category,
      );
    }
    if (availability.status === "terminal") {
      const removedByCategory = availability.category;
      summary.skipped += 1;
      await retireSubscriberGoalPost(
        redis,
        sourcePostId,
        `removedByCategory:${removedByCategory}`,
        nowMs,
      );
      console.info(
        `[autoCreateNextGoal] skipping inactive source post: sourcePostId=${sourcePostId} reason=removedByCategory:${removedByCategory}`,
      );
      return false;
    }
  } catch (sourcePostError) {
    if (isMissingPostError(sourcePostError, sourcePostId)) {
      summary.skipped += 1;
      await retireSubscriberGoalPost(
        redis,
        sourcePostId,
        "confirmed_missing_auto_successor_source",
        nowMs,
      );
      console.info(
        `[autoCreateNextGoal] skipping inactive source post: sourcePostId=${sourcePostId} reason=missing_post`,
      );
      return false;
    }
    throw sourcePostError;
  }
  return true;
}

async function checkSuccessorInventory(
  attempt: AutoGoalAttempt,
  mutationLease: CommunityGoalMutationLease,
): Promise<boolean> {
  const { reddit, redis, nowMs, sourcePostId, summary } = attempt;
  // Reuse onboarding/highlight repair's complete, bounded inventory. It
  // reconciles classic goals at/above target, chooses a single app pin,
  // and maps completed sources to an existing active classic.
  // Unhighlighted posts still participate in this decision.
  let activeInventory: Awaited<
    ReturnType<typeof ensureExistingSubscriberGoalHighlighted>
  >;
  try {
    activeInventory = await ensureExistingSubscriberGoalHighlighted({
      reddit,
      redis,
      nowMs,
      reconciliationContext: "repair",
      mutationLease,
    });
  } catch (error) {
    // An uncertain inventory must never authorize a post or consume the
    // finite submission retry budget. Keep the original source pending.
    await deferPrerequisite(attempt);
    summary.failed += 1;
    logDiagnostic(
      "warn",
      "auto_create_inventory_retry_scheduled",
      {
        workflow: "auto_create_next_goal",
        phase: "active_inventory",
        postId: sourcePostId,
      },
      error,
    );
    return false;
  }
  if (await hasRecordedSuccessorOrTerminalCreation(attempt)) return false;

  const unresolvedAmbiguousSurface =
    (activeInventory.status === "existing" ||
      activeInventory.status === "existing_not_highlighted") &&
    activeInventory.classification === "ambiguous" &&
    activeInventory.postId;
  if (
    activeInventory.eligiblePostIds.length > 0 ||
    unresolvedAmbiguousSurface
  ) {
    // Tiny/CTA surfaces do not become a classic successor mapping. Keep
    // the original completed source pending so removal/retirement of the
    // blocking surface resumes the already-overdue work.
    await rescheduleExpectedWait(attempt, protectedSurfaceRecheckDelayMs);
    summary.skipped += 1;
    logDiagnostic("info", "auto_create_goal_suppressed", {
      workflow: "auto_create_next_goal",
      phase: "active_inventory",
      postId: sourcePostId,
      protectedPostId:
        activeInventory.eligiblePostIds[0] ?? unresolvedAmbiguousSurface!,
      reason: unresolvedAmbiguousSurface
        ? "ambiguous_primary_present"
        : "protected_primary_present",
    });
    return false;
  }
  return true;
}

async function hasRecordedSuccessorOrTerminalCreation(
  attempt: AutoGoalAttempt,
): Promise<boolean> {
  const { redis, sourcePostId, operationId, summary } = attempt;
  const reconciledSuccessor = await redis.hGet(
    autoCreateNextGoalSuccessorsKey,
    sourcePostId,
  );
  if (reconciledSuccessor && isLinkId(reconciledSuccessor)) {
    await cancelAutoCreateNextGoal(redis, sourcePostId);
    summary.skipped += 1;
    logDiagnostic("info", "auto_create_goal_suppressed", {
      workflow: "auto_create_next_goal",
      phase: "active_inventory",
      postId: sourcePostId,
      protectedPostId: reconciledSuccessor,
      reason: "active_classic_present",
    });
    return true;
  }
  const storedTerminal = await getStoredTerminalSubscriberGoalCreation(
    redis,
    operationId,
  );
  if (storedTerminal) {
    await resetAutomaticGoalPrerequisiteRetry(redis, operationId);
    await cancelAutoCreateNextGoal(redis, sourcePostId);
    summary.skipped += 1;
    logDiagnostic("info", "auto_create_goal_recovery_stopped", {
      workflow: "auto_create_next_goal",
      phase: "creation_recovery",
      postId: storedTerminal.post.id,
      sourcePostId,
      outcome: storedTerminal.outcome,
      supersedingPostId: storedTerminal.supersedingPostId ?? "none",
      disposition: "source_cancelled",
    });
    return true;
  }
  return false;
}

async function createSuccessor(
  attempt: AutoGoalAttempt,
  mutationLease: CommunityGoalMutationLease,
  sourceGoalData: SourceGoalData,
  subreddit: CurrentSubreddit,
): Promise<GoalCreation> {
  const { reddit, redis, appSettings, operationId, nowMs } = attempt;
  const subredditDisplayName =
    sourceGoalData.subredditDisplayName ?? subreddit.name;
  const messages = getSubGoalPostMessages(sourceGoalData.language);
  const crosspost = isCrosspostEligible(subreddit, appSettings.promoSubreddit);

  attempt.creationAttempted = true;
  const creation = await createSubscriberGoal({
    reddit,
    redis,
    appSettings,
    options: {
      title: messages.defaultPostTitle({
        subredditName: subredditDisplayName,
      }),
      goal: getDefaultSubscriberGoal(subreddit.numberOfSubscribers),
      subredditDisplayName,
      crosspost,
      colorTheme: sourceGoalData.colorTheme,
      postHeight: sourceGoalData.postHeight,
      autoCreateNextGoal: true,
      language: sourceGoalData.language,
      afterSubscribeAction: sourceGoalData.afterSubscribeAction,
      ...(sourceGoalData.afterSubscribePreset
        ? { afterSubscribePreset: sourceGoalData.afterSubscribePreset }
        : {}),
      cancelPendingAutoCreateGoals: false,
      automaticPermissionCheck: true,
      operationId,
      reconciliationContext: "automatic_successor",
      mutationLease,
      reconciliationNowMs: nowMs,
      ...(attempt.canStart
        ? { canStartSubmissionReconciliation: attempt.canStart }
        : {}),
    },
  });
  attempt.creationFinished = true;
  return creation;
}

async function persistSuccessor(
  attempt: AutoGoalAttempt,
  sourceGoalData: SourceGoalData,
  subreddit: CurrentSubreddit,
  creation: GoalCreation,
): Promise<void> {
  const { redis, sourcePostId, operationId, nowMs, summary } = attempt;
  await resetAutomaticGoalPrerequisiteRetry(redis, operationId);
  if (creation.outcome === "superseded" || creation.outcome === "retired") {
    // Give inventory one more chance to adopt an active successor.
    await scheduleAutoCreateNextGoalReconciliation(
      redis,
      sourcePostId,
      nowMs + terminalRecoveryInventoryDelayMs,
    );
    summary.skipped += 1;
    summary.rescheduled += 1;
    logDiagnostic("info", "auto_create_goal_recovery_stopped", {
      workflow: "auto_create_next_goal",
      phase: "creation_recovery",
      postId: creation.post.id,
      sourcePostId,
      outcome: creation.outcome,
      supersedingPostId: creation.supersedingPostId ?? "none",
      disposition: "inventory_recheck_scheduled",
    });
    return;
  }
  const { post, highlightResult } = creation;
  if (highlightResult.issues.length > 0) {
    await reportDegradedSuccessorHighlight(
      attempt,
      sourceGoalData,
      subreddit,
      post,
      highlightResult,
    );
  }
  await redis.hSet(autoCreateNextGoalSuccessorsKey, {
    [sourcePostId]: post.id,
  });
  try {
    await cancelAutoCreateNextGoal(redis, sourcePostId);
  } catch (cancelError) {
    logDiagnostic(
      "error",
      "auto_create_cleanup_failed",
      {
        workflow: "auto_create_next_goal",
        phase: "cancel_source",
        postId: sourcePostId,
      },
      cancelError,
    );
  }
  summary.created += 1;
  return;
}

async function reportDegradedSuccessorHighlight(
  attempt: AutoGoalAttempt,
  sourceGoalData: SourceGoalData,
  subreddit: CurrentSubreddit,
  post: GoalCreation["post"],
  highlightResult: HighlightResult,
): Promise<void> {
  const { reddit, redis, nowMs } = attempt;
  logDiagnostic("warn", "auto_create_goal_degraded", {
    workflow: "auto_create_next_goal",
    phase: "highlight",
    postId: post.id,
    failureCategories: highlightResult.issues
      .map(({ category }) => category)
      .join(","),
    capacityOutcome: highlightResult.capacityOutcome,
    cleanupOutcome: highlightResult.cleanupOutcome,
    rollbackOutcome: highlightResult.rollbackOutcome,
  });
  const notification = {
    reddit,
    subredditId: subreddit.id,
    subredditName: subreddit.name,
    postTitle: post.title,
    postUrl: getPostUrl(post),
    errorMessage: highlightResult.errorMessage,
    highlightResult,
    language: sourceGoalData.language,
  };
  if (
    highlightResult.issues.some(({ category }) => category === "permission")
  ) {
    await notifyHighlightFailureIncident({
      ...notification,
      redis,
      postId: post.id,
      result: highlightResult,
      nowMs,
    });
  } else {
    await notifyHighlightFailure(notification);
  }
}

async function pauseRemovedSource(
  attempt: AutoGoalAttempt,
  error: PostTemporarilyUnavailableError,
): Promise<void> {
  const { sourcePostId, summary } = attempt;
  await rescheduleExpectedWait(attempt, temporarilyRemovedPostRecheckDelayMs);
  summary.skipped += 1;
  logDiagnostic("info", "auto_create_goal_post_paused", {
    workflow: "auto_create_next_goal",
    phase: "post_availability",
    postId: error.postId,
    sourcePostId,
    category: error.category ?? "unknown",
  });
}

async function rescheduleExpectedWait(
  { redis, operationId, sourcePostId, nowMs, summary }: AutoGoalAttempt,
  delayMs: number,
): Promise<void> {
  await resetAutomaticGoalPrerequisiteRetry(redis, operationId);
  await scheduleAutoCreateNextGoalReconciliation(
    redis,
    sourcePostId,
    nowMs + delayMs,
  );
  summary.rescheduled += 1;
}

async function retryAfterAutoGoalFailure(
  attempt: AutoGoalAttempt,
  error: unknown,
): Promise<void> {
  const {
    reddit,
    redis,
    nowMs,
    sourcePostId,
    operationId,
    summary,
    language,
    creationAttempted,
    creationFinished,
  } = attempt;
  summary.failed += 1;
  if (
    !creationAttempted ||
    creationFinished ||
    isAutomaticGoalPrerequisiteError(error)
  ) {
    await deferPrerequisite(attempt);
    return;
  }
  // A submission failure follows successful prerequisite checks.
  await resetAutomaticGoalPrerequisiteRetry(redis, operationId);
  const retry = await recordAutoCreateNextGoalFailure(
    redis,
    sourcePostId,
    nowMs,
  );
  if (retry.retryAt !== null) {
    summary.rescheduled += 1;
    logDiagnostic(
      "warn",
      "auto_create_goal_retry_scheduled",
      {
        workflow: "auto_create_next_goal",
        phase: "retry",
        postId: sourcePostId,
        failureCount: retry.failureCount,
      },
      error,
    );
  } else {
    summary.exhausted += 1;
    await markAutoCreateNextGoalExhausted(
      redis,
      sourcePostId,
      retry.failureCount,
    );
    await notifyAutomaticGoalExhausted({
      reddit,
      redis,
      operationId,
      unresolved: false,
      language,
    });
    logDiagnostic(
      "error",
      "auto_create_goal_retries_exhausted",
      {
        workflow: "auto_create_next_goal",
        phase: "terminal",
        postId: sourcePostId,
        failureCount: retry.failureCount,
      },
      error,
    );
  }
}

async function recordUnresolvedSubmission(
  attempt: AutoGoalAttempt,
  error: SubscriberGoalCreationOutcomeUnknownError,
): Promise<void> {
  const { reddit, redis, sourcePostId, operationId, summary, language } =
    attempt;
  await resetAutomaticGoalPrerequisiteRetry(redis, operationId);
  summary.unresolved = (summary.unresolved ?? 0) + 1;
  if (
    error.reconciliationStatus === "pending" &&
    error.reconciliationNextAt !== undefined
  ) {
    await scheduleAutoCreateNextGoalReconciliation(
      redis,
      sourcePostId,
      error.reconciliationNextAt,
    );
    summary.reconciliationRescheduled =
      (summary.reconciliationRescheduled ?? 0) + 1;
  } else {
    await markAutoCreateNextGoalReconciliationExhausted(
      redis,
      sourcePostId,
      operationId,
    );
    await notifyAutomaticGoalExhausted({
      reddit,
      redis,
      operationId,
      unresolved: true,
      language,
    });
    summary.reconciliationExhausted =
      (summary.reconciliationExhausted ?? 0) + 1;
  }
  logDiagnostic("warn", "auto_create_goal_submission_unresolved", {
    workflow: "auto_create_next_goal",
    phase: "submission_reconciliation",
    postId: sourcePostId,
    operationId,
    reconciliationStatus: error.reconciliationStatus,
    reconciliationAttempts: error.reconciliationAttempts,
    reconciliationNextAt: error.reconciliationNextAt ?? "none",
  });
}

async function deferPrerequisite(
  attempt: AutoGoalAttempt,
): Promise<"rescheduled" | "exhausted"> {
  const { reddit, redis, nowMs, sourcePostId, operationId, summary, language } =
    attempt;
  const retry = await nextAutomaticGoalPrerequisiteRetry(
    redis,
    operationId,
    nowMs,
    attempt.scheduledAt,
  );
  if (retry.retryAt === null) {
    await markAutoCreateNextGoalExhausted(redis, sourcePostId, retry.attempts);
    summary.exhausted += 1;
    logDiagnostic("error", "auto_create_goal_prerequisites_exhausted", {
      workflow: "auto_create_next_goal",
      phase: "terminal",
      operationId,
      postId: sourcePostId,
      attempts: retry.attempts,
    });
    await notifyAutomaticGoalExhausted({
      reddit,
      redis,
      operationId,
      unresolved: false,
      language,
    });
    await resetAutomaticGoalPrerequisiteRetry(redis, operationId);
    return "exhausted";
  }
  await scheduleAutoCreateNextGoalReconciliation(
    redis,
    sourcePostId,
    retry.retryAt,
  );
  summary.rescheduled += 1;
  return "rescheduled";
}
