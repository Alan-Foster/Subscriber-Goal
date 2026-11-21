import type { Router } from "express";
import { context, reddit, redis } from "@devvit/web/server";
import type { RefreshResponse } from "../../../shared/types/api";
import { apiRoutes } from "../../../shared/routes";
import { checkCompletionStatus, getSubGoalData } from "../../data/subGoalData";
import {
  ctaOnlyPostKind,
  subscribeOnlyPostKind,
} from "../../../shared/postKind";
import {
  hasSubscriptionAttemptReceipt,
  isValidSubscriptionAttemptId,
} from "../../data/subscriptionAttempt";
import { createOperationId, logDiagnostic } from "../../../shared/diagnostics";
import { isPrivateSubredditAccessError } from "../../utils/redditPermissionErrors";
import {
  buildState,
  buildSubscribeOnlyState,
  buildCtaOnlyState,
} from "./state";
import { localizedError } from "./request";

export function registerRefreshRoutes(router: Router): void {
  router.get(apiRoutes.refresh, async (req, res): Promise<void> => {
    const { postId } = context;
    if (!postId) {
      logDiagnostic("warn", "api_validation_failed", {
        route: apiRoutes.refresh,
        workflow: "refresh",
        phase: "missing_post_id",
        status: 400,
      });
      res.status(400).json(localizedError("errors.api.postIdMissing"));
      return;
    }

    try {
      const requestedAttemptId = (
        req.query as Record<string, unknown> | undefined
      )?.attemptId;
      if (
        requestedAttemptId !== undefined &&
        !isValidSubscriptionAttemptId(requestedAttemptId)
      ) {
        res.status(400).json(localizedError("errors.join.invalidAttempt"));
        return;
      }
      const subscriptionAttemptConfirmed = requestedAttemptId
        ? await hasSubscriptionAttemptReceipt(
            redis,
            requestedAttemptId,
            postId,
            context.userId,
          )
        : undefined;
      const attemptConfirmation =
        subscriptionAttemptConfirmed === undefined
          ? {}
          : { subscriptionAttemptConfirmed };
      const subGoalData = await getSubGoalData(redis, postId, context.postData);
      if (subGoalData.postKind === subscribeOnlyPostKind) {
        res.json({
          type: "refresh",
          postId,
          state: await buildSubscribeOnlyState(postId, subGoalData),
          ...attemptConfirmation,
        } satisfies RefreshResponse);
        return;
      }
      if (subGoalData.postKind === ctaOnlyPostKind) {
        res.json({
          type: "refresh",
          postId,
          state: await buildCtaOnlyState(postId, subGoalData),
          ...attemptConfirmation,
        } satisfies RefreshResponse);
        return;
      }
      if (subGoalData.goal && !subGoalData.completedTime) {
        const subreddit = await reddit.getCurrentSubreddit();
        if (subreddit.numberOfSubscribers >= subGoalData.goal) {
          await checkCompletionStatus(reddit, redis, postId);
        }
      }

      const state = await buildState(postId, undefined, {
        recoveryWorkflow: "refresh",
        recoveryRoute: apiRoutes.refresh,
      });
      res.json({
        type: "refresh",
        postId,
        state,
        ...attemptConfirmation,
      } satisfies RefreshResponse);
    } catch (error) {
      const operationId = createOperationId("refresh");
      const shouldLog =
        !isPrivateSubredditAccessError(error) ||
        (await claimRefreshPermissionDiagnostic());
      if (shouldLog) {
        logDiagnostic(
          "error",
          "api_request_failed",
          {
            operationId,
            route: apiRoutes.refresh,
            workflow: "refresh",
            postId,
            status: 503,
          },
          error,
        );
      }
      res
        .status(503)
        .json(localizedError("errors.api.refreshFailed", { operationId }));
    }
  });
}

const refreshPermissionDiagnosticKey =
  "refresh_permission_denied_diagnostic_v1";

const refreshPermissionDiagnosticTtlMs = 15 * 60_000;

async function claimRefreshPermissionDiagnostic(): Promise<boolean> {
  try {
    const token = crypto.randomUUID();
    await redis.set(refreshPermissionDiagnosticKey, token, {
      nx: true,
      expiration: new Date(Date.now() + refreshPermissionDiagnosticTtlMs),
    });
    return (await redis.get(refreshPermissionDiagnosticKey)) === token;
  } catch {
    // diagnostic-allow-silent: preserve the structured API response and fall
    // back to logging the original permission error if rate limiting is down.
    return true;
  }
}
