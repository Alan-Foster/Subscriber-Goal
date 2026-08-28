import type { Router } from "express";
import { context, reddit, redis, realtime } from "@devvit/web/server";
import type {
  ErrorResponse,
  InitResponse,
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
import {
  isTrackedSubscriber,
  markSubscriber,
  setNewSubscriber,
} from "../data/subscriberStats";
import { getSubredditIcon } from "../utils/redditUtils";
import { resolveShareUsername } from "../utils/usernameSharePolicy";
import { subscribeOnlyPostKind } from "../../shared/postKind";

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

const buildSubscribeOnlyState = async (
  subGoalData: Awaited<ReturnType<typeof getSubGoalData>>,
): Promise<SubscribeOnlyState> => {
  const subscribed = context.userId
    ? await isTrackedSubscriber(redis, context.userId)
    : false;
  return {
    colorTheme: subGoalData.colorTheme,
    postHeight: "tiny",
    language: subGoalData.language,
    subscribed,
    authenticated: Boolean(context.userId),
    subreddit: {
      name:
        subGoalData.subredditDisplayName ?? context.subredditName ?? "unknown",
    },
  };
};

export function registerPublicApiRoutes(router: Router): void {
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
        await reddit.subscribeToCurrentSubreddit();
        await markSubscriber(redis, userId);
        res.json({
          type: "subscribe",
          postId,
          state: await buildSubscribeOnlyState(subGoalData),
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

      res.json({
        type: "subscribe",
        postId,
        state,
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
