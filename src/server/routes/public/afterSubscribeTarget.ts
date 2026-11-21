import {
  createDefaultCreatePostAction,
  dynamicAfterSubscribeActionTypes,
} from "../../../shared/afterSubscribeAction";
import type { Request, Router } from "express";
import { context, reddit, redis } from "@devvit/web/server";
import type {
  AfterSubscribeTargetResponse,
  NavigationTarget,
} from "../../../shared/types/api";
import { apiRoutes } from "../../../shared/routes";
import { getPublicAppSettings } from "../../settings";
import { getSubGoalData } from "../../data/subGoalData";
import { isTrackedSubscriber } from "../../data/subscriberStats";
import {
  ctaOnlyPostKind,
  subscriberGoalPostKind,
} from "../../../shared/postKind";
import { isSubredditBlacklisted } from "../../utils/subredditBlacklist";
import { getRecentCommunityPostIds } from "../../data/ctaActivity";
import { logDiagnostic } from "../../../shared/diagnostics";
import {
  getPostAvailability,
  isMissingPostError,
} from "../../utils/postStatus";
import { isNsfwOrUnknown } from "../../utils/subredditSafety";
import { isPrivateSubredditAccessError } from "../../utils/redditPermissionErrors";
import {
  type CurrentSubreddit,
  type SubGoalData,
  effectiveGoalActions,
} from "./state";
import { localizedError } from "./request";

export function registerAfterSubscribeTargetRoutes(router: Router): void {
  router.get(
    apiRoutes.afterSubscribeTarget,
    async (req, res): Promise<void> => {
      const { postId, userId } = context;
      const query = req.query ?? {};
      const hasAutomaticSelector = Object.prototype.hasOwnProperty.call(
        query,
        "automaticAction",
      );
      const selector = query.automaticAction;
      if (isInvalidAutomaticSelector(query, hasAutomaticSelector, selector)) {
        res.status(400).json(localizedError("errors.api.invalidRequest"));
        return;
      }
      if (!postId) {
        res.status(400).json(localizedError("errors.api.postIdRequired"));
        return;
      }
      try {
        const subGoalData = await getSubGoalData(
          redis,
          postId,
          context.postData,
        );
        const subreddit = await reddit.getCurrentSubreddit();
        const actions = effectiveGoalActions(subGoalData, subreddit);
        const canOpenBeforeJoin =
          !hasAutomaticSelector &&
          isNsfwOrUnknown(subreddit.nsfw) &&
          subGoalData.postKind === subscriberGoalPostKind &&
          (subGoalData.postHeight === "regular" ||
            subGoalData.postHeight === "short") &&
          actions.primary.type === "newest-post";
        if (
          (hasAutomaticSelector || subGoalData.postKind !== ctaOnlyPostKind) &&
          (!userId ||
            (!canOpenBeforeJoin && !(await isTrackedSubscriber(redis, userId))))
        ) {
          res.status(403).json(localizedError("errors.join.required"));
          return;
        }
        let action = actions.primary;
        if (hasAutomaticSelector) {
          if (!canUseAutomaticAction(subGoalData)) {
            res.status(403).json(localizedError("errors.api.forbidden"));
            return;
          }
          if (!actions.secondary || actions.secondary.type !== selector) {
            res
              .status(400)
              .json(localizedError("errors.api.dynamicTargetUnsupported"));
            return;
          }
          action = actions.secondary;
        }
        if (action.type !== "top-post-day" && action.type !== "newest-post") {
          res
            .status(400)
            .json(localizedError("errors.api.dynamicTargetUnsupported"));
          return;
        }
        if (
          (hasAutomaticSelector || canOpenBeforeJoin) &&
          (await isSubredditBlacklisted(reddit, subreddit.name))
        ) {
          res.status(403).json(localizedError("errors.api.forbidden"));
          return;
        }
        res.json(
          await resolveDynamicPostDestination(
            action.type,
            postId,
            subreddit,
            subGoalData.language,
          ),
        );
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
        res.status(503).json(localizedError("errors.api.postTargetFailed"));
      }
    },
  );
}

function canUseAutomaticAction(subGoalData: SubGoalData): boolean {
  return (
    subGoalData.postKind === subscriberGoalPostKind &&
    (subGoalData.postHeight === "regular" ||
      subGoalData.postHeight === "short") &&
    !subGoalData.completedTime
  );
}

const dynamicPostCandidateLimit = 25;

const appAccountUsername = "subscriber-goal";

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

