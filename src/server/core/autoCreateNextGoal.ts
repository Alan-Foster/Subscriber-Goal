import {
  nextAutomaticGoalPrerequisiteRetry,
  resetAutomaticGoalPrerequisiteRetry,
  isAutomaticGoalPrerequisiteError,
  notifyAutomaticGoalExhausted,
} from "./automaticGoalRetry";
import type { ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
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
import { getDefaultSubscriberGoal } from "../utils/numberUtils";
import {
  createSubscriberGoal,
  getStoredTerminalSubscriberGoalCreation,
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
const autoCreateNextGoalLockTtlMs = 15 * 60 * 1000;
const terminalRecoveryInventoryDelayMs = 60 * 1000;
const protectedSurfaceRecheckDelayMs = 60 * 60 * 1000;
const onboardingSubscriberGoalStateKey = "onboarding_subscriber_goal_v4_state";

export async function processDueAutoCreateNextGoals({
  reddit,
  redis,
  appSettings,
  nowMs = Date.now(),
  mutationLease: existingMutationLease,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  nowMs?: number;
  mutationLease?: CommunityGoalMutationLease;
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

  for (const sourcePostId of duePostIds) {
    const lockKey = `${autoCreateNextGoalLockKeyPrefix}:${sourcePostId}`;
    const lockToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
    const operationId = `auto-next:${sourcePostId}`;
    let language: unknown;
    const deferPrerequisite = async (): Promise<void> => {
      const retry = await nextAutomaticGoalPrerequisiteRetry(
        redis,
        operationId,
        nowMs,
      );
      if (retry.retryAt === null) {
        await markAutoCreateNextGoalExhausted(
          redis,
          sourcePostId,
          retry.attempts,
        );
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
      } else {
        await scheduleAutoCreateNextGoalReconciliation(
          redis,
          sourcePostId,
          retry.retryAt,
        );
        summary.rescheduled += 1;
      }
    };
    let creationAttempted = false;
    let creationFinished = false;
    let acquired = false;
    let mutationLease: CommunityGoalMutationLease | undefined;
    let acquiredMutationLease = false;
    try {
      if (!isLinkId(sourcePostId)) {
        summary.skipped += 1;
        await cancelAutoCreateNextGoal(redis, sourcePostId);
        console.info(
          `[autoCreateNextGoal] skipping inactive source post: sourcePostId=${sourcePostId} reason=invalid_post_id`,
        );
        continue;
      }

      mutationLease =
        existingMutationLease ??
        (await acquireCommunityGoalMutationLease(redis, nowMs));
      if (!mutationLease) {
        // Leave scheduler state untouched so the same due work is retried.
        summary.skipped += 1;
        continue;
      }
      acquiredMutationLease = existingMutationLease === undefined;

      const currentRunAt = await getAutoCreateNextGoalRunAt(
        redis,
        sourcePostId,
      );
      if (currentRunAt === undefined || currentRunAt > nowMs) {
        // The initial due list is only a snapshot. Another serialized worker
        // may have removed the source or moved it into retry backoff.
        summary.skipped += 1;
        continue;
      }

      await redis.set(lockKey, lockToken, {
        nx: true,
        expiration: new Date(nowMs + autoCreateNextGoalLockTtlMs),
      });
      acquired = (await redis.get(lockKey)) === lockToken;
      if (!acquired) {
        summary.skipped += 1;
        continue;
      }

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
        continue;
      }

      const existingSuccessor = await redis.hGet(
        autoCreateNextGoalSuccessorsKey,
        sourcePostId,
      );
      if (existingSuccessor && isLinkId(existingSuccessor)) {
        summary.skipped += 1;
        await cancelAutoCreateNextGoal(redis, sourcePostId);
        continue;
      }

      const sourceGoalData = await getSubGoalData(redis, sourcePostId);
      language = sourceGoalData.language;
      if (!sourceGoalData.goal || !sourceGoalData.completedTime) {
        summary.skipped += 1;
        await cancelAutoCreateNextGoal(redis, sourcePostId);
        continue;
      }

      const subreddit = await reddit.getCurrentSubreddit();
      const automaticEligibility = getAutomaticGoalEligibility(subreddit);
      if (!automaticEligibility.eligible) {
        if (isAutomaticGoalEligibilityUncertain(automaticEligibility)) {
          await deferPrerequisite();
        } else {
          await cancelAutoCreateNextGoal(redis, sourcePostId);
        }
        summary.skipped += 1;
        logDiagnostic("info", "auto_create_goal_suppressed", {
          workflow: "auto_create_next_goal",
          phase: "eligibility",
          postId: sourcePostId,
          reason: automaticEligibility.reason,
        });
        continue;
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
        await deferPrerequisite();
        summary.skipped += 1;
        logDiagnostic("info", "auto_create_goal_suppressed", {
          workflow: "auto_create_next_goal",
          phase: "permission_preflight",
          postId: sourcePostId,
          reason: "account_recovery_required",
        });
        continue;
      }

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
          continue;
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
          continue;
        }
        throw sourcePostError;
      }

      // Reuse onboarding/highlight repair's complete, bounded inventory. It
      // reconciles classic goals at/above target, chooses a single app pin,
      // and maps completed sources to an existing active classic.
      // Unhighlighted posts still participate in this decision.
      // Load lazily because onboarding reconciliation itself depends on the
      // successor worker; eager imports would create an initialization cycle.
      let activeInventory: Awaited<
        ReturnType<
          (typeof import("./onboardingSubscriberGoal"))["ensureExistingSubscriberGoalHighlighted"]
        >
      >;
      try {
        const { ensureExistingSubscriberGoalHighlighted } =
          await import("./onboardingSubscriberGoal");
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
        await deferPrerequisite();
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
        continue;
      }
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
        continue;
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
        continue;
      }
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
        await scheduleAutoCreateNextGoalReconciliation(
          redis,
          sourcePostId,
          nowMs + protectedSurfaceRecheckDelayMs,
        );
        summary.skipped += 1;
        summary.rescheduled += 1;
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
        continue;
      }

      const subredditDisplayName =
        sourceGoalData.subredditDisplayName ?? subreddit.name;
      const messages = getSubGoalPostMessages(sourceGoalData.language);
      const crosspost = isCrosspostEligible(
        subreddit,
        appSettings.promoSubreddit,
      );

      creationAttempted = true;
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
        },
      });
      creationFinished = true;
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
        break;
      }
      const { post, highlightResult } = creation;
      if (highlightResult.issues.length > 0) {
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
          highlightResult.issues.some(
            ({ category }) => category === "permission",
          )
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
      break;
    } catch (error) {
      if (error instanceof PostTemporarilyUnavailableError) {
        await scheduleAutoCreateNextGoalReconciliation(
          redis,
          sourcePostId,
          nowMs + temporarilyRemovedPostRecheckDelayMs,
        );
        summary.skipped += 1;
        summary.rescheduled += 1;
        logDiagnostic("info", "auto_create_goal_post_paused", {
          workflow: "auto_create_next_goal",
          phase: "post_availability",
          postId: error.postId,
          sourcePostId,
          category: error.category ?? "unknown",
        });
        continue;
      }
      if (error instanceof SubscriberGoalCreationOutcomeUnknownError) {
        summary.unresolved = (summary.unresolved ?? 0) + 1;
        const operationId = `auto-next:${sourcePostId}`;
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
        continue;
      }
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
      summary.failed += 1;
      if (
        !creationAttempted ||
        creationFinished ||
        isAutomaticGoalPrerequisiteError(error)
      ) {
        await deferPrerequisite();
        continue;
      }
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
    } finally {
      if (acquired && (await redis.get(lockKey)) === lockToken) {
        await redis.del(lockKey);
      }
      if (mutationLease && acquiredMutationLease) {
        await releaseCommunityGoalMutationLease(redis, mutationLease);
      }
    }
  }

  return summary;
}
