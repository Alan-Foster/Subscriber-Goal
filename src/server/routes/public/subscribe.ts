import type { Request, Response, Router } from "express";
import { context, reddit, redis, realtime } from "@devvit/web/server";
import type {
  RealtimeMessage,
  SubscribeRequest,
  SubscribeResponse,
} from "../../../shared/types/api";
import { apiRoutes } from "../../../shared/routes";
import { checkCompletionStatus, getSubGoalData } from "../../data/subGoalData";
import { resolveShareUsername } from "../../utils/usernameSharePolicy";
import {
  ctaOnlyPostKind,
  subscribeOnlyPostKind,
} from "../../../shared/postKind";
import {
  getRequestJourneyId,
  recordServerSubscribeSuccess,
} from "../../analytics/goalJourneyAnalytics";
import {
  getSubscriptionAcceptanceEvidence,
  isValidSubscriptionAttemptId,
  storeSubscriptionAttemptReceipt,
} from "../../data/subscriptionAttempt";
import {
  applySubscriberTracking,
  cleanupSubscriberTracking,
  getPendingSubscriberTracking,
  getSubscriberTrackingGeneration,
  persistAcceptedSubscriberTracking,
} from "../../data/subscriberTracking";
import { createOperationId, logDiagnostic } from "../../../shared/diagnostics";
import {
  getPostAvailability,
  isMissingPostError,
} from "../../utils/postStatus";
import { getCurrentSubredditNsfw } from "../../utils/subredditSafety";
import { recordStatisticsConfirmedJoin } from "../../data/statisticsAnalytics";
import {
  buildState,
  buildSubscribeOnlyState,
  type CurrentSubreddit,
  type SubGoalData,
} from "./state";
import { localizedError, visitorIdentity } from "./request";

export function registerSubscribeRoutes(router: Router): void {
  router.post(apiRoutes.subscribe, async (req, res): Promise<void> => {
    const { postId, userId } = context;
    const journeyId = getRequestJourneyId(req);
    const operationId = createOperationId("subscribe");
    let redditAccepted = false;
    let acceptanceDurable = false;
    if (!postId) {
      res.status(400).json(localizedError("errors.api.postIdMissing"));
      return;
    }

    try {
      logSubscribePhase(operationId, postId, "started");
      const subGoalData = await getSubGoalData(redis, postId, context.postData);
      const body = req.body as SubscribeRequest | undefined;
      const attemptId = body?.attemptId;
      if (attemptId !== undefined && !isValidSubscriptionAttemptId(attemptId)) {
        res.status(400).json(localizedError("errors.join.invalidAttempt"));
        return;
      }
      if (attemptId) {
        logSubscribePhase(operationId, postId, "attempt_validated", {
          attemptRef: attemptId.slice(0, 8),
        });
      }
      if (subGoalData.postKind === ctaOnlyPostKind) {
        res.status(400).json(localizedError("errors.join.unsupported"));
        return;
      }
      if (!userId) {
        res.status(401).json(localizedError("errors.join.loginRequired"));
        return;
      }
      const [username, subreddit, erasureGeneration] = await Promise.all([
        reddit.getCurrentUsername(),
        reddit.getCurrentSubreddit(),
        getSubscriberTrackingGeneration(redis, userId),
      ]);
      if (!username) {
        res.status(400).json(localizedError("errors.api.usernameUnavailable"));
        return;
      }
      const sourceSubredditNsfw = getCurrentSubredditNsfw(subreddit);
      const shareUsername =
        subGoalData.postKind === subscribeOnlyPostKind
          ? false // Tiny cards have no username-sharing control.
          : resolveShareUsername(
              body?.shareUsername === true,
              sourceSubredditNsfw !== false,
            );
      const newSubscriberCount = subreddit.numberOfSubscribers + 1;
      const acceptance = attemptId
        ? await getSubscriptionAcceptanceEvidence(
            redis,
            attemptId,
            postId,
            userId,
          )
        : undefined;
      acceptanceDurable = acceptance !== undefined;
      let pending = acceptance
        ? await getPendingSubscriberTracking(redis, userId)
        : undefined;
      let trackingCreated = false;

      if (!acceptance) {
        if (await isJoinGoalUnavailable(postId)) {
          res.status(400).json(localizedError("errors.join.goalUnavailable"));
          return;
        }
        await reddit.subscribeToCurrentSubreddit();
        redditAccepted = true;
        logSubscribePhase(operationId, postId, "reddit_subscribed");
        const acceptedAt = Date.now();
        const persisted = await persistAcceptedSubscriberTracking(redis, {
          operationId,
          userId,
          postId,
          username,
          subscribers: newSubscriberCount,
          timestamp: acceptedAt,
          shareUsername,
          erasureGeneration,
          ...(attemptId ? { attemptId } : {}),
        });
        pending = persisted.operation;
        trackingCreated = persisted.created;
        acceptanceDurable = true;
        logSubscribePhase(operationId, postId, "tracking_persisted", {
          trackingCreated,
        });
      } else {
        logSubscribePhase(operationId, postId, "acceptance_replayed");
      }

      const subscriberCreated = await completeSubscribeTracking({
        req,
        operationId,
        postId,
        userId,
        subGoalData,
        attemptId,
        acceptance,
        pending,
        trackingCreated,
      });
      await sendSubscribeResponse({
        res,
        operationId,
        postId,
        subGoalData,
        subreddit,
        username,
        shareUsername,
        newSubscriberCount,
        subscriberCreated,
        journeyId,
      });
    } catch (error) {
      logDiagnostic(
        "error",
        "api_request_failed",
        {
          operationId,
          route: apiRoutes.subscribe,
          workflow: "subscribe",
          postId,
          status: 503,
        },
        error,
      );
      const response = localizedError("errors.join.failedReference", {
        operationId,
      });
      res.status(503).json(
        redditAccepted && !acceptanceDurable
          ? {
              ...response,
              message: `Reddit may have accepted the join, but confirmation could not be saved. Check your membership before trying again. Reference: ${operationId}`,
            }
          : response,
      );
    }
  });
}

