import type { Response, Router } from "express";
import type { UiResponse } from "@devvit/web/shared";
import { context, reddit, redis } from "@devvit/web/server";
import { formNames, internalRoutes } from "../../shared/routes";
import { translate } from "../../shared/i18n/catalog";
import { createOperationId, logDiagnostic } from "../../shared/diagnostics";
import {
  requireCurrentActorAuthority,
  resolveCurrentSubredditLanguage,
} from "./internalUi.common";
import type { DeleteGoalFormValues } from "../../shared/types/api";
import type { SubGoalLanguage } from "../../shared/subGoalPostI18n";
import { getAppSettings, type ServerAppSettings } from "../settings";
import { retireSubscriberGoalPost } from "../core/postRetirement";
import {
  communityGoalMutationLockKey,
  CommunityGoalMutationInProgressError,
  type CommunityGoalMutationLease,
  withCommunityGoalMutationLease,
} from "../core/communityGoalMutation";
import {
  dispatchConfirmedSourceDeletion,
  prepareSourcePostDeletionIntent,
  recordSourceDeleteAttempt,
  recordSourceDeletionConfirmed,
} from "../core/sourcePostDeletion";
import type { LinkId } from "../types";
import { getSubscriberGoalCandidatePostIds } from "../data/subscriberGoalCandidates";
import { hasCrosspost } from "../data/crosspostData";
import {
  getSourcePostDeletionIntent,
  sourcePostDeletionIntentId,
  type SourcePostDeletionIntent,
} from "../data/sourcePostDeletion";
import { resolvePostKindFromPostData } from "../../shared/postKind";

// Leave time for Reddit deletion and cleanup within Devvit Web's server request budget.
// https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_overview#limitations
const deleteGoalLeaseRetry = { maxWaitMs: 4_000, intervalMs: 500 };

export function registerDeleteGoalRoutes(router: Router): void {
  registerDeleteGoalMenuRoute(router);
  registerDeleteGoalFormRoute(router);
}

function registerDeleteGoalMenuRoute(router: Router): void {
  router.post(
    internalRoutes.menu.deleteGoal,
    async (_req, res: Response<UiResponse>) => {
      const language = await resolveCurrentSubredditLanguage();
      res.json({
        showForm: {
          name: formNames.deleteGoal,
          form: {
            title: translate(language, "moderator.delete.title"),
            description: translate(language, "moderator.delete.description"),
            fields: [
              {
                name: "confirm",
                label: translate(language, "moderator.delete.confirm"),
                type: "boolean",
                defaultValue: false,
                helpText: translate(language, "moderator.delete.irreversible"),
              },
            ],
            acceptLabel: translate(language, "moderator.delete.accept"),
            cancelLabel: translate(language, "moderator.common.cancel"),
          },
        },
      });
    },
  );
}

function registerDeleteGoalFormRoute(router: Router): void {
  router.post(
    internalRoutes.forms.deleteGoal,
    async (req, res: Response<UiResponse>) => {
      const operationId = createOperationId("delete-goal");
      const postId = context.postId;
      const language = await resolveCurrentSubredditLanguage();
      const progress = { phase: "request_validation" };
      logDiagnostic("info", "delete_goal_started", {
        operationId,
        workflow: "delete_goal",
        phase: progress.phase,
        postId,
      });
      try {
        const { confirm } = (req.body ?? {}) as DeleteGoalFormValues;
        if (!confirm) {
          res.json({
            showToast: translate(language, "moderator.delete.notConfirmed"),
          });
          return;
        }
        if (!postId) {
          logDiagnostic("warn", "delete_goal_metadata_missing", {
            operationId,
            workflow: "delete_goal",
            phase: progress.phase,
          });
          res.json({
            showToast: translate(language, "moderator.delete.metadataLost", {
              operationId,
            }),
          });
          return;
        }

        await executeGoalDeletion({
          postId,
          operationId,
          language,
          progress,
          res,
        });
      } catch (error) {
        const leaseBusy =
          progress.phase === "mutation_lease" &&
          error instanceof CommunityGoalMutationInProgressError;
        logDiagnostic(
          leaseBusy ? "warn" : "error",
          "delete_goal_failed",
          {
            operationId,
            workflow: "delete_goal",
            phase: progress.phase,
            postId,
          },
          error,
        );
        const outcomeUncertain = progress.phase === "reddit_post_delete";
        res.json({
          showToast: leaseBusy
            ? translate(language, "moderator.delete.inProgress")
            : translate(
                language,
                outcomeUncertain
                  ? "moderator.delete.outcomeUncertain"
                  : "moderator.delete.failed",
                { operationId },
              ),
        });
      }
    },
  );
}

