import type { Response, Router } from "express";
import { context, reddit, redis, realtime } from "@devvit/web/server";
import { notifications } from "@devvit/notifications";
import type {
  ErrorResponse,
  AfterSubscribeTargetResponse,
  CtaOnlyState,
  InitResponse,
  NavigationTarget,
  NotificationSettingsRequest,
  NotificationSettingsResponse,
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
import { observeDailySubscriberCount } from "../data/subscriberDailyStats";
import { getSubredditIcon } from "../utils/redditUtils";
import { resolveShareUsername } from "../utils/usernameSharePolicy";
import { ctaOnlyPostKind, subscribeOnlyPostKind } from "../../shared/postKind";
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
import { getCurrentSubredditNsfw } from "../utils/subredditSafety";
import { translate, type MessageKey } from "../../shared/i18n/catalog";

const localizedError = (
  messageKey: MessageKey,
  messageParams: Record<string, string | number> = {},
): ErrorResponse => ({
  status: "error",
  message: translate("en", messageKey, messageParams),
  messageKey,
  ...(Object.keys(messageParams).length > 0 ? { messageParams } : {}),
});

type InitTimingName =
  | "goal_data"
  | "blacklist"
  | "subreddit"
  | "user"
  | "subscriber_status"
  | "icon";
type InitTimings = Partial<Record<InitTimingName, number>>;

const timedInitOperation = async <T>(
  timings: InitTimings | undefined,
  name: InitTimingName,
  operation: () => Promise<T>,
): Promise<T> => {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    if (timings) timings[name] = performance.now() - startedAt;
  }
};

const setInitServerTiming = (
  res: Response,
  timings: InitTimings,
  startedAt: number,
): void => {
  const names: InitTimingName[] = [
    "goal_data",
    "blacklist",
    "subreddit",
    "user",
    "subscriber_status",
    "icon",
  ];
  const entries = names.map(
    (name) => `${name};dur=${(timings[name] ?? 0).toFixed(1)}`,
  );
  entries.push(`total;dur=${(performance.now() - startedAt).toFixed(1)}`);
  res.setHeader?.("Server-Timing", entries.join(", "));
};

type CurrentSubreddit = Awaited<ReturnType<typeof reddit.getCurrentSubreddit>>;
type SubGoalData = Awaited<ReturnType<typeof getSubGoalData>>;
type CurrentUserContext = {
  user: { id: string; username: string } | null;
  moderatorInstallPromoEligible: boolean;
};
type BuildStateDependencies = {
  subGoalData?: SubGoalData;
  subredditPromise?: Promise<CurrentSubreddit>;
  trackedSubscriberPromise?: Promise<boolean>;
  userContextPromise?: Promise<CurrentUserContext>;
  subredditIconPromise?: Promise<string>;
  timings?: InitTimings;
};

const loadCurrentUser = async (
  timings?: InitTimings,
): Promise<CurrentUserContext> => {
  if (!context.userId) {
    return { user: null, moderatorInstallPromoEligible: false };
  }

  return await timedInitOperation(timings, "user", async () => {
    try {
      const currentUser = await reddit.getCurrentUser();
      if (currentUser?.username) {
        const moderatorInstallPromoEligible = currentUser.isModerator === true;
        return {
          user: {
            id: context.userId as string,
            username: currentUser.username,
          },
          moderatorInstallPromoEligible,
        };
      }
    } catch (error) {
      logDiagnostic(
        "warn",
        "moderator_install_promo_eligibility_failed",
        {
          workflow: "moderator_install_promo",
          phase: "eligibility",
          authenticated: true,
          eligible: false,
        },
        error,
      );
    }

    const username = await reddit.getCurrentUsername();
    return {
      user: username ? { id: context.userId as string, username } : null,
      moderatorInstallPromoEligible: false,
    };
  });
};

