import type { Router } from "express";
import { context, reddit, redis, realtime } from "@devvit/web/server";
import type {
  ErrorResponse,
  AfterSubscribeTargetResponse,
  CtaOnlyState,
  InitResponse,
  NavigationTarget,
  RefreshResponse,
  RealtimeMessage,
  RecordCtaClickResponse,
  SubGoalState,
  SubscribeOnlyState,
  SubscribeRequest,
  SubscribeResponse,
} from "../../shared/types/api";
import { apiRoutes } from "../../shared/routes";
import { getPublicAppSettings } from "../settings";
import { checkCompletionStatus, getSubGoalData } from "../data/subGoalData";
import { isTrackedSubscriber, setNewSubscriber } from "../data/subscriberStats";
import {
  getUtcDayStartMs,
  observeDailySubscriberCount,
} from "../data/subscriberDailyStats";
import { getSubredditIcon } from "../utils/redditUtils";
import { resolveShareUsername } from "../utils/usernameSharePolicy";
import { ctaOnlyPostKind, subscribeOnlyPostKind } from "../../shared/postKind";
import { prohibitedContentMessage } from "../../shared/contentPolicy";
import { isSubredditBlacklisted } from "../utils/subredditBlacklist";
import {
  getRequestJourneyId,
  recordServerSubscribeSuccess,
} from "../analytics/goalJourneyAnalytics";
import {
  getCtaActivityMetric,
  isClickActivityPreset,
  recordCtaClick,
} from "../data/ctaActivity";
import {
  hasSubscriptionAttemptReceipt,
  isValidSubscriptionAttemptId,
  storeSubscriptionAttemptReceipt,
} from "../data/subscriptionAttempt";
import { createOperationId, logDiagnostic } from "../../shared/diagnostics";

const buildState = async (
  postId: string,
  options?: {
    subscribersOverride?: number;
    recentSubscriberOverride?: string;
  },
): Promise<SubGoalState> => {
  const subGoalData = await getSubGoalData(redis, postId, context.postData);
  if (subGoalData.postKind === subscribeOnlyPostKind) {
    return await buildSubscribeOnlyState(postId, subGoalData);
  }
  if (subGoalData.postKind === ctaOnlyPostKind) {
    return await buildCtaOnlyState(postId, subGoalData);
  }

  const subreddit = await reddit.getCurrentSubreddit();
  const subredditIcon = await getSubredditIcon(
    reddit,
    subreddit.id,
    (subreddit as { settings?: { communityIcon?: string } }).settings,
  );
  const appSettings = getPublicAppSettings();
  const username = context.userId ? await reddit.getCurrentUsername() : null;
  const user =
    context.userId && username ? { id: context.userId, username } : null;
  const subscribed = user?.id
    ? await isTrackedSubscriber(redis, user.id)
    : false;

  return {
    goal: subGoalData.goal > 0 ? subGoalData.goal : null,
    recentSubscriber:
      options?.recentSubscriberOverride ??
      (subGoalData.recentSubscriber && subGoalData.recentSubscriber.length > 0
        ? subGoalData.recentSubscriber
        : null),
    completedTime: subGoalData.completedTime ? subGoalData.completedTime : null,
    headerText: subGoalData.headerText ?? null,
    colorTheme: subGoalData.colorTheme,
    afterSubscribeAction: subGoalData.afterSubscribeAction,
    trackCtaClicks: isClickActivityPreset(subGoalData.afterSubscribePreset),
    postHeight: subGoalData.postHeight === "short" ? "short" : "regular",
    language: subGoalData.language,
    subscribed,
    user,
    appSettings,
    subreddit: {
      id: subreddit.id,
      name: subGoalData.subredditDisplayName ?? subreddit.name,
      icon: subredditIcon,
      subscribers:
        options?.subscribersOverride ?? subreddit.numberOfSubscribers,
      isNsfw: (subreddit as { isNsfw?: boolean }).isNsfw === true,
    },
  };
};