type DeleteGoalRequest = {
  postId: LinkId;
  operationId: string;
  language: SubGoalLanguage;
  progress: { phase: string };
  res: Response<UiResponse>;
};

type DeleteGoalTarget = {
  subreddit: Awaited<ReturnType<typeof reddit.getCurrentSubreddit>>;
  subredditName: string;
  post: Awaited<ReturnType<typeof reddit.getPostById>>;
  existingIntent: SourcePostDeletionIntent | undefined;
};

type DeleteGoalOutcome = {
  cleanupDispatched: boolean;
  sourceDeletionConfirmed: boolean;
  internalRecordsPending: boolean;
  concurrentDeleteUncertain: boolean;
  crosspostCleanupExpected: boolean;
};

async function executeGoalDeletion(request: DeleteGoalRequest): Promise<void> {
  const { language, progress, res } = request;
  const target = await resolveDeleteGoalTarget(request);
  if (!target) return;

  const appSettings = getAppSettings();
  progress.phase = "actor_authorization";
  const actorAuthority = await requireCurrentActorAuthority({
    requirement: "manage-posts",
    language,
  });
  if (!actorAuthority.authorized) {
    res.json({ showToast: actorAuthority.message });
    return;
  }
  const outcome = await deleteGoalWithLease(request, target, appSettings);
  await finishGoalDeletion(request, target.subredditName, outcome);
}

async function resolveDeleteGoalTarget(
  request: DeleteGoalRequest,
): Promise<DeleteGoalTarget | undefined> {
  const { postId, operationId, progress } = request;
  progress.phase = "metadata_resolution";
  const subreddit = await reddit.getCurrentSubreddit();
  const subredditName = subreddit.name;
  logDiagnostic("info", "delete_goal_phase_complete", {
    operationId,
    workflow: "delete_goal",
    phase: progress.phase,
    postId,
  });

  progress.phase = "post_lookup";
  const existingIntent = await getSourcePostDeletionIntent(
    redis,
    sourcePostDeletionIntentId(subreddit.id, postId),
  );
  const post = await reddit.getPostById(postId);
  const isCurrentSubredditPost =
    post.subredditId === subreddit.id &&
    post.subredditName.toLowerCase() === subreddit.name.toLowerCase();
  if (!isCurrentSubredditPost) {
    reportIneligibleDeleteGoal(request, subredditName);
    return undefined;
  }
  const managedPostIds = await getSubscriberGoalCandidatePostIds(redis);
  const isRegisteredSubscriberGoal = managedPostIds.includes(postId);
  const postKind = isRegisteredSubscriberGoal
    ? undefined
    : resolvePostKindFromPostData(await reddit.getPostData(postId));
  const appUser =
    postKind === undefined ? undefined : await reddit.getAppUser();
  const isVerifiedSubscriberGoalPost =
    postKind !== undefined &&
    typeof post.authorName === "string" &&
    post.authorName.toLowerCase() === appUser?.username.toLowerCase();
  if (!isRegisteredSubscriberGoal && !isVerifiedSubscriberGoalPost) {
    reportIneligibleDeleteGoal(request, subredditName);
    return undefined;
  }
  logDiagnostic("info", "delete_goal_phase_complete", {
    operationId,
    workflow: "delete_goal",
    phase: progress.phase,
    postId,
  });
  return { subreddit, subredditName, post, existingIntent };
}

