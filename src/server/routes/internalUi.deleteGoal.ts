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
import { getAppSettings } from "../settings";
import { retireSubscriberGoalPost } from "../core/postRetirement";
import {
  communityGoalMutationLockKey,
  CommunityGoalMutationInProgressError,
  withCommunityGoalMutationLease,
} from "../core/communityGoalMutation";
import {
  dispatchConfirmedSourceDeletion,
  prepareSourcePostDeletionIntent,
  recordSourceDeleteAttempt,
  recordSourceDeletionConfirmed,
} from "../core/sourcePostDeletion";
import type { LinkId, SubredditId } from "../types";
import { getSubscriberGoalCandidatePostIds } from "../data/subscriberGoalCandidates";
import { hasCrosspost } from "../data/crosspostData";
import {
  getSourcePostDeletionIntent,
  sourcePostDeletionIntentId,
} from "../data/sourcePostDeletion";
import { resolvePostKindFromPostData } from "../../shared/postKind";

// Devvit Web caps the whole request at 30 seconds. Reserve time for Reddit deletion and cleanup.
const deleteGoalLeaseRetry = { maxWaitMs: 4_000, intervalMs: 500 };

export function registerDeleteGoalRoutes(router: Router): void {
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

  router.post(
    internalRoutes.forms.deleteGoal,
    async (req, res: Response<UiResponse>) => {
      const operationId = createOperationId("delete-goal");
      const postId = context.postId;
      const language = await resolveCurrentSubredditLanguage();
      let phase = "request_validation";
      logDiagnostic("info", "delete_goal_started", {
        operationId,
        workflow: "delete_goal",
        phase,
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
            phase,
          });
          res.json({
            showToast: translate(language, "moderator.delete.metadataLost", {
              operationId,
            }),
          });
          return;
        }

        phase = "metadata_resolution";
        const subreddit = await reddit.getCurrentSubreddit();
        const subredditName = subreddit.name;
        logDiagnostic("info", "delete_goal_phase_complete", {
          operationId,
          workflow: "delete_goal",
          phase,
          postId,
        });

        phase = "post_lookup";
        const existingIntent = await getSourcePostDeletionIntent(
          redis,
          sourcePostDeletionIntentId(
            subreddit.id as SubredditId,
            postId as LinkId,
          ),
        );
        const verificationMayBeInFlight =
          existingIntent?.status === "verify_source" &&
          Boolean(await redis.get(communityGoalMutationLockKey));
        const post = await reddit.getPostById(postId);
        const isCurrentSubredditPost =
          post.subredditId === subreddit.id &&
          post.subredditName.toLowerCase() === subreddit.name.toLowerCase();
        if (!isCurrentSubredditPost) {
          logDiagnostic("warn", "delete_goal_target_ineligible", {
            operationId,
            workflow: "delete_goal",
            phase,
            postId,
            subredditName,
          });
          res.json({
            showToast: translate(language, "moderator.delete.ineligible"),
          });
          return;
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
          logDiagnostic("warn", "delete_goal_target_ineligible", {
            operationId,
            workflow: "delete_goal",
            phase,
            postId,
            subredditName,
          });
          res.json({
            showToast: translate(language, "moderator.delete.ineligible"),
          });
          return;
        }
        logDiagnostic("info", "delete_goal_phase_complete", {
          operationId,
          workflow: "delete_goal",
          phase,
          postId,
        });
        const appSettings = getAppSettings();
        phase = "actor_authorization";
        const actorAuthority = await requireCurrentActorAuthority({
          requirement: "manage-posts",
          language,
        });
        if (!actorAuthority.authorized) {
          res.json({ showToast: actorAuthority.message });
          return;
        }
        let cleanupDispatched = false;
        let sourceDeletionConfirmed = false;
        let internalRecordsPending = false;
        let concurrentDeleteUncertain = false;
        let crosspostCleanupExpected = true;
        try {
          crosspostCleanupExpected = await hasCrosspost(redis, postId);
        } catch (error) {
          logDiagnostic(
            "warn",
            "delete_goal_crosspost_lookup_failed",
            { operationId, workflow: "delete_goal", phase, postId },
            error,
          );
        }
        const deleteUnderLease = async () => {
          phase = "deletion_intent_persistence";
          let intent = await prepareSourcePostDeletionIntent(redis, {
            postId: postId as LinkId,
            subredditId: subreddit.id as SubredditId,
            subredditName,
          });
          logDiagnostic("info", "delete_goal_phase_complete", {
            operationId,
            workflow: "delete_goal",
            phase,
            postId,
            intentId: intent.id,
          });

          if (intent.status === "dispatched") {
            cleanupDispatched = true;
            sourceDeletionConfirmed = true;
            return;
          }
          if (intent.status === "dispatch_pending") {
            sourceDeletionConfirmed = true;
            phase = "crosspost_delete_dispatch";
            try {
              intent = await dispatchConfirmedSourceDeletion(
                reddit,
                redis,
                appSettings,
                intent,
              );
              cleanupDispatched = intent.status === "dispatched";
            } catch (error) {
              logDiagnostic(
                "warn",
                "delete_goal_cleanup_dispatch_pending",
                { operationId, workflow: "delete_goal", phase, postId },
                error,
              );
            }
            return;
          }
          if (
            intent.status === "verify_source" &&
            (verificationMayBeInFlight ||
              intent.deleteAttemptCount >
                (existingIntent?.deleteAttemptCount ?? 0))
          ) {
            // The earlier post lookup cannot verify an attempt made by a concurrent submit.
            concurrentDeleteUncertain = true;
            return;
          }

          // This durable transition is deliberately before Reddit. If the
          // delete response is lost, the updater knows to verify, never repeat.
          phase = "deletion_attempt_persistence";
          intent = await recordSourceDeleteAttempt(redis, intent);
          phase = "reddit_post_delete";
          await post.delete();
          sourceDeletionConfirmed = true;
          logDiagnostic("info", "delete_goal_phase_complete", {
            operationId,
            workflow: "delete_goal",
            phase,
            postId,
          });

          phase = "deletion_confirmation_persistence";
          try {
            intent = await recordSourceDeletionConfirmed(redis, intent);
          } catch (error) {
            internalRecordsPending = true;
            // The preceding verify_source record remains indexed. Recovery can
            // establish the missing source and resume dispatch on the next tick.
            logDiagnostic(
              "warn",
              "delete_goal_confirmation_pending",
              { operationId, workflow: "delete_goal", phase, postId },
              error,
            );
            return;
          }

          phase = "crosspost_delete_dispatch";
          try {
            intent = await dispatchConfirmedSourceDeletion(
              reddit,
              redis,
              appSettings,
              intent,
            );
            cleanupDispatched = intent.status === "dispatched";
          } catch (error) {
            logDiagnostic(
              "warn",
              "delete_goal_cleanup_dispatch_pending",
              { operationId, workflow: "delete_goal", phase, postId },
              error,
            );
          }
        };
        phase = "mutation_lease";
        await withCommunityGoalMutationLease(
          redis,
          deleteUnderLease,
          undefined,
          deleteGoalLeaseRetry,
        );
        if (concurrentDeleteUncertain) {
          logDiagnostic("warn", "delete_goal_verification_pending", {
            operationId,
            workflow: "delete_goal",
            phase,
            postId,
          });
          res.json({
            showToast: translate(
              language,
              "moderator.delete.outcomeUncertain",
              { operationId },
            ),
          });
          return;
        }
        const cleanupFailures: string[] = [];
        const runCleanupPhase = async (
          cleanupPhase: string,
          operation: () => Promise<unknown>,
        ): Promise<void> => {
          phase = cleanupPhase;
          try {
            await operation();
            logDiagnostic("info", "delete_goal_phase_complete", {
              operationId,
              workflow: "delete_goal",
              phase,
              postId,
            });
          } catch (error) {
            cleanupFailures.push(cleanupPhase);
            logDiagnostic(
              "error",
              "delete_goal_cleanup_failed",
              { operationId, workflow: "delete_goal", phase, postId },
              error,
            );
          }
        };
        if (sourceDeletionConfirmed) {
          await runCleanupPhase("post_retirement", () =>
            retireSubscriberGoalPost(redis, postId, "app_menu_deletion"),
          );
        }
        phase = "response_completion";
        if (cleanupFailures.length > 0 || internalRecordsPending) {
          logDiagnostic("warn", "delete_goal_partially_completed", {
            operationId,
            workflow: "delete_goal",
            phase,
            postId,
            failedCleanupCount: cleanupFailures.length,
          });
          res.json({
            showToast: translate(language, "moderator.delete.cleanupPending", {
              operationId,
            }),
          });
          return;
        }
        res.json({
          showToast: translate(
            language,
            crosspostCleanupExpected
              ? cleanupDispatched
                ? "moderator.delete.cleanupDispatched"
                : "moderator.delete.cleanupQueued"
              : "moderator.delete.success",
          ),
        });
        logDiagnostic("info", "delete_goal_completed", {
          operationId,
          workflow: "delete_goal",
          phase,
          postId,
        });
      } catch (error) {
        const leaseBusy =
          phase === "mutation_lease" &&
          error instanceof CommunityGoalMutationInProgressError;
        logDiagnostic(
          leaseBusy ? "warn" : "error",
          "delete_goal_failed",
          { operationId, workflow: "delete_goal", phase, postId },
          error,
        );
        const outcomeUncertain = phase === "reddit_post_delete";
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