const logSubscribePhase = (
  operationId: string,
  postId: string,
  phase: string,
  details: Record<string, string | number | boolean> = {},
): void => {
  logDiagnostic("info", "subscribe_phase", {
    operationId,
    workflow: "subscribe",
    postId,
    phase,
    ...details,
  });
};

const runSubscribeSideEffect = async (
  operationId: string,
  postId: string,
  phase: string,
  operation: () => Promise<unknown>,
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    logDiagnostic(
      "warn",
      "subscribe_side_effect_failed",
      { operationId, workflow: "subscribe", postId, phase },
      error,
    );
  }
};

async function isJoinGoalUnavailable(
  postId: NonNullable<typeof context.postId>,
): Promise<boolean> {
  let goalPostId = postId;
  try {
    let goal = await reddit.getPostById(goalPostId);
    if (goal?.crosspostParentId) {
      goalPostId = goal.crosspostParentId;
      goal = await reddit.getPostById(goalPostId);
    }
    return !!goal && getPostAvailability(goal).status !== "active";
  } catch (error) {
    if (isMissingPostError(error, goalPostId)) return true;
    logDiagnostic(
      "info",
      "subscribe_post_availability_unknown",
      {
        workflow: "subscribe",
        phase: "availability_check",
        postId: goalPostId,
      },
      error,
    );
    return false;
  }
}

