import { context, reddit, redis, scheduler } from "@devvit/web/server";
import {
  autoCreateNextGoalSuccessorsKey,
  cancelAutoCreateNextGoal,
  checkCompletionStatus,
  getSubGoalData,
  processRecentSubscriberIndexMigrationBatch,
  repairAutoCreateNextGoal,
} from "../data/subGoalData";
import {
  cancelUpdates,
  getQueuedUpdates,
  queueUpdate,
  untrackPost,
} from "../data/updaterData";
import { isLinkId } from "../types";
import { applyTextFallback } from "../utils/textFallback";
import { getAppSettings } from "../settings";
import {
  isCrosspostAuthorityInstall,
  processCrosspostDispatchQueue,
} from "./modAction";
import { countPendingCrossposts } from "../data/crosspostData";
import { processSubscriberStatsMigrationBatch } from "../data/subscriberStats";
import { processPostKindMigrationBatch } from "../data/postKindMigration";
import { processLegacyAfterSubscribeActionMigrationBatch } from "../data/legacyAfterSubscribeActionMigration";
import { processNsfwAfterSubscribeActionMigrationBatch } from "../data/nsfwAfterSubscribeActionMigration";
import { processDueAutoCreateNextGoals } from "../core/autoCreateNextGoal";
import {
  onboardingSubscriberGoalStateKey,
  processDueOnboardingSubscriberGoal,
} from "../core/onboardingSubscriberGoal";
import { processDueOnboardingReminder } from "../core/onboardingReminder";
import { applyGoalPostFrameStyle } from "../core/post";
import {
  getTerminalRemovedByCategory,
  isMissingPostError,
} from "../utils/postStatus";
import { removeSubscriberGoalPost } from "../data/subscriberGoalPostRegistry";
import { observeDailySubscriberCount } from "../data/subscriberDailyStats";
import { ensureCommunityPostActivityBackfill } from "../data/ctaActivity";
import { logDiagnostic } from "../../shared/diagnostics";
import { processDueAppAccountHealthCheck } from "../core/appAccountHealth";
import { processDueAppRepair } from "../core/appRepair";
import { processDueAppAccountRecovery } from "../core/appAccountRecovery";
import { retireSubscriberGoalPost } from "../core/postRetirement";
import {
  clearPostOperationalState,
  getPostOperationalState,
  savePostOperationalState,
} from "../data/postOperationalState";
import { scheduleHighlightRepair } from "../data/highlightRepair";
import {
  isUsableSubscriberGoal,
  recoverEmergencySubscriberGoal,
} from "../utils/emergencyGoalRecovery";
import { ctaOnlyPostKind, subscribeOnlyPostKind } from "../../shared/postKind";
import { withCommunityGoalMutationLease } from "../core/communityGoalMutation";

type CompletedUpdateCleanupPreparation =
  | "auto_disabled"
  | "intentionally_suppressed"
  | "onboarding_takeover"
  | "successor_mapped"
  | "scheduled"
  | "queued"
  | "retrying"
  | "exhausted";

async function prepareCompletedUpdateCleanup(
  postId: string,
): Promise<CompletedUpdateCleanupPreparation> {
  return withCommunityGoalMutationLease(redis, async () => {
    // Re-read under the same lease used by completion, onboarding, manual goal
    // creation, and the AutoGoal worker. This makes the decision current and
    // prevents a repair from overwriting a newer retry or supersession decision.
    const latest = await getSubGoalData(redis, postId);
    if (!latest.completedTime) {
      throw new Error("Completed goal lost its persisted completion time.");
    }
    if (!latest.autoCreateNextGoal) return "auto_disabled";
    if (latest.automaticSuccessorSuppression) {
      return "intentionally_suppressed";
    }

    const [successor, onboardingIntent, replacementSourcePostId, status] =
      await Promise.all([
        redis.hGet(autoCreateNextGoalSuccessorsKey, postId),
        redis.hGet(onboardingSubscriberGoalStateKey, "intent"),
        redis.hGet(onboardingSubscriberGoalStateKey, "replacementSourcePostId"),
        redis.hGet(onboardingSubscriberGoalStateKey, "status"),
      ]);
    if (successor) return "successor_mapped";
    if (
      onboardingIntent === "orphaned_completed_goal" &&
      replacementSourcePostId === postId &&
      status !== "complete"
    ) {
      return "onboarding_takeover";
    }

    const repaired = await repairAutoCreateNextGoal(
      redis,
      postId,
      latest.completedTime,
    );
    return repaired.status;
  });
}