const dynamicPostCandidateLimit = 25;
const appAccountUsername = "subscriber-goal";

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

const buildSubscribeOnlyState = async (
  postId: string,
  subGoalData: Awaited<ReturnType<typeof getSubGoalData>>,
  options?: {
    subscribersOverride?: number;
    observedSubscribers?: number;
  },
): Promise<SubscribeOnlyState> => {
  const subscribed = context.userId
    ? await isTrackedSubscriber(redis, context.userId)
    : false;
  const currentSubscribers =
    options?.observedSubscribers ??
    (await reddit.getCurrentSubreddit()).numberOfSubscribers;
  const subscribers = options?.subscribersOverride ?? currentSubscribers;
  const { growth } = await observeDailySubscriberCount(
    redis,
    currentSubscribers,
    { displayedSubscribers: subscribers },
  );
  return {
    colorTheme: subGoalData.colorTheme,
    afterSubscribeAction: subGoalData.afterSubscribeAction,
    trackCtaClicks: isClickActivityPreset(subGoalData.afterSubscribePreset),
    postHeight: "tiny",
    promoSubreddit: getPublicAppSettings().promoSubreddit,
    language: subGoalData.language,
    subscribed,
    authenticated: Boolean(context.userId),
    ctaActivity: await getCtaActivityMetric(
      redis,
      postId,
      subGoalData.afterSubscribePreset,
    ),
    subreddit: {
      name:
        subGoalData.subredditDisplayName ?? context.subredditName ?? "unknown",
      subscribers,
      growth,
    },
  };
};

const buildCtaOnlyState = async (
  postId: string,
  subGoalData: Awaited<ReturnType<typeof getSubGoalData>>,
): Promise<CtaOnlyState> => {
  const subreddit = await reddit.getCurrentSubreddit();
  const { growth } = await observeDailySubscriberCount(
    redis,
    subreddit.numberOfSubscribers,
    { displayedSubscribers: subreddit.numberOfSubscribers },
  );
  return {
    colorTheme: subGoalData.colorTheme,
    afterSubscribeAction: subGoalData.afterSubscribeAction,
    trackCtaClicks: isClickActivityPreset(subGoalData.afterSubscribePreset),
    postHeight: "cta",
    promoSubreddit: getPublicAppSettings().promoSubreddit,
    ctaActivity: await getCtaActivityMetric(
      redis,
      postId,
      subGoalData.afterSubscribePreset,
    ),
    language: subGoalData.language,
    subreddit: {
      name: subGoalData.subredditDisplayName ?? subreddit.name,
      subscribers: subreddit.numberOfSubscribers,
      growth,
    },
  };
};