const buildState = async (
  postId: string,
  options?: {
    subscribersOverride?: number;
    recentSubscriberOverride?: string;
  },
  dependencies: BuildStateDependencies = {},
): Promise<SubGoalState> => {
  const subGoalData =
    dependencies.subGoalData ??
    (await getSubGoalData(redis, postId, context.postData));
  if (subGoalData.postKind === subscribeOnlyPostKind) {
    return await buildSubscribeOnlyState(postId, subGoalData, undefined, {
      subredditPromise: dependencies.subredditPromise,
      trackedSubscriberPromise: dependencies.trackedSubscriberPromise,
    });
  }
  if (subGoalData.postKind === ctaOnlyPostKind) {
    return await buildCtaOnlyState(
      postId,
      subGoalData,
      dependencies.subredditPromise,
    );
  }

  const subredditPromise =
    dependencies.subredditPromise ?? reddit.getCurrentSubreddit();
  const userPromise =
    dependencies.userContextPromise ?? loadCurrentUser(dependencies.timings);
  const subscribedPromise =
    dependencies.trackedSubscriberPromise ??
    (context.userId
      ? timedInitOperation(dependencies.timings, "subscriber_status", () =>
          isTrackedSubscriber(redis, context.userId as string),
        )
      : Promise.resolve(false));
  const iconPromise =
    dependencies.subredditIconPromise ??
    timedInitOperation(dependencies.timings, "icon", async () => {
      const subreddit = await subredditPromise;
      return await getSubredditIcon(
        reddit,
        subreddit.id,
        (subreddit as { settings?: { communityIcon?: string } }).settings,
      );
    });
  const [subreddit, subredditIcon, userContext, subscribed] = await Promise.all(
    [subredditPromise, iconPromise, userPromise, subscribedPromise],
  );
  const appSettings = getPublicAppSettings();

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
    moderatorInstallPromoEligible: userContext.moderatorInstallPromoEligible,
    user: userContext.user,
    appSettings,
    subreddit: {
      id: subreddit.id,
      name: subGoalData.subredditDisplayName ?? subreddit.name,
      icon: subredditIcon,
      subscribers:
        options?.subscribersOverride ?? subreddit.numberOfSubscribers,
      isNsfw: getCurrentSubredditNsfw(subreddit) === true,
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
  dependencies: {
    subredditPromise?: Promise<CurrentSubreddit> | undefined;
    trackedSubscriberPromise?: Promise<boolean> | undefined;
  } = {},
): Promise<SubscribeOnlyState> => {
  const subscribedPromise =
    dependencies.trackedSubscriberPromise ??
    (context.userId
      ? isTrackedSubscriber(redis, context.userId)
      : Promise.resolve(false));
  const subredditPromise =
    options?.observedSubscribers === undefined
      ? (dependencies.subredditPromise ?? reddit.getCurrentSubreddit())
      : null;
  const [subscribed, subreddit] = await Promise.all([
    subscribedPromise,
    subredditPromise,
  ]);
  const currentSubscribers =
    options?.observedSubscribers ?? subreddit?.numberOfSubscribers ?? 0;
  const subscribers = options?.subscribersOverride ?? currentSubscribers;
  const [dailySubscribers, ctaActivity] = await Promise.all([
    observeDailySubscriberCount(redis, currentSubscribers, {
      displayedSubscribers: subscribers,
    }),
    getCtaActivityMetric(redis, postId, subGoalData.afterSubscribePreset),
  ]);
  return {
    colorTheme: subGoalData.colorTheme,
    afterSubscribeAction: subGoalData.afterSubscribeAction,
    trackCtaClicks: isClickActivityPreset(subGoalData.afterSubscribePreset),
    postHeight: "tiny",
    promoSubreddit: getPublicAppSettings().promoSubreddit,
    language: subGoalData.language,
    subscribed,
    authenticated: Boolean(context.userId),
    ctaActivity,
    subreddit: {
      name:
        subGoalData.subredditDisplayName ?? context.subredditName ?? "unknown",
      subscribers,
      growth: dailySubscribers.growth,
    },
  };
};

const buildCtaOnlyState = async (
  postId: string,
  subGoalData: SubGoalData,
  subredditPromise = reddit.getCurrentSubreddit(),
): Promise<CtaOnlyState> => {
  const subreddit = await subredditPromise;
  const [dailySubscribers, ctaActivity] = await Promise.all([
    observeDailySubscriberCount(redis, subreddit.numberOfSubscribers, {
      displayedSubscribers: subreddit.numberOfSubscribers,
    }),
    getCtaActivityMetric(redis, postId, subGoalData.afterSubscribePreset),
  ]);
  return {
    colorTheme: subGoalData.colorTheme,
    afterSubscribeAction: subGoalData.afterSubscribeAction,
    trackCtaClicks: isClickActivityPreset(subGoalData.afterSubscribePreset),
    postHeight: "cta",
    promoSubreddit: getPublicAppSettings().promoSubreddit,
    ctaActivity,
    language: subGoalData.language,
    subreddit: {
      name: subGoalData.subredditDisplayName ?? subreddit.name,
      subscribers: subreddit.numberOfSubscribers,
      growth: dailySubscribers.growth,
    },
  };
};

export function registerPublicApiRoutes(router: Router): void {
  router.get(
    apiRoutes.notificationSettings,
    async (_req, res): Promise<void> => {
      const userId = context.userId;
      if (!userId) {
        res.json({
          type: "notification-settings",
          authenticated: false,
          enabled: false,
        } satisfies NotificationSettingsResponse);
        return;
      }
      try {
        const enabled = await notifications.isOptedIn(userId);
        res.json({
          type: "notification-settings",
          authenticated: true,
          enabled,
        } satisfies NotificationSettingsResponse);
      } catch (error) {
        const operationId = createOperationId("notification-settings-read");
        logDiagnostic(
          "error",
          "api_request_failed",
          {
            operationId,
            route: apiRoutes.notificationSettings,
            workflow: "notification_settings",
            phase: "read",
            status: 503,
          },
          error,
        );
        res
          .status(503)
          .json(localizedError("errors.notifications.load", { operationId }));
      }
    },
  );

  router.post(
    apiRoutes.notificationSettings,
    async (req, res): Promise<void> => {
      const userId = context.userId;
      if (!userId) {
        res
          .status(401)
          .json(localizedError("errors.notifications.loginRequired"));
        return;
      }
      const body = req.body as Partial<NotificationSettingsRequest> | undefined;
      if (typeof body?.enabled !== "boolean") {
        res
          .status(400)
          .json(localizedError("errors.notifications.invalidEnabled"));
        return;
      }

      try {
        const current = await notifications.isOptedIn(userId);
        if (current !== body.enabled) {
          const result = body.enabled
            ? await notifications.optInCurrentUser()
            : await notifications.optOutCurrentUser();
          if (!result.success) {
            throw new Error(
              result.message || "Notification preference was not accepted.",
            );
          }
        }
        const enabled = await notifications.isOptedIn(userId);
        if (enabled !== body.enabled) {
          throw new Error("Notification preference confirmation mismatched.");
        }
        res.json({
          type: "notification-settings",
          authenticated: true,
          enabled,
        } satisfies NotificationSettingsResponse);
      } catch (error) {
        const operationId = createOperationId("notification-settings-write");
        logDiagnostic(
          "error",
          "api_request_failed",
          {
            operationId,
            route: apiRoutes.notificationSettings,
            workflow: "notification_settings",
            phase: "write",
            status: 503,
          },
          error,
        );
        res
          .status(503)
          .json(localizedError("errors.notifications.update", { operationId }));
      }
    },
  );

  router.post(apiRoutes.ctaClick, async (_req, res): Promise<void> => {
    const { postId } = context;
    if (!postId) {
      res.status(400).json(localizedError("errors.api.postIdRequired"));
      return;
    }
    try {
      const subGoalData = await getSubGoalData(redis, postId, context.postData);
      if (
        subGoalData.afterSubscribeAction.type === "disabled" ||
        !isClickActivityPreset(subGoalData.afterSubscribePreset)
      ) {
        res
          .status(400)
          .json(localizedError("errors.api.ctaActivityUnsupported"));
        return;
      }
      await recordCtaClick(redis, postId);
      res.json({ status: "ok" } satisfies RecordCtaClickResponse);
    } catch (error) {
      logDiagnostic(
        "error",
        "api_request_failed",
        {
          route: apiRoutes.ctaClick,
          workflow: "cta_click",
          postId,
          status: 503,
        },
        error,
      );
      res.status(503).json(localizedError("errors.api.ctaActivityFailed"));
    }
  });

  router.get(
    apiRoutes.afterSubscribeTarget,
    async (_req, res): Promise<void> => {
      const { postId, userId } = context;
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
        if (
          subGoalData.postKind !== ctaOnlyPostKind &&
          (!userId || !(await isTrackedSubscriber(redis, userId)))
        ) {
          res.status(403).json(localizedError("errors.join.required"));
          return;
        }
        const action = subGoalData.afterSubscribeAction;
        if (action.type !== "top-post-day" && action.type !== "newest-post") {
          res
            .status(400)
            .json(localizedError("errors.api.dynamicTargetUnsupported"));
          return;
        }
        const subreddit = await reddit.getCurrentSubreddit();
        if (getCurrentSubredditNsfw(subreddit) === true) {
          res.json({
            target: {
              url: `https://www.reddit.com/r/${subreddit.name}/submit/`,
            },
          } satisfies AfterSubscribeTargetResponse);
          return;
        }
        let target: NavigationTarget | undefined;
        if (action.type === "top-post-day") {
          const promoSubreddit = getPublicAppSettings().promoSubreddit;
          const allowAppAccountPosts =
            subreddit.name.toLowerCase() === promoSubreddit.toLowerCase();

          for (const timeframe of ["day", "week", "month", "all"] as const) {
            const candidates = await reddit
              .getTopPosts({
                subredditName: subreddit.name,
                timeframe,
                limit: dynamicPostCandidateLimit,
                pageSize: dynamicPostCandidateLimit,
              })
              .all();

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
          for (const candidate of candidates) {
            if (
              typeof candidate.id === "string" &&
              candidate.id.toLowerCase() === postId.toLowerCase()
            ) {
              continue;
            }
            target = createPostNavigationTarget(candidate);
            if (target) break;
          }
        }
        if (!target) {
          res
            .status(404)
            .json(localizedError("afterJoin.dynamicPostUnavailable"));
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
        res.status(503).json(localizedError("errors.api.postTargetFailed"));
      }
    },
  );

  router.get(apiRoutes.init, async (_req, res): Promise<void> => {
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
      const subredditPromise = timedInitOperation(
        initTimings,
        "subreddit",
        () => reddit.getCurrentSubreddit(),
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
                (subreddit as { settings?: { communityIcon?: string } })
                  .settings,
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
      });
      setInitServerTiming(res, initTimings, initStartedAt);
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
        .json(
          localizedError("errors.api.initializationFailed", { operationId }),
        );
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
        {
          operationId,
          route: apiRoutes.refresh,
          workflow: "refresh",
          postId,
          status: 503,
        },
        error,
      );
      res
        .status(503)
        .json(localizedError("errors.api.refreshFailed", { operationId }));
    }
  });

  router.post(apiRoutes.subscribe, async (req, res): Promise<void> => {
    const { postId, userId } = context;
    const journeyId = getRequestJourneyId(req);
    const operationId = createOperationId("subscribe");
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
      if (subGoalData.postKind === subscribeOnlyPostKind) {
        const username = await reddit.getCurrentUsername();
        if (!username) {
          res
            .status(400)
            .json(localizedError("errors.api.usernameUnavailable"));
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
        const sourceSubredditNsfw = getCurrentSubredditNsfw(subreddit);
        const newSubscriberCount = subreddit.numberOfSubscribers + 1;
        const shareUsername = sourceSubredditNsfw === false;

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
          await runSubscribeSideEffect(
            operationId,
            postId,
            "realtime_publish",
            () => realtime.send("subscriber_updates", realtimeMessage),
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
        res.status(400).json(localizedError("errors.api.usernameUnavailable"));
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
      const sourceSubredditNsfw = getCurrentSubredditNsfw(subreddit);
      const effectiveShareUsername = resolveShareUsername(
        shareUsername,
        sourceSubredditNsfw !== false,
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
      logSubscribePhase(operationId, postId, "tracking_complete", {
        subscriberCreated,
      });

      const displayedSubscriberCount = subscriberCreated
        ? newSubscriberCount
        : subreddit.numberOfSubscribers;

      if (
        subscriberCreated &&
        subGoalData.goal &&
        newSubscriberCount >= subGoalData.goal
      ) {
        await runSubscribeSideEffect(
          operationId,
          postId,
          "completion_check",
          () => checkCompletionStatus(reddit, redis, postId),
        );
      }

      if (subscriberCreated) {
        const realtimeMessage: RealtimeMessage = {
          type: "sub",
          newSubscriberCount,
          ...(effectiveShareUsername ? { recentSubscriber: username } : {}),
        };
        await runSubscribeSideEffect(
          operationId,
          postId,
          "realtime_publish",
          () => realtime.send("subscriber_updates", realtimeMessage),
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
        {
          operationId,
          route: apiRoutes.subscribe,
          workflow: "subscribe",
          postId,
          status: 503,
        },
        error,
      );
      res
        .status(503)
        .json(localizedError("errors.join.failedReference", { operationId }));
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