function reportIneligibleDeleteGoal(
  { postId, operationId, language, progress, res }: DeleteGoalRequest,
  subredditName: string,
): void {
  logDiagnostic("warn", "delete_goal_target_ineligible", {
    operationId,
    workflow: "delete_goal",
    phase: progress.phase,
    postId,
    subredditName,
  });
  res.json({
    showToast: translate(language, "moderator.delete.ineligible"),
  });
}

async function deleteGoalWithLease(
  request: DeleteGoalRequest,
  target: DeleteGoalTarget,
  appSettings: ServerAppSettings,
): Promise<DeleteGoalOutcome> {
  const { postId, operationId, progress } = request;
  const { existingIntent } = target;
  progress.phase = "mutation_lease";
  const verificationMayBeInFlight =
    existingIntent?.status === "verify_source" &&
    existingIntent.deleteLeaseToken !== undefined &&
    (await redis.get(communityGoalMutationLockKey)) ===
      existingIntent.deleteLeaseToken;
  const outcome: DeleteGoalOutcome = {
    cleanupDispatched: false,
    sourceDeletionConfirmed: false,
    internalRecordsPending: false,
    concurrentDeleteUncertain: false,
    crosspostCleanupExpected: true,
  };
  try {
    outcome.crosspostCleanupExpected = await hasCrosspost(redis, postId);
  } catch (error) {
    logDiagnostic(
      "warn",
      "delete_goal_crosspost_lookup_failed",
      { operationId, workflow: "delete_goal", phase: progress.phase, postId },
      error,
    );
  }
  await withCommunityGoalMutationLease(
    redis,
    (lease) =>
      deleteGoalUnderLease(
        request,
        target,
        appSettings,
        outcome,
        verificationMayBeInFlight,
        lease,
      ),
    undefined,
    deleteGoalLeaseRetry,
    "delete_goal",
  );
  return outcome;
}

async function deleteGoalUnderLease(
  request: DeleteGoalRequest,
  target: DeleteGoalTarget,
  appSettings: ServerAppSettings,
  outcome: DeleteGoalOutcome,
  verificationMayBeInFlight: boolean,
  mutationLease: CommunityGoalMutationLease,
): Promise<void> {
  const { operationId, postId, progress } = request;
  const { subreddit, subredditName, post, existingIntent } = target;
  progress.phase = "deletion_intent_persistence";
  let intent = await prepareSourcePostDeletionIntent(redis, {
    postId,
    subredditId: subreddit.id,
    subredditName,
  });
  logDiagnostic("info", "delete_goal_phase_complete", {
    operationId,
    workflow: "delete_goal",
    phase: progress.phase,
    postId,
    intentId: intent.id,
  });

  if (intent.status === "dispatched") {
    outcome.cleanupDispatched = true;
    outcome.sourceDeletionConfirmed = true;
    return;
  }
  if (intent.status === "dispatch_pending") {
    outcome.sourceDeletionConfirmed = true;
    await dispatchGoalCleanup(request, appSettings, intent, outcome);
    return;
  }
  if (
    intent.status === "verify_source" &&
    (verificationMayBeInFlight ||
      intent.deleteAttemptCount > (existingIntent?.deleteAttemptCount ?? 0))
  ) {
    // The earlier post lookup cannot verify an attempt made by a concurrent submit.
    outcome.concurrentDeleteUncertain = true;
    return;
  }

  // This durable transition is deliberately before Reddit. If the
  // delete response is lost, the updater knows to verify, never repeat.
  progress.phase = "deletion_attempt_persistence";
  intent = await recordSourceDeleteAttempt(redis, intent, {
    leaseToken: mutationLease.token,
  });
  progress.phase = "reddit_post_delete";
  await post.delete();
  outcome.sourceDeletionConfirmed = true;
  logDiagnostic("info", "delete_goal_phase_complete", {
    operationId,
    workflow: "delete_goal",
    phase: progress.phase,
    postId,
  });

  progress.phase = "deletion_confirmation_persistence";
  try {
    intent = await recordSourceDeletionConfirmed(redis, intent);
  } catch (error) {
    outcome.internalRecordsPending = true;
    // The preceding verify_source record remains indexed. Recovery can
    // establish the missing source and resume dispatch on the next tick.
    logDiagnostic(
      "warn",
      "delete_goal_confirmation_pending",
      { operationId, workflow: "delete_goal", phase: progress.phase, postId },
      error,
    );
    return;
  }

  await dispatchGoalCleanup(request, appSettings, intent, outcome);
}