export function registerPublicApiRoutes(router: Router): void {
  router.post(apiRoutes.ctaClick, async (_req, res): Promise<void> => {
    const { postId } = context;
    if (!postId) {
      res.status(400).json({
        status: "error",
        message: "postId is required",
      } satisfies ErrorResponse);
      return;
    }
    try {
      const subGoalData = await getSubGoalData(redis, postId, context.postData);
      if (
        subGoalData.afterSubscribeAction.type === "disabled" ||
        !isClickActivityPreset(subGoalData.afterSubscribePreset)
      ) {
        res.status(400).json({
          status: "error",
          message: "This CTA does not use click activity.",
        } satisfies ErrorResponse);
        return;
      }
      await recordCtaClick(redis, postId);
      res.json({ status: "ok" } satisfies RecordCtaClickResponse);
    } catch (error) {
      logDiagnostic(
        "error",
        "api_request_failed",
        { route: apiRoutes.ctaClick, workflow: "cta_click", postId, status: 503 },
        error,
      );
      res.status(503).json({
        status: "error",
        message: "The CTA click could not be recorded.",
      } satisfies ErrorResponse);
    }
  });

  router.get(
    apiRoutes.afterSubscribeTarget,
    async (_req, res): Promise<void> => {
      const { postId, userId } = context;
      if (!postId) {
        res.status(400).json({
          status: "error",
          message: "postId is required",
        } satisfies ErrorResponse);
        return;
      }
      try {
        const subGoalData = await getSubGoalData(
          redis,
          postId,
          context.postData,
        );
        if (
          subGoalData.postKind !== ctaOnlyPostKind &&
          (!userId || !(await isTrackedSubscriber(redis, userId)))
        ) {
          res.status(403).json({
            status: "error",
            message: "Subscription is required.",
          } satisfies ErrorResponse);
          return;
        }
        const action = subGoalData.afterSubscribeAction;
        if (action.type !== "top-post-day" && action.type !== "newest-post") {
          res.status(400).json({
            status: "error",
            message: "This button does not use a dynamic post target.",
          } satisfies ErrorResponse);
          return;
        }
        const subreddit = await reddit.getCurrentSubreddit();
        let target: NavigationTarget | undefined;
        if (action.type === "top-post-day") {
          const candidates = await reddit
            .getTopPosts({
              subredditName: subreddit.name,
              timeframe: "day",
              limit: dynamicPostCandidateLimit,
              pageSize: dynamicPostCandidateLimit,
            })
            .all();
          const promoSubreddit = getPublicAppSettings().promoSubreddit;
          const allowAppAccountPosts =
            subreddit.name.toLowerCase() === promoSubreddit.toLowerCase();

          for (const candidate of candidates) {
            if (candidate.id.toLowerCase() === postId.toLowerCase()) continue;
            if (
              !allowAppAccountPosts &&
              normalizeRedditUsername(candidate.authorName) ===
                appAccountUsername
            ) {
              continue;
            }
            target = createPostNavigationTarget(candidate);
            if (target) break;
          }
        } else {
          const candidates = await reddit
            .getNewPosts({
              subredditName: subreddit.name,
              limit: dynamicPostCandidateLimit,
              pageSize: dynamicPostCandidateLimit,
            })
            .all();
          const todayStartMs = getUtcDayStartMs(Date.now());
          for (const candidate of candidates) {
            if (
              typeof candidate.id === "string" &&
              candidate.id.toLowerCase() === postId.toLowerCase()
            ) {
              continue;
            }
            const createdAtMs = normalizePostCreatedAtMs(candidate.createdAt);
            if (createdAtMs === null || createdAtMs < todayStartMs) {
              continue;
            }
            target = createPostNavigationTarget(candidate);
            if (target) break;
          }
        }
        if (!target) {
          res.status(404).json({
            status: "error",
            message: "No post is currently available.",
          } satisfies ErrorResponse);
          return;
        }
        res.json({
          target,
        } satisfies AfterSubscribeTargetResponse);
      } catch (error) {
        logDiagnostic(
          "error",
          "api_request_failed",
          {
            route: apiRoutes.afterSubscribeTarget,
            workflow: "after_subscribe_target",
            postId,
            status: 503,
          },
          error,
        );
        res.status(503).json({
          status: "error",
          message: "The post target could not be loaded.",
        } satisfies ErrorResponse);
      }
    },
  );

  router.get(apiRoutes.init, async (_req, res): Promise<void> => {
    const { postId } = context;
    if (!postId) {
      logDiagnostic("warn", "api_validation_failed", {
        route: apiRoutes.init,
        workflow: "init",
        phase: "missing_post_id",
        status: 400,
      });
      res.status(400).json({
        status: "error",
        message: "postId is required but missing from context",
      } satisfies ErrorResponse);
      return;
    }

    try {
      const subredditName =
        context.subredditName ?? (await reddit.getCurrentSubreddit()).name;
      if (await isSubredditBlacklisted(reddit, subredditName)) {
        res.status(403).json({
          status: "error",
          message: prohibitedContentMessage,
        } satisfies ErrorResponse);
        return;
      }
      const state = await buildState(postId);
      res.json({
        type: "init",
        postId,
        state,
      } satisfies InitResponse);
    } catch (error) {
      const operationId = createOperationId("init");
      logDiagnostic(
        "error",
        "api_request_failed",
        { operationId, route: apiRoutes.init, workflow: "init", postId, status: 503 },
        error,
      );
      res.status(503).json({
        status: "error",
        message: `Initialization could not be completed. Reference: ${operationId}`,
      } satisfies ErrorResponse);
    }
  });

  router.get(apiRoutes.refresh, async (req, res): Promise<void> => {
    const { postId } = context;
    if (!postId) {
      logDiagnostic("warn", "api_validation_failed", {
        route: apiRoutes.refresh,
        workflow: "refresh",
        phase: "missing_post_id",
        status: 400,
      });
      res.status(400).json({
        status: "error",
        message: "postId is required but missing from context",
      } satisfies ErrorResponse);
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
        res.status(400).json({
          status: "error",
          message: "Invalid subscription attempt ID.",
        } satisfies ErrorResponse);
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

      const state = await buildState(postId);
      res.json({
        type: "refresh",
        postId,
        state,
        ...attemptConfirmation,
      } satisfies RefreshResponse);
    } catch (error) {
      const operationId = createOperationId("refresh");
      logDiagnostic(
        "error",
        "api_request_failed",
        { operationId, route: apiRoutes.refresh, workflow: "refresh", postId, status: 503 },
        error,
      );
      res.status(503).json({
        status: "error",
        message: `Refresh could not be completed. Reference: ${operationId}`,
      } satisfies ErrorResponse);
    }
  });

  router.post(apiRoutes.subscribe, async (req, res): Promise<void> => {
    const { postId, userId } = context;
    const journeyId = getRequestJourneyId(req);
    const operationId = createOperationId("subscribe");
    if (!postId) {
      res.status(400).json({
        status: "error",
        message: "postId is required but missing from context",
      } satisfies ErrorResponse);
      return;
    }

    try {
      logSubscribePhase(operationId, postId, "started");
      const subGoalData = await getSubGoalData(redis, postId, context.postData);
      const body = req.body as SubscribeRequest | undefined;
      const attemptId = body?.attemptId;
      if (attemptId !== undefined && !isValidSubscriptionAttemptId(attemptId)) {
        res.status(400).json({
          status: "error",
          message: "Invalid subscription attempt ID.",
        } satisfies ErrorResponse);
        return;
      }
      if (attemptId) {
        logSubscribePhase(operationId, postId, "attempt_validated", {
          attemptRef: attemptId.slice(0, 8),
        });
      }
      if (subGoalData.postKind === ctaOnlyPostKind) {
        res.status(400).json({
          status: "error",
          message: "This post does not support subscribing.",
        } satisfies ErrorResponse);
        return;
      }
      if (!userId) {
        res.status(401).json({
          status: "error",
          message: "Please log in to subscribe.",
        } satisfies ErrorResponse);
        return;
      }
      if (subGoalData.postKind === subscribeOnlyPostKind) {
        const username = await reddit.getCurrentUsername();
        if (!username) {
          res.status(400).json({
            status: "error",
            message: "Unable to resolve username.",
          } satisfies ErrorResponse);
          return;
        }

        await reddit.subscribeToCurrentSubreddit();
        logSubscribePhase(operationId, postId, "reddit_subscribed");
        if (attemptId) {
          await storeSubscriptionAttemptReceipt(
            redis,
            attemptId,
            postId,
            userId,
          );
          logSubscribePhase(operationId, postId, "attempt_receipt_stored");
        }
        const subreddit = await reddit.getCurrentSubreddit();
        const sourceSubredditIsNsfw =
          (subreddit as { isNsfw?: boolean }).isNsfw === true;
        const newSubscriberCount = subreddit.numberOfSubscribers + 1;
        const shareUsername = !sourceSubredditIsNsfw;

        const subscriberCreated = await setNewSubscriber(
          redis,
          postId,
          newSubscriberCount,
          { id: userId, username },
          shareUsername,
        );
        logSubscribePhase(operationId, postId, "tracking_complete", {
          subscriberCreated,
        });

        const displayedSubscriberCount = subscriberCreated
          ? newSubscriberCount
          : subreddit.numberOfSubscribers;

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

        const state = await buildSubscribeOnlyState(postId, subGoalData, {
          subscribersOverride: displayedSubscriberCount,
          observedSubscribers: subreddit.numberOfSubscribers,
        });
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
        return;
      }

      const username = await reddit.getCurrentUsername();
      if (!username) {
        res.status(400).json({
          status: "error",
          message: "Unable to resolve username.",
        } satisfies ErrorResponse);
        return;
      }

      const shareUsername = body?.shareUsername === true;

      await reddit.subscribeToCurrentSubreddit();
      logSubscribePhase(operationId, postId, "reddit_subscribed");
      if (attemptId) {
        await storeSubscriptionAttemptReceipt(redis, attemptId, postId, userId);
        logSubscribePhase(operationId, postId, "attempt_receipt_stored");
      }

      const subreddit = await reddit.getCurrentSubreddit();
      const sourceSubredditIsNsfw =
        (subreddit as { isNsfw?: boolean }).isNsfw === true;
      const effectiveShareUsername = resolveShareUsername(
        shareUsername,
        sourceSubredditIsNsfw,
      );
      const newSubscriberCount = subreddit.numberOfSubscribers + 1;

      const subscriberCreated = await setNewSubscriber(
        redis,
        postId,
        newSubscriberCount,
        {
          id: userId,
          username,
        },
        effectiveShareUsername,
      );
      logSubscribePhase(operationId, postId, "tracking_complete", { subscriberCreated });

      const displayedSubscriberCount = subscriberCreated
        ? newSubscriberCount
        : subreddit.numberOfSubscribers;

      if (
        subscriberCreated &&
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
          ...(effectiveShareUsername ? { recentSubscriber: username } : {}),
        };
        await runSubscribeSideEffect(operationId, postId, "realtime_publish", () =>
          realtime.send("subscriber_updates", realtimeMessage),
        );
      }

      const state = await buildState(postId, {
        subscribersOverride: displayedSubscriberCount,
        ...(subscriberCreated && effectiveShareUsername
          ? { recentSubscriberOverride: username }
          : {}),
      });
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
    } catch (error) {
      logDiagnostic(
        "error",
        "api_request_failed",
        { operationId, route: apiRoutes.subscribe, workflow: "subscribe", postId, status: 503 },
        error,
      );
      res.status(503).json({
        status: "error",
        message: `Subscription could not be completed. Reference: ${operationId}`,
      } satisfies ErrorResponse);
    }
  });
}

function hasUsableNavigationUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.length > 0
    );
  } catch {
    // diagnostic-allow-silent: URL parsing is an expected validation probe.
    return false;
  }
}

function normalizePostCreatedAtMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function createPostNavigationTarget(
  post:
    | {
        url?: string;
        permalink?: string | null;
      }
    | undefined,
): NavigationTarget | undefined {
  if (typeof post?.permalink === "string" && post.permalink.trim().length > 0) {
    try {
      const permalink = post.permalink.trim();
      const url = new URL(permalink, "https://www.reddit.com");
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        isRedditHostname(url.hostname)
      ) {
        return { url: url.toString(), permalink };
      }
    } catch {
      // diagnostic-allow-silent: malformed candidate URLs fall back to post.url.
      // Fall back to an absolute post URL below.
    }
  }
  return hasUsableNavigationUrl(post?.url) ? { url: post.url } : undefined;
}

function isRedditHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname === "reddit.com" ||
    normalizedHostname.endsWith(".reddit.com")
  );
}

function normalizeRedditUsername(value: unknown): string {
  return typeof value === "string"
    ? value
        .trim()
        .replace(/^\/?u\//i, "")
        .toLowerCase()
    : "";
}
