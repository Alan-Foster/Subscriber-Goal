import type { Router } from "express";
import { context, reddit, redis, realtime } from "@devvit/web/server";
import type {
  ErrorResponse,
  AfterSubscribeTargetResponse,
  InitResponse,
  NavigationTarget,
  RefreshResponse,
  RealtimeMessage,
  SubGoalState,
  SubscribeOnlyState,
  SubscribeRequest,
  SubscribeResponse,
} from "../../shared/types/api";
import { apiRoutes } from "../../shared/routes";
import { getPublicAppSettings } from "../settings";
import { checkCompletionStatus, getSubGoalData } from "../data/subGoalData";
import { isTrackedSubscriber, setNewSubscriber } from "../data/subscriberStats";
import { observeDailySubscriberCount } from "../data/subscriberDailyStats";
import { getSubredditIcon } from "../utils/redditUtils";
import { resolveShareUsername } from "../utils/usernameSharePolicy";
import { subscribeOnlyPostKind } from "../../shared/postKind";
import { prohibitedContentMessage } from "../../shared/contentPolicy";
import { isSubredditBlacklisted } from "../utils/subredditBlacklist";
import {
  getRequestJourneyId,
  recordServerSubscribeSuccess,
} from "../analytics/goalJourneyAnalytics";

const buildState = async (
  postId: string,
  options?: {
    subscribersOverride?: number;
    recentSubscriberOverride?: string;
  },
): Promise<SubGoalState> => {
  const subGoalData = await getSubGoalData(redis, postId, context.postData);
  if (subGoalData.postKind === subscribeOnlyPostKind) {
    return await buildSubscribeOnlyState(subGoalData);
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

const buildSubscribeOnlyState = async (
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
    postHeight: "tiny",
    promoSubreddit: getPublicAppSettings().promoSubreddit,
    language: subGoalData.language,
    subscribed,
    authenticated: Boolean(context.userId),
    subreddit: {
      name:
        subGoalData.subredditDisplayName ?? context.subredditName ?? "unknown",
      subscribers,
      growth,
    },
  };
};

export function registerPublicApiRoutes(router: Router): void {
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
      if (!userId) {
        res.status(403).json({
          status: "error",
          message: "Subscription is required.",
        } satisfies ErrorResponse);
        return;
      }
      try {
        if (!(await isTrackedSubscriber(redis, userId))) {
          res.status(403).json({
            status: "error",
            message: "Subscription is required.",
          } satisfies ErrorResponse);
          return;
        }
        const subGoalData = await getSubGoalData(
          redis,
          postId,
          context.postData,
        );
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
          const [targetPost] = await reddit
            .getNewPosts({
              subredditName: subreddit.name,
              limit: 1,
              pageSize: 1,
            })
            .all();
          target = createPostNavigationTarget(targetPost);
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
        console.error(
          `After-subscribe target error for post ${postId}:`,
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
      console.warn("[api/init] returning 400 validation_error: missing postId");
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
      console.error(`API Init Error for post ${postId}:`, error);
      const errorMessage =
        error instanceof Error
          ? `Initialization failed: ${error.message}`
          : "Unknown error during initialization";
      console.warn(
        `[api/init] returning 503 runtime_failure: postId=${postId} message=${errorMessage}`,
      );
      res.status(503).json({
        status: "error",
        message: errorMessage,
      } satisfies ErrorResponse);
    }
  });

  router.get(apiRoutes.refresh, async (_req, res): Promise<void> => {
    const { postId } = context;
    if (!postId) {
      console.warn(
        "[api/refresh] returning 400 validation_error: missing postId",
      );
      res.status(400).json({
        status: "error",
        message: "postId is required but missing from context",
      } satisfies ErrorResponse);
      return;
    }

    try {
      const subGoalData = await getSubGoalData(redis, postId, context.postData);
      if (subGoalData.postKind === subscribeOnlyPostKind) {
        res.json({
          type: "refresh",
          postId,
          state: await buildSubscribeOnlyState(subGoalData),
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
      } satisfies RefreshResponse);
    } catch (error) {
      console.error(`API Refresh Error for post ${postId}:`, error);
      const errorMessage =
        error instanceof Error
          ? `Refresh failed: ${error.message}`
          : "Unknown error during refresh";
      console.warn(
        `[api/refresh] returning 503 runtime_failure: postId=${postId} message=${errorMessage}`,
      );
      res.status(503).json({
        status: "error",
        message: errorMessage,
      } satisfies ErrorResponse);
    }
  });

  router.post(apiRoutes.subscribe, async (req, res): Promise<void> => {
    const { postId, userId } = context;
    const journeyId = getRequestJourneyId(req);
    if (!postId) {
      res.status(400).json({
        status: "error",
        message: "postId is required but missing from context",
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

    try {
      const subGoalData = await getSubGoalData(redis, postId, context.postData);
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
        const subreddit = await reddit.getCurrentSubreddit();
        const sourceSubredditIsNsfw =
          (subreddit as { isNsfw?: boolean }).isNsfw === true;
        const newSubscriberCount = subreddit.numberOfSubscribers + 1;
        const shareUsername = !sourceSubredditIsNsfw;

        await setNewSubscriber(
          redis,
          postId,
          newSubscriberCount,
          { id: userId, username },
          shareUsername,
        );

        const realtimeMessage: RealtimeMessage = {
          type: "sub",
          newSubscriberCount,
          ...(shareUsername ? { recentSubscriber: username } : {}),
        };
        await realtime.send("subscriber_updates", realtimeMessage);

        const state = await buildSubscribeOnlyState(subGoalData, {
          subscribersOverride: newSubscriberCount,
          observedSubscribers: subreddit.numberOfSubscribers,
        });
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

      const body = req.body as SubscribeRequest | undefined;
      const shareUsername = body?.shareUsername === true;

      await reddit.subscribeToCurrentSubreddit();

      const subreddit = await reddit.getCurrentSubreddit();
      const sourceSubredditIsNsfw =
        (subreddit as { isNsfw?: boolean }).isNsfw === true;
      const effectiveShareUsername = resolveShareUsername(
        shareUsername,
        sourceSubredditIsNsfw,
      );
      const newSubscriberCount = subreddit.numberOfSubscribers + 1;

      await setNewSubscriber(
        redis,
        postId,
        newSubscriberCount,
        {
          id: userId,
          username,
        },
        effectiveShareUsername,
      );

      if (subGoalData.goal && newSubscriberCount >= subGoalData.goal) {
        await checkCompletionStatus(reddit, redis, postId);
      }

      const realtimeMessage: RealtimeMessage = {
        type: "sub",
        newSubscriberCount,
        ...(effectiveShareUsername ? { recentSubscriber: username } : {}),
      };
      await realtime.send("subscriber_updates", realtimeMessage);

      const state = await buildState(postId, {
        subscribersOverride: newSubscriberCount,
        ...(effectiveShareUsername
          ? { recentSubscriberOverride: username }
          : {}),
      });

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
    } catch (error) {
      console.error(`Subscribe Error for post ${postId}:`, error);
      const errorMessage =
        error instanceof Error
          ? `Subscription failed: ${error.message}`
          : "Subscription failed.";
      res.status(400).json({
        status: "error",
        message: errorMessage,
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
    return false;
  }
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