async function resolveDynamicPostDestination(
  type: "top-post-day" | "newest-post",
  goalPostId: string,
  subreddit: CurrentSubreddit,
  language: SubGoalData["language"],
): Promise<AfterSubscribeTargetResponse> {
  const allowAppAccountPosts =
    subreddit.name.toLowerCase() ===
    getPublicAppSettings().promoSubreddit.toLowerCase();
  const options = {
    subredditName: subreddit.name,
    limit: dynamicPostCandidateLimit,
    pageSize: dynamicPostCandidateLimit,
  };
  const newestFallback =
    type === "top-post-day" ? { fallbackAction: "newest-post" as const } : {};
  let uncertainty: { error: unknown } | undefined;
  try {
    const timeframes =
      type === "top-post-day"
        ? (["day", "week", undefined] as const)
        : ([undefined] as const);
    for (const timeframe of timeframes) {
      const posts = await (
        timeframe
          ? reddit.getTopPosts({ ...options, timeframe })
          : reddit.getNewPosts(options)
      ).all();
      for (const post of posts) {
        const target = createPostNavigationTarget(
          post,
          goalPostId,
          allowAppAccountPosts,
        );
        if (target)
          return timeframe ? { target } : { target, ...newestFallback };
      }
    }
  } catch (error) {
    logDiagnostic(
      "warn",
      "dynamic_post_listing_failed",
      {
        workflow: "after_subscribe_target",
        phase: "listing",
        postId: goalPostId,
        action: type,
      },
      error,
    );
    if (!isDynamicDestinationAccessDenied(error)) uncertainty = { error };
  }

  for (const candidateId of await getRecentCommunityPostIds(redis)) {
    if (candidateId === goalPostId) continue;
    try {
      const post = await reddit.getPostById(candidateId);
      if (
        !post ||
        post.subredditName?.toLowerCase() !== subreddit.name.toLowerCase()
      )
        continue;
      const target = createPostNavigationTarget(
        post,
        goalPostId,
        allowAppAccountPosts,
        true,
      );
      if (target) return { target, ...newestFallback };
    } catch (error) {
      if (
        isMissingPostError(error, candidateId) ||
        isDynamicDestinationAccessDenied(error)
      )
        continue;
      logDiagnostic(
        "warn",
        "dynamic_post_lookup_failed",
        {
          workflow: "after_subscribe_target",
          phase: "indexed_lookup",
          postId: candidateId,
        },
        error,
      );
      uncertainty ??= { error };
    }
  }
  if (uncertainty) throw uncertainty.error;
  const create = createDefaultCreatePostAction({
    language: language ?? "en",
    subredditName: subreddit.name,
  });
  return { target: { url: create.url }, fallbackAction: "create-post" };
}

function isDynamicDestinationAccessDenied(error: unknown): boolean {
  const response = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
  } | null;
  return (
    Number(response?.status ?? response?.statusCode ?? response?.code) ===
      403 ||
    response?.code === "PERMISSION_DENIED" ||
    isPrivateSubredditAccessError(error)
  );
}

function createPostNavigationTarget(
  post:
    | {
        id?: string;
        authorName?: string;
        hidden?: boolean;
        url?: string;
        permalink?: string | null;
      }
    | undefined,
  goalPostId: string,
  allowAppAccountPosts: boolean,
  requirePermalink = false,
): NavigationTarget | undefined {
  const author = normalizeRedditUsername(post?.authorName);
  if (
    !post ||
    getPostAvailability(post).status !== "active" ||
    post.hidden === true ||
    author === "[deleted]" ||
    (!allowAppAccountPosts && author === appAccountUsername) ||
    post.id?.toLowerCase() === goalPostId.toLowerCase()
  )
    return undefined;
  if (typeof post.permalink === "string" && post.permalink.trim().length > 0) {
    try {
      const permalink = post.permalink.trim();
      const url = new URL(permalink, "https://www.reddit.com");
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        isRedditHostname(url.hostname) &&
        (!requirePermalink ||
          /\/comments\/[a-z0-9]+(?:\/|$)/i.test(url.pathname))
      ) {
        return { url: url.toString(), permalink };
      }
    } catch {
      // diagnostic-allow-silent: malformed candidate URLs fall back to post.url.
      // Fall back to an absolute post URL below.
    }
  }
  return !requirePermalink && hasUsableNavigationUrl(post.url)
    ? { url: post.url }
    : undefined;
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

function isInvalidAutomaticSelector(
  query: Request["query"],
  hasAutomaticSelector: boolean,
  selector: unknown,
): boolean {
  const malformedSelectorKey = Object.keys(query).some((key) =>
    key.startsWith("automaticAction["),
  );
  return (
    malformedSelectorKey ||
    (hasAutomaticSelector &&
      (typeof selector !== "string" ||
        !dynamicAfterSubscribeActionTypes.includes(
          selector as (typeof dynamicAfterSubscribeActionTypes)[number],
        )))
  );
}