async function completeSubscribeTracking({
  req,
  operationId,
  postId,
  userId,
  subGoalData,
  attemptId,
  acceptance,
  pending,
  trackingCreated,
}: {
  req: Request;
  operationId: string;
  postId: NonNullable<typeof context.postId>;
  userId: NonNullable<typeof context.userId>;
  subGoalData: SubGoalData;
  attemptId: string | undefined;
  acceptance: Awaited<ReturnType<typeof getSubscriptionAcceptanceEvidence>>;
  pending: Awaited<ReturnType<typeof getPendingSubscriberTracking>>;
  trackingCreated: boolean;
}): Promise<boolean> {
  if (attemptId && !acceptance) {
    await runSubscribeSideEffect(
      operationId,
      postId,
      "statistics_confirmed_join",
      () =>
        recordStatisticsConfirmedJoin(redis, {
          attemptId,
          postId,
          ...(visitorIdentity(req)
            ? { visitorIdentity: visitorIdentity(req) }
            : {}),
          secondaryCtaEligible:
            subGoalData.afterSubscribeAction.type !== "disabled",
        }),
    );
  }
  if (attemptId) {
    await storeSubscriptionAttemptReceipt(
      redis,
      attemptId,
      postId,
      userId,
      ...(acceptance ? [acceptance.expiresAt] : []),
    );
    logSubscribePhase(operationId, postId, "attempt_receipt_stored");
  }
  const trackingResult = pending
    ? await applySubscriberTracking(redis, pending)
    : "complete";
  const subscriberCreated =
    trackingCreated &&
    trackingResult !== "obsolete" &&
    trackingResult !== "invalidated";
  if (trackingCreated && pending) {
    await cleanupSubscriberTracking(redis, {
      ...pending,
      phase: "complete",
    });
  }
  logSubscribePhase(operationId, postId, "tracking_complete", {
    subscriberCreated,
  });
  return subscriberCreated;
}

async function sendSubscribeResponse({
  res,
  operationId,
  postId,
  subGoalData,
  subreddit,
  username,
  shareUsername,
  newSubscriberCount,
  subscriberCreated,
  journeyId,
}: {
  res: Response;
  operationId: string;
  postId: NonNullable<typeof context.postId>;
  subGoalData: SubGoalData;
  subreddit: CurrentSubreddit;
  username: string;
  shareUsername: boolean;
  newSubscriberCount: number;
  subscriberCreated: boolean;
  journeyId: ReturnType<typeof getRequestJourneyId>;
}): Promise<void> {
  const displayedSubscriberCount = subscriberCreated
    ? newSubscriberCount
    : subreddit.numberOfSubscribers;

  if (
    subscriberCreated &&
    subGoalData.postKind !== subscribeOnlyPostKind &&
    subGoalData.goal &&
    newSubscriberCount >= subGoalData.goal
  ) {
    await runSubscribeSideEffect(operationId, postId, "completion_check", () =>
      checkCompletionStatus(reddit, redis, postId),
    );
  }

  if (subscriberCreated) {
    const realtimeMessage: RealtimeMessage = {
      type: "sub",
      newSubscriberCount,
      ...(shareUsername ? { recentSubscriber: username } : {}),
    };
    await runSubscribeSideEffect(operationId, postId, "realtime_publish", () =>
      realtime.send("subscriber_updates", realtimeMessage),
    );
  }

  const state =
    subGoalData.postKind === subscribeOnlyPostKind
      ? await buildSubscribeOnlyState(
          postId,
          subGoalData,
          {
            subscribersOverride: displayedSubscriberCount,
            observedSubscribers: subreddit.numberOfSubscribers,
          },
          { subredditPromise: Promise.resolve(subreddit) },
        )
      : await buildState(
          postId,
          {
            subscribersOverride: displayedSubscriberCount,
            ...(subscriberCreated && shareUsername
              ? { recentSubscriberOverride: username }
              : {}),
          },
          {
            subGoalData,
            subredditPromise: Promise.resolve(subreddit),
            recoveryWorkflow: "subscribe",
            recoveryRoute: apiRoutes.subscribe,
          },
        );
  logSubscribePhase(operationId, postId, "state_built");

  const journeyTelemetryHandled = recordServerSubscribeSuccess(
    journeyId,
    state,
  );
  res.json({
    type: "subscribe",
    postId,
    state,
    journeyTelemetryHandled,
  } satisfies SubscribeResponse);
  logSubscribePhase(operationId, postId, "response_sent");
}