async function dispatchGoalCleanup(
  { operationId, postId, progress }: DeleteGoalRequest,
  appSettings: ServerAppSettings,
  intent: SourcePostDeletionIntent,
  outcome: DeleteGoalOutcome,
): Promise<void> {
  progress.phase = "crosspost_delete_dispatch";
  try {
    const dispatched = await dispatchConfirmedSourceDeletion(
      reddit,
      redis,
      appSettings,
      intent,
    );
    outcome.cleanupDispatched = dispatched.status === "dispatched";
  } catch (error) {
    logDiagnostic(
      "warn",
      "delete_goal_cleanup_dispatch_pending",
      { operationId, workflow: "delete_goal", phase: progress.phase, postId },
      error,
    );
  }
}

async function finishGoalDeletion(
  { operationId, postId, language, progress, res }: DeleteGoalRequest,
  subredditName: string,
  outcome: DeleteGoalOutcome,
): Promise<void> {
  if (outcome.concurrentDeleteUncertain) {
    logDiagnostic("warn", "delete_goal_verification_pending", {
      operationId,
      workflow: "delete_goal",
      phase: progress.phase,
      postId,
    });
    res.json({
      showToast: translate(language, "moderator.delete.outcomeUncertain", {
        operationId,
      }),
    });
    return;
  }
  const cleanupFailures: string[] = [];
  const runCleanupPhase = async (
    cleanupPhase: string,
    operation: () => Promise<unknown>,
  ): Promise<void> => {
    progress.phase = cleanupPhase;
    try {
      await operation();
      logDiagnostic("info", "delete_goal_phase_complete", {
        operationId,
        workflow: "delete_goal",
        phase: progress.phase,
        postId,
      });
    } catch (error) {
      cleanupFailures.push(cleanupPhase);
      logDiagnostic(
        "error",
        "delete_goal_cleanup_failed",
        { operationId, workflow: "delete_goal", phase: progress.phase, postId },
        error,
      );
    }
  };
  if (outcome.sourceDeletionConfirmed) {
    await runCleanupPhase("post_retirement", () =>
      retireSubscriberGoalPost(redis, postId, "app_menu_deletion"),
    );
  }
  progress.phase = "response_completion";
  const navigation = outcome.sourceDeletionConfirmed
    ? { navigateTo: `https://www.reddit.com/r/${subredditName}/` }
    : {};
  if (cleanupFailures.length > 0 || outcome.internalRecordsPending) {
    logDiagnostic("warn", "delete_goal_partially_completed", {
      operationId,
      workflow: "delete_goal",
      phase: progress.phase,
      postId,
      failedCleanupCount: cleanupFailures.length,
    });
    res.json({
      showToast: translate(language, "moderator.delete.cleanupPending", {
        operationId,
      }),
      ...navigation,
    });
    return;
  }
  res.json({
    showToast: translate(
      language,
      outcome.crosspostCleanupExpected
        ? outcome.cleanupDispatched
          ? "moderator.delete.cleanupDispatched"
          : "moderator.delete.cleanupQueued"
        : "moderator.delete.success",
    ),
    ...navigation,
  });
  logDiagnostic("info", "delete_goal_completed", {
    operationId,
    workflow: "delete_goal",
    phase: progress.phase,
    postId,
  });
}
