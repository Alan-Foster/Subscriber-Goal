import type { Request, Response, Router } from "express";
import { context, reddit, redis } from "@devvit/web/server";
import type { InitResponse } from "../../../shared/types/api";
import { apiRoutes } from "../../../shared/routes";
import { getSubGoalData } from "../../data/subGoalData";
import { isTrackedSubscriber } from "../../data/subscriberStats";
import { getSubredditIcon } from "../../utils/redditUtils";
import {
  ctaOnlyPostKind,
  subscribeOnlyPostKind,
} from "../../../shared/postKind";
import { isSubredditBlacklisted } from "../../utils/subredditBlacklist";
import { createOperationId, logDiagnostic } from "../../../shared/diagnostics";
import {
  recordStatisticsLoad,
  type StatisticsExposure,
} from "../../data/statisticsAnalytics";
import {
  type InitTimings,
  timedInitOperation,
  setInitServerTiming,
  loadCurrentUser,
  buildState,
} from "./state";
import { localizedError, requestHeader, visitorIdentity } from "./request";

export function registerInitRoutes(router: Router): void {
  router.get(apiRoutes.init, handleInit);
}

async function handleInit(req: Request, res: Response): Promise<void> {
  const initStartedAt = performance.now();
  const initTimings: InitTimings = {};
  const { postId } = context;
  if (!postId) {
    logDiagnostic("warn", "api_validation_failed", {
      route: apiRoutes.init,
      workflow: "init",
      phase: "missing_post_id",
      status: 400,
    });
    setInitServerTiming(res, initTimings, initStartedAt);
    res.status(400).json(localizedError("errors.api.postIdMissing"));
    return;
  }

  try {
    const subredditPromise = timedInitOperation(initTimings, "subreddit", () =>
      reddit.getCurrentSubreddit(),
    );
    const goalDataPromise = timedInitOperation(initTimings, "goal_data", () =>
      getSubGoalData(redis, postId, context.postData),
    );
    const trackedSubscriberPromise = timedInitOperation(
      initTimings,
      "subscriber_status",
      () =>
        context.userId
          ? isTrackedSubscriber(redis, context.userId)
          : Promise.resolve(false),
    );
    const blacklistPromise = timedInitOperation(
      initTimings,
      "blacklist",
      async () => {
        const subredditName =
          context.subredditName ?? (await subredditPromise).name;
        return await isSubredditBlacklisted(reddit, subredditName);
      },
    );
    const userContextPromise = goalDataPromise.then(async (subGoalData) =>
      subGoalData.postKind !== subscribeOnlyPostKind &&
      subGoalData.postKind !== ctaOnlyPostKind
        ? await loadCurrentUser(initTimings)
        : {
            user: null,
            moderatorInstallPromoEligible: false,
            isModerator: false,
            moderatedSubreddits: [],
          },
    );
    const subredditIconPromise = Promise.all([
      goalDataPromise,
      subredditPromise,
    ]).then(async ([subGoalData, subreddit]) =>
      subGoalData.postKind !== subscribeOnlyPostKind &&
      subGoalData.postKind !== ctaOnlyPostKind
        ? await timedInitOperation(initTimings, "icon", () =>
            getSubredditIcon(
              reddit,
              subreddit.id,
              (subreddit as { settings?: { communityIcon?: string } }).settings,
            ),
          )
        : null,
    );
    const [
      blacklistResult,
      goalDataResult,
      subredditResult,
      subscriberResult,
      userContextResult,
      subredditIconResult,
    ] = await Promise.allSettled([
      blacklistPromise,
      goalDataPromise,
      subredditPromise,
      trackedSubscriberPromise,
      userContextPromise,
      subredditIconPromise,
    ]);
    if (blacklistResult.status === "rejected") {
      throw blacklistResult.reason;
    }
    if (blacklistResult.value) {
      setInitServerTiming(res, initTimings, initStartedAt);
      res.status(403).json(localizedError("errors.content.prohibited"));
      return;
    }
    if (goalDataResult.status === "rejected") {
      throw goalDataResult.reason;
    }
    if (subredditResult.status === "rejected") {
      throw subredditResult.reason;
    }
    if (subscriberResult.status === "rejected") {
      throw subscriberResult.reason;
    }
    if (userContextResult.status === "rejected") {
      throw userContextResult.reason;
    }
    if (subredditIconResult.status === "rejected") {
      throw subredditIconResult.reason;
    }
    const state = await buildState(postId, undefined, {
      subGoalData: goalDataResult.value,
      subredditPromise: Promise.resolve(subredditResult.value),
      trackedSubscriberPromise: Promise.resolve(subscriberResult.value),
      ...(subredditIconResult.value === null
        ? {}
        : {
            userContextPromise: Promise.resolve(userContextResult.value),
            subredditIconPromise: Promise.resolve(subredditIconResult.value),
          }),
      timings: initTimings,
      recoveryWorkflow: "init",
      recoveryRoute: apiRoutes.init,
    });
    setInitServerTiming(res, initTimings, initStartedAt);
    res.json({
      type: "init",
      postId,
      state,
    } satisfies InitResponse);
    await recordInitStatistics(req, postId, state, subscriberResult.value);
  } catch (error) {
    const operationId = createOperationId("init");
    logDiagnostic(
      "error",
      "api_request_failed",
      {
        operationId,
        route: apiRoutes.init,
        workflow: "init",
        postId,
        status: 503,
      },
      error,
    );
    setInitServerTiming(res, initTimings, initStartedAt);
    res
      .status(503)
      .json(localizedError("errors.api.initializationFailed", { operationId }));
  }
}

async function recordInitStatistics(
  req: Request,
  postId: NonNullable<typeof context.postId>,
  state: InitResponse["state"],
  appTrackedSubscribed: boolean,
): Promise<void> {
  const loadEventId = requestHeader(req, "X-SG-Event-ID");
  if (loadEventId) {
    try {
      const identity = visitorIdentity(req);
      await recordStatisticsLoad(redis, {
        eventId: loadEventId,
        postId,
        appTrackedSubscribed,
        exposure: statisticsExposure(
          state,
          appTrackedSubscribed,
          Boolean(context.userId),
        ),
        ...(identity ? { visitorIdentity: identity } : {}),
      });
    } catch (error) {
      logDiagnostic(
        "warn",
        "statistics_event_failed",
        { workflow: "statistics", phase: "load" },
        error,
      );
    }
  }
}

/**
 * Which tracked buttons this load shows, mirroring the client layouts.
 * Signed-in viewers who have not joined see the follow-up CTA beside Join on
 * active regular and short goals; logged-out viewers see sign-in buttons
 * instead, and Tiny posts show Join alone until the viewer joins.
 */
function statisticsExposure(
  state: InitResponse["state"],
  appTrackedSubscribed: boolean,
  signedIn: boolean,
): StatisticsExposure {
  const ctaConfigured = state.afterSubscribeAction.type !== "disabled";
  if (state.postHeight === "cta") return ctaConfigured ? "cta_only" : "none";
  if (appTrackedSubscribed) return ctaConfigured ? "secondary_cta" : "none";
  if (state.postHeight !== "tiny" && state.completedTime !== null)
    return "none";
  return ctaConfigured && signedIn && state.postHeight !== "tiny"
    ? "join_and_secondary_cta"
    : "join";
}
