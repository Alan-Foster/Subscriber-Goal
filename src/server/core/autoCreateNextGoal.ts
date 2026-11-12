import type { ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import {
  autoCreateNextGoalSuccessorsKey,
  cancelAllAutoCreateNextGoals,
  cancelAutoCreateNextGoal,
  checkCompletionStatus,
  getAutoCreateNextGoalRunAt,
  getDueAutoCreateNextGoalPostIds,
  getSubGoalData,
  markAutoCreateNextGoalExhausted,
  markAutoCreateNextGoalReconciliationExhausted,
  recordAutoCreateNextGoalFailure,
  scheduleAutoCreateNextGoalReconciliation,
  postHeightSuffix,
  postKindSuffix,
  subscriberGoalsKey,
} from "../data/subGoalData";
import { getDefaultSubscriberGoal } from "../utils/numberUtils";
import {
  createSubscriberGoal,
  SubscriberGoalCreationOutcomeUnknownError,
} from "./createSubscriberGoal";
import { getSubGoalPostMessages } from "../../shared/subGoalPostI18n";
import {
  getTerminalRemovedByCategory,
  isMissingPostError,
} from "../utils/postStatus";
import { isLinkId } from "../types";
import {
  getPostUrl,
  notifyHighlightFailure,
} from "../utils/highlightFailureNotifications";
import { logDiagnostic } from "../../shared/diagnostics";
import { isCrosspostEligible } from "../utils/subredditSafety";
import {
  acquireCommunityGoalMutationLease,
  releaseCommunityGoalMutationLease,
  type CommunityGoalMutationLease,
} from "./communityGoalMutation";
import { retireSubscriberGoalPost } from "./postRetirement";
import { getSubscriberGoalCandidatePostIds } from "../data/subscriberGoalCandidates";
import { getAutomaticGoalEligibility } from "./automaticGoalEligibility";
import { checkAppAccountHealth } from "./appAccountHealth";
import {
  findLiveHighlightedSubscriberGoalCandidates,
  type LiveHighlightedSubscriberGoalCandidate,
} from "../data/liveSubscriberGoalHighlights";

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
      if (
        !sourceGoalData.goal ||
        !sourceGoalData.completedTime ||
        !sourceGoalData.autoCreateNextGoal
      ) {
        summary.skipped += 1;
        await cancelAutoCreateNextGoal(redis, sourcePostId);
        continue;
      }

      let sourceCreatedAtMs = 0;
      try {
        const sourcePost = await reddit.getPostById(sourcePostId);
        sourceCreatedAtMs = new Date(sourcePost.createdAt).getTime() || 0;
        const removedByCategory = getTerminalRemovedByCategory(sourcePost);
        if (removedByCategory) {
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

      const newerClassicGoal = await findNewerClassicGoal({
        reddit,
        redis,
        sourcePostId,
        sourceCreatedAtMs,
      });
      if (newerClassicGoal) {
        await redis.hSet(autoCreateNextGoalSuccessorsKey, {
          [sourcePostId]: newerClassicGoal,
        });
        await cancelAutoCreateNextGoal(redis, sourcePostId);
        summary.skipped += 1;
        continue;
      }

      const protectedPrimary = await findProtectedPrimaryGoal({
        reddit,
        redis,
        sourcePostId,
      });
      if (protectedPrimary) {
        await cancelAutoCreateNextGoal(redis, sourcePostId);
        summary.skipped += 1;
        logDiagnostic("info", "auto_create_goal_suppressed", {
          workflow: "auto_create_next_goal",
          phase: "protected_experience",
          postId: sourcePostId,
          protectedPostId: protectedPrimary,
          reason: "protected_primary_present",
        });
        continue;
      }

      const subreddit = await reddit.getCurrentSubreddit();
      const automaticEligibility = getAutomaticGoalEligibility(subreddit);
      if (!automaticEligibility.eligible) {
        await cancelAutoCreateNextGoal(redis, sourcePostId);
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
        summary.skipped += 1;
        logDiagnostic("info", "auto_create_goal_suppressed", {
          workflow: "auto_create_next_goal",
          phase: "permission_preflight",
          postId: sourcePostId,
          reason: "account_recovery_required",
        });
        continue;
      }

      // Redis remains an early duplicate-prevention signal, but Community
      // Highlights are the live authority immediately before automatic post
      // creation. Any failure in this check is handled by the outer retry path.
      const highlightedPrimary = await findLiveHighlightedPrimary({
        reddit,
        redis,
        subreddit,
        sourcePostId,
        nowMs,
        mutationLease,
      });
      if (highlightedPrimary) {
        if (highlightedPrimary.kind === "active_classic") {
          await redis.hSet(autoCreateNextGoalSuccessorsKey, {
            [sourcePostId]: highlightedPrimary.postId,
          });
        }
        await cancelAutoCreateNextGoal(redis, sourcePostId);
        summary.skipped += 1;
        logDiagnostic("info", "auto_create_goal_suppressed", {
          workflow: "auto_create_next_goal",
          phase: "live_highlight_primary",
          postId: sourcePostId,
          protectedPostId: highlightedPrimary.postId,
          reason: highlightedPrimary.kind,
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
          operationId: `auto-next:${sourcePostId}`,
          reconciliationContext: "automatic_successor",
          mutationLease,
          reconciliationNowMs: nowMs,
        },
      });
      if (creation.outcome === "superseded" || creation.outcome === "retired") {
        summary.skipped += 1;
        logDiagnostic("info", "auto_create_goal_recovery_stopped", {
          workflow: "auto_create_next_goal",
          phase: "creation_recovery",
          postId: creation.post.id,
          sourcePostId,
          outcome: creation.outcome,
          supersedingPostId: creation.supersedingPostId ?? "none",
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
          reorderOutcome: highlightResult.reorderOutcome,
        });
        await notifyHighlightFailure({
          reddit,
          subredditId: subreddit.id,
          subredditName: subreddit.name,
          postTitle: post.title,
          postUrl: getPostUrl(post),
          errorMessage: highlightResult.errorMessage,
          highlightResult,
          language: sourceGoalData.language,
        });
      }
      await redis.hSet(autoCreateNextGoalSuccessorsKey, {
        [sourcePostId]: post.id,
      });
      try {
        await cancelAllAutoCreateNextGoals(redis);
      } catch (cancelError) {
        logDiagnostic(
          "error",
          "auto_create_cleanup_failed",
          {
            workflow: "auto_create_next_goal",
            phase: "cancel_all",
            postId: sourcePostId,
          },
          cancelError,
        );
        try {
          await cancelAutoCreateNextGoal(redis, sourcePostId);
        } catch (sourceCancelError) {
          logDiagnostic(
            "error",
            "auto_create_cleanup_failed",
            {
              workflow: "auto_create_next_goal",
              phase: "cancel_source",
              postId: sourcePostId,
            },
            sourceCancelError,
          );
        }
      }
      summary.created += 1;
      break;
    } catch (error) {
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

type LiveHighlightedPrimary = {
  postId: `t3_${string}`;
  kind: "active_classic" | "protected_experience" | "ambiguous";
};

async function findLiveHighlightedPrimary({
  reddit,
  redis,
  subreddit,
  sourcePostId,
  nowMs,
  mutationLease,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  subreddit: Awaited<ReturnType<RedditClient["getCurrentSubreddit"]>>;
  sourcePostId: `t3_${string}`;
  nowMs: number;
  mutationLease: CommunityGoalMutationLease;
}): Promise<LiveHighlightedPrimary | undefined> {
  const candidates = await findLiveHighlightedSubscriberGoalCandidates({
    reddit,
    redis,
    nowMs,
    subreddit,
  });
  const blockers: Array<{
    candidate: LiveHighlightedSubscriberGoalCandidate;
    kind: LiveHighlightedPrimary["kind"];
  }> = [];

  for (const candidate of candidates) {
    if (candidate.postId === sourcePostId) {
      continue;
    }
    if (
      candidate.classification === "tiny" ||
      candidate.classification === "cta"
    ) {
      blockers.push({ candidate, kind: "protected_experience" });
      continue;
    }
    if (
      candidate.classification !== "classic" ||
      candidate.classificationConfidence === "ambiguous"
    ) {
      blockers.push({ candidate, kind: "ambiguous" });
      continue;
    }

    const goalData = await getSubGoalData(
      redis,
      candidate.postId,
      candidate.post.postData ?? candidate.post.customPostData,
    );
    if (!(goalData.goal > 0)) {
      blockers.push({ candidate, kind: "ambiguous" });
      continue;
    }

    let completedTime = goalData.completedTime;
    if (!completedTime && subreddit.numberOfSubscribers >= goalData.goal) {
      completedTime = await checkCompletionStatus(
        reddit,
        redis,
        candidate.postId,
        {
          now: () => nowMs,
          scheduleAutomaticSuccessor: false,
          automaticSuccessorSuppression: "auto_goal_reconciliation",
          mutationLease,
        },
      );
    }
    if (!completedTime) {
      blockers.push({ candidate, kind: "active_classic" });
    }
  }

  const selected = blockers.sort(
    (a, b) =>
      (b.candidate.createdAtMs ?? Number.NEGATIVE_INFINITY) -
        (a.candidate.createdAtMs ?? Number.NEGATIVE_INFINITY) ||
      a.candidate.discoveryOrder - b.candidate.discoveryOrder,
  )[0];
  return selected
    ? { postId: selected.candidate.postId, kind: selected.kind }
    : undefined;
}

async function findProtectedPrimaryGoal({
  reddit,
  redis,
  sourcePostId,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  sourcePostId: `t3_${string}`;
}): Promise<`t3_${string}` | undefined> {
  for (const candidateId of await getSubscriberGoalCandidatePostIds(redis)) {
    if (!isLinkId(candidateId) || candidateId === sourcePostId) continue;
    const [kind, height] = await redis.hMGet(subscriberGoalsKey, [
      `${candidateId}${postKindSuffix}`,
      `${candidateId}${postHeightSuffix}`,
    ]);
    if (
      kind !== "subscribe-only-v1" &&
      kind !== "cta-only-v1" &&
      height !== "tiny" &&
      height !== "cta"
    ) {
      continue;
    }
    try {
      const post = await reddit.getPostById(candidateId);
      if (!getTerminalRemovedByCategory(post)) return candidateId;
    } catch (error) {
      if (!isMissingPostError(error, candidateId)) throw error;
    }
  }
  return undefined;
}

async function findNewerClassicGoal({
  reddit,
  redis,
  sourcePostId,
  sourceCreatedAtMs,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  sourcePostId: `t3_${string}`;
  sourceCreatedAtMs: number;
}): Promise<`t3_${string}` | undefined> {
  let newest: { postId: `t3_${string}`; createdAtMs: number } | undefined;
  for (const candidateId of await getSubscriberGoalCandidatePostIds(redis)) {
    if (!isLinkId(candidateId) || candidateId === sourcePostId) continue;
    const [kind, height] = await redis.hMGet(subscriberGoalsKey, [
      `${candidateId}${postKindSuffix}`,
      `${candidateId}${postHeightSuffix}`,
    ]);
    if (
      kind !== "subscriber-goal-v1" ||
      (height !== "regular" && height !== "short")
    ) {
      continue;
    }
    const data = await getSubGoalData(redis, candidateId);
    if (!data.goal) continue;
    try {
      const post = await reddit.getPostById(candidateId);
      if (getTerminalRemovedByCategory(post)) continue;
      const createdAtMs = new Date(post.createdAt).getTime() || 0;
      if (
        createdAtMs > sourceCreatedAtMs &&
        (!newest || createdAtMs > newest.createdAtMs)
      ) {
        newest = { postId: candidateId, createdAtMs };
      }
    } catch (error) {
      // A transient lookup must not authorize creation of another goal.
      if (!isMissingPostError(error, candidateId)) throw error;
    }
  }
  return newest?.postId;
}