async function cleanupCompletedUpdate(postId: string): Promise<boolean> {
  try {
    await prepareCompletedUpdateCleanup(postId);
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_post_update_failed",
      {
        workflow: "post_update",
        phase: "auto_successor_repair",
        postId,
      },
      error,
    );
    return false;
  }

  try {
    await cancelUpdates(redis, postId);
    return true;
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_post_update_failed",
      {
        workflow: "post_update",
        phase: "completed_update_cleanup",
        postId,
      },
      error,
    );
    return false;
  }
}

async function cleanupInactivePost(
  postId: string,
  reason: string,
): Promise<void> {
  await cancelUpdates(redis, postId);
  await untrackPost(redis, postId);
  await cancelAutoCreateNextGoal(redis, postId);
  await removeSubscriberGoalPost(redis, postId);
  console.info(
    `[updater] cleaned up inactive post: postId=${postId} reason=${reason}`,
  );
}

export async function onPostsUpdaterJob(): Promise<void> {
  console.log(`postsUpdaterJob ran at ${new Date().toISOString()}`);

  const appSettings = getAppSettings();
  try {
    const recovery = await processDueAppAccountRecovery({
      reddit,
      redis,
      scheduler,
    });
    if (
      recovery.status === "pending" ||
      recovery.status === "processing" ||
      recovery.status === "locked" ||
      recovery.status === "missing" ||
      recovery.status === "insufficient_permissions" ||
      recovery.status === "acceptance_failed" ||
      recovery.status === "verification_failed" ||
      recovery.status === "exhausted"
    ) {
      return;
    }
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "app_account_recovery" },
      error,
    );
  }
  let subreddit: Awaited<ReturnType<typeof reddit.getCurrentSubreddit>> | null =
    null;
  try {
    subreddit = await reddit.getCurrentSubreddit();
    await observeDailySubscriberCount(redis, subreddit.numberOfSubscribers);
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "subscriber_daily_stats" },
      error,
    );
  }
  if (subreddit) {
    try {
      await ensureCommunityPostActivityBackfill(reddit, redis, subreddit.name);
    } catch (error) {
      logDiagnostic(
        "error",
        "scheduler_task_failed",
        { workflow: "community_post_activity_backfill" },
        error,
      );
    }
  }
  try {
    await processDueAppAccountHealthCheck({ reddit, redis });
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "app_account_health" },
      error,
    );
  }
  try {
    await processDueAppRepair({ reddit, redis });
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "app_repair" },
      error,
    );
  }
  const currentSubredditName = context.subredditName ?? subreddit?.name;
  if (
    currentSubredditName &&
    isCrosspostAuthorityInstall(appSettings, currentSubredditName)
  ) {
    const ingestionSummary = await processCrosspostDispatchQueue(
      appSettings,
      "scheduler_posts_updater",
    );
    const pendingDepth = await countPendingCrossposts(
      redis,
      appSettings.promoSubreddit,
    );
    const crosspostWorkOccurred =
      ingestionSummary.revisionsFetched > 0 ||
      ingestionSummary.newPostsSeen > 0 ||
      ingestionSummary.crosspostsCreated > 0 ||
      ingestionSummary.crosspostsSkipped > 0 ||
      ingestionSummary.crosspostsFailed > 0 ||
      ingestionSummary.actionsMirrored > 0 ||
      ingestionSummary.actionsFailed > 0 ||
      ingestionSummary.crosspostPersistenceFailedAfterCreate > 0 ||
      ingestionSummary.crosspostsSkippedBySourceCooldown > 0 ||
      ingestionSummary.crosspostsSkippedByInFlight > 0 ||
      ingestionSummary.crosspostsSkippedByExistingDetection > 0;
    if (
      crosspostWorkOccurred ||
      pendingDepth > 0 ||
      ingestionSummary.status !== "success"
    ) {
      console.info(
        `[crosspost] scheduler ingestion summary: status=${ingestionSummary.status} revisionsFetched=${ingestionSummary.revisionsFetched} newPostsSeen=${ingestionSummary.newPostsSeen} crosspostsCreated=${ingestionSummary.crosspostsCreated} crosspostsSkipped=${ingestionSummary.crosspostsSkipped} crosspostsFailed=${ingestionSummary.crosspostsFailed} actionsMirrored=${ingestionSummary.actionsMirrored} actionsFailed=${ingestionSummary.actionsFailed} crosspostPersistenceFailedAfterCreate=${ingestionSummary.crosspostPersistenceFailedAfterCreate} crosspostsSkippedBySourceCooldown=${ingestionSummary.crosspostsSkippedBySourceCooldown} crosspostsSkippedByInFlight=${ingestionSummary.crosspostsSkippedByInFlight} crosspostsSkippedByExistingDetection=${ingestionSummary.crosspostsSkippedByExistingDetection} pendingDepth=${pendingDepth} error=${ingestionSummary.errorMessage ?? "none"}`,
      );
    }
  }
  try {
    await processPostKindMigrationBatch(reddit, redis);
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "post_kind_migration" },
      error,
    );
  }
  try {
    if (subreddit) {
      await processLegacyAfterSubscribeActionMigrationBatch(redis, {
        name: subreddit.name,
        type: subreddit.type,
      });
    }
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "after_subscribe_action_migration" },
      error,
    );
  }
  try {
    if (subreddit) {
      await processNsfwAfterSubscribeActionMigrationBatch(redis, {
        name: subreddit.name,
        nsfw: subreddit.nsfw,
      });
    }
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "nsfw_after_subscribe_action_migration" },
      error,
    );
  }
  try {
    await processSubscriberStatsMigrationBatch(redis);
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "subscriber_stats_migration" },
      error,
    );
  }
  try {
    await processRecentSubscriberIndexMigrationBatch(redis);
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "recent_subscriber_migration" },
      error,
    );
  }
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
  try {
    await processDueOnboardingSubscriberGoal({
      reddit,
      redis,
      appSettings,
    });
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "onboarding_subscriber_goal" },
      error,
    );
  }
  try {
    const autoCreateSummary = await processDueAutoCreateNextGoals({
      reddit,
      redis,
      appSettings,
    });
    if (
      autoCreateSummary.due > 0 ||
      autoCreateSummary.created > 0 ||
      autoCreateSummary.skipped > 0 ||
      autoCreateSummary.failed > 0 ||
      autoCreateSummary.rescheduled > 0 ||
      autoCreateSummary.exhausted > 0
    ) {
      console.info(
        `[autoCreateNextGoal] scheduler summary: due=${autoCreateSummary.due} created=${autoCreateSummary.created} skipped=${autoCreateSummary.skipped} failed=${autoCreateSummary.failed} rescheduled=${autoCreateSummary.rescheduled} exhausted=${autoCreateSummary.exhausted}`,
      );
    }
  } catch (error) {
    logDiagnostic(
      "error",
      "scheduler_task_failed",
      { workflow: "auto_create_next_goal" },
      error,
    );
  }

  const postIds = await getQueuedUpdates(redis);
  if (!postIds.length) {
    return;
  }
  if (!subreddit) {
    try {
      subreddit = await reddit.getCurrentSubreddit();
    } catch (error) {
      logDiagnostic(
        "error",
        "scheduler_task_failed",
        { workflow: "subreddit_lookup" },
        error,
      );
      return;
    }
  }
  console.log(`Updating ${postIds.length} posts`);

  for (const postId of postIds) {
    try {
      const subGoalData = await getSubGoalData(redis, postId);
      if (
        !isUsableSubscriberGoal(subGoalData.goal) &&
        (subGoalData.postKind === subscribeOnlyPostKind ||
          subGoalData.postKind === ctaOnlyPostKind)
      ) {
        continue;
      }

      let effectiveGoal = subGoalData.goal;
      let effectiveSubscribers = subreddit.numberOfSubscribers;
      if (!isUsableSubscriberGoal(effectiveGoal)) {
        const recovery = await recoverEmergencySubscriberGoal({
          redis,
          postId,
          workflow: "post_update",
          currentSubscribers: effectiveSubscribers,
          completed: subGoalData.completedTime > 0,
        });
        effectiveGoal = recovery.goal;
        effectiveSubscribers = recovery.subscribers;
      }

      if (effectiveSubscribers >= effectiveGoal && !subGoalData.completedTime) {
        subGoalData.completedTime = await checkCompletionStatus(
          reddit,
          redis,
          postId,
        );
      }

      const completedTime = subGoalData.completedTime
        ? new Date(subGoalData.completedTime)
        : null;
      if (!isLinkId(postId)) {
        logDiagnostic("error", "scheduler_post_update_failed", {
          workflow: "post_update",
          phase: "invalid_post_id",
          postId,
        });
        await cleanupInactivePost(postId, "invalid_post_id");
        continue;
      }
      const post = await reddit.getPostById(postId);
      const removedByCategory = getTerminalRemovedByCategory(post);
      if (removedByCategory) {
        await retireSubscriberGoalPost(
          redis,
          postId,
          `removedByCategory:${removedByCategory}`,
        );
        console.info(
          `[updater] cleaned up inactive post: postId=${postId} reason=removedByCategory:${removedByCategory}`,
        );
        continue;
      }
      const archived = post.archived === true;
      const locked = post.locked === true;
      const previousOperationalState = await getPostOperationalState(
        redis,
        postId,
      );
      if (archived) {
        await savePostOperationalState(redis, {
          postId,
          archived: true,
          locked,
          highlightBlocked: previousOperationalState?.highlightBlocked ?? false,
          updatedAt: Date.now(),
        });
        logDiagnostic("info", "subscriber_goal_post_archived", {
          workflow: "post_update",
          phase: "render_skipped",
          postId,
          locked,
        });
        if (subGoalData.completedTime) {
          await cleanupCompletedUpdate(postId);
        }
        continue;
      }
      if (previousOperationalState?.archived) {
        await clearPostOperationalState(redis, postId);
        await scheduleHighlightRepair(redis, {
          delayMs: 0,
          force: true,
          reason: "post_unarchived",
          targetPostId: postId,
        });
      } else if (locked) {
        await savePostOperationalState(redis, {
          postId,
          archived: false,
          locked: true,
          highlightBlocked: false,
          updatedAt: Date.now(),
        });
        logDiagnostic("info", "subscriber_goal_post_locked", {
          workflow: "post_update",
          phase: "render_continues",
          postId,
        });
      } else {
        await clearPostOperationalState(redis, postId);
      }
      await applyTextFallback(post, {
        goal: effectiveGoal,
        subscribers: effectiveSubscribers,
        subredditName: subGoalData.subredditDisplayName ?? subreddit.name,
        completedTime,
        language: subGoalData.language,
      });
      await applyGoalPostFrameStyle(post, subGoalData.postHeight);

      if (subGoalData.completedTime) {
        await cleanupCompletedUpdate(postId);
        continue;
      }

      await queueUpdate(redis, postId, new Date());
    } catch (e) {
      if (isLinkId(postId) && isMissingPostError(e, postId)) {
        await retireSubscriberGoalPost(redis, postId, "confirmed_missing_post");
        console.info(
          `[updater] cleaned up inactive post: postId=${postId} reason=confirmed_missing_post`,
        );
        continue;
      }
      logDiagnostic(
        "error",
        "scheduler_post_update_failed",
        { workflow: "post_update", postId },
        e,
      );
    }
  }
}
