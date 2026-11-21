import type { Router } from "express";
import { context, reddit, redis } from "@devvit/web/server";
import type {
  StatisticsEventRequest,
  StatisticsEventResponse,
  StatisticsResponse,
} from "../../../shared/types/api";
import { apiRoutes } from "../../../shared/routes";
import { getSubGoalData } from "../../data/subGoalData";
import { isTrackedSubscriber } from "../../data/subscriberStats";
import {
  ctaOnlyPostKind,
  subscribeOnlyPostKind,
} from "../../../shared/postKind";
import { logDiagnostic } from "../../../shared/diagnostics";
import { canViewCurrentSubredditStatistics } from "../../utils/statisticsAuthorization";
import {
  getStatisticsReport,
  recordStatisticsCtaClick,
  recordStatisticsJoinClick,
} from "../../data/statisticsAnalytics";
import { localizedError, uuidPattern, visitorIdentity } from "./request";

export function registerStatisticsRoutes(router: Router): void {
  router.post(apiRoutes.statisticsEvent, async (req, res): Promise<void> => {
    const body = req.body as StatisticsEventRequest | undefined;
    if (
      !body ||
      (body.type !== "join_click" && body.type !== "cta_click") ||
      !uuidPattern.test(body.eventId)
    ) {
      res.status(400).json(localizedError("errors.api.invalidRequest"));
      return;
    }
    try {
      if (body.type === "join_click") {
        const postId = context.postId;
        if (!postId) {
          res.status(400).json(localizedError("errors.api.postIdRequired"));
          return;
        }
        const data = await getSubGoalData(redis, postId, context.postData);
        const trackedSubscriber = context.userId
          ? await isTrackedSubscriber(redis, context.userId)
          : false;
        const joinEligible =
          data.postKind !== ctaOnlyPostKind &&
          !trackedSubscriber &&
          (data.postKind === subscribeOnlyPostKind || !data.completedTime);
        if (!joinEligible) {
          res.status(400).json(localizedError("errors.join.unsupported"));
          return;
        }
        const identity = visitorIdentity(req);
        await recordStatisticsJoinClick(redis, {
          eventId: body.eventId,
          postId,
          ...(identity ? { visitorIdentity: identity } : {}),
        });
      } else {
        const postId = context.postId;
        if (!postId) {
          res.status(400).json(localizedError("errors.api.postIdRequired"));
          return;
        }
        const data = await getSubGoalData(redis, postId, context.postData);
        if (data.afterSubscribeAction.type === "disabled") {
          res
            .status(400)
            .json(localizedError("errors.api.ctaActivityUnsupported"));
          return;
        }
        const ctaOnly = data.postKind === ctaOnlyPostKind;
        if (
          !ctaOnly &&
          (!context.userId ||
            !(await isTrackedSubscriber(redis, context.userId)))
        ) {
          res
            .status(400)
            .json(localizedError("errors.api.ctaActivityUnsupported"));
          return;
        }
        const identity = visitorIdentity(req);
        await recordStatisticsCtaClick(redis, {
          eventId: body.eventId,
          postId,
          label: data.afterSubscribeAction.buttonText,
          kind: ctaOnly ? "cta_only" : "secondary",
          ...(identity ? { visitorIdentity: identity } : {}),
        });
      }
      res.json({ status: "ok" } satisfies StatisticsEventResponse);
    } catch (error) {
      logDiagnostic(
        "warn",
        "statistics_event_failed",
        { workflow: "statistics", phase: body.type },
        error,
      );
      res.status(503).json(localizedError("errors.api.requestFailed"));
    }
  });
  router.get(apiRoutes.statistics, async (req, res): Promise<void> => {
    if (!context.userId) {
      res.status(401).json(localizedError("errors.join.loginRequired"));
      return;
    }
    const hours = Number((req.query as Record<string, unknown>)?.hours);
    if (hours !== 24 && hours !== 168) {
      res.status(400).json(localizedError("errors.api.invalidRequest"));
      return;
    }
    try {
      const subreddit = await reddit.getCurrentSubreddit();
      if (
        !(await canViewCurrentSubredditStatistics(
          reddit,
          context.userId,
          subreddit.name,
        ))
      ) {
        res.status(403).json(localizedError("errors.api.forbidden"));
        return;
      }
      res.json(
        (await getStatisticsReport(
          redis,
          subreddit.name,
          hours,
        )) satisfies StatisticsResponse,
      );
    } catch (error) {
      logDiagnostic(
        "error",
        "api_request_failed",
        { route: apiRoutes.statistics, workflow: "statistics", status: 503 },
        error,
      );
      res.status(503).json(localizedError("errors.api.requestFailed"));
    }
  });
}
