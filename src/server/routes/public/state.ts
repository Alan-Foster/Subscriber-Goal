import {
  defaultAfterSubscribeAction,
  getEffectiveAfterSubscribeActions,
} from "../../../shared/afterSubscribeAction";
import type { Response } from "express";
import { context, reddit, redis } from "@devvit/web/server";
import type {
  CtaOnlyState,
  SubGoalState,
  SubscribeOnlyState,
} from "../../../shared/types/api";
import { getPublicAppSettings } from "../../settings";
import { getSubGoalData } from "../../data/subGoalData";
import { isTrackedSubscriber } from "../../data/subscriberStats";
import { observeDailySubscriberCount } from "../../data/subscriberDailyStats";
import { getSubredditIcon } from "../../utils/redditUtils";
import {
  ctaOnlyPostKind,
  subscribeOnlyPostKind,
} from "../../../shared/postKind";
import {
  getCtaActivityMetric,
  isClickActivityPreset,
} from "../../data/ctaActivity";
import { logDiagnostic } from "../../../shared/diagnostics";
import {
  getCurrentSubredditNsfw,
  isNsfwOrUnknown,
} from "../../utils/subredditSafety";
import { canViewCurrentSubredditStatistics } from "../../utils/statisticsAuthorization";
import {
  isUsableSubscriberGoal,
  recoverEmergencySubscriberGoal,
} from "../../utils/emergencyGoalRecovery";

type InitTimingName =
  | "goal_data"
  | "blacklist"
  | "subreddit"
  | "user"
  | "subscriber_status"
  | "icon";

export type InitTimings = Partial<Record<InitTimingName, number>>;

export const timedInitOperation = async <T>(
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

export const setInitServerTiming = (
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

export type CurrentSubreddit = Awaited<
  ReturnType<typeof reddit.getCurrentSubreddit>
>;

export type SubGoalData = Awaited<ReturnType<typeof getSubGoalData>>;

type CurrentUserContext = {
  user: { id: string; username: string } | null;
  moderatorInstallPromoEligible: boolean;
  isModerator: boolean;
  moderatedSubreddits: string[];
};

type BuildStateDependencies = {
  subGoalData?: SubGoalData;
  subredditPromise?: Promise<CurrentSubreddit>;
  trackedSubscriberPromise?: Promise<boolean>;
  userContextPromise?: Promise<CurrentUserContext>;
  subredditIconPromise?: Promise<string>;
  timings?: InitTimings;
  recoveryWorkflow?: string;
  recoveryRoute?: string;
};

export const loadCurrentUser = async (
  timings?: InitTimings,
): Promise<CurrentUserContext> => {
  if (!context.userId) {
    return {
      user: null,
      moderatorInstallPromoEligible: false,
      isModerator: false,
      moderatedSubreddits: [],
    };
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
          isModerator: moderatorInstallPromoEligible,
          moderatedSubreddits:
            currentUser.modPermissions instanceof Map
              ? [...currentUser.modPermissions.keys()]
              : [],
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
      isModerator: false,
      moderatedSubreddits: [],
    };
  });
};

export const buildState = async (
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
  let goal = subGoalData.goal;
  let subscribers =
    options?.subscribersOverride ?? subreddit.numberOfSubscribers;
  if (!isUsableSubscriberGoal(goal)) {
    const recovery = await recoverEmergencySubscriberGoal({
      redis,
      postId,
      workflow: dependencies.recoveryWorkflow ?? "subscriber_goal_state",
      ...(dependencies.recoveryRoute
        ? { route: dependencies.recoveryRoute }
        : {}),
      currentSubscribers: subscribers,
      completed: subGoalData.completedTime > 0,
    });
    goal = recovery.goal;
    subscribers = recovery.subscribers;
  }
  const appSettings = getPublicAppSettings();
  const canViewStatistics = await canViewCurrentSubredditStatistics(
    reddit,
    context.userId,
    subreddit.name,
    userContext.user
      ? {
          username: userContext.user.username,
          isModerator: userContext.isModerator,
          moderatedSubreddits: userContext.moderatedSubreddits,
        }
      : null,
  );

  const subredditNsfw = getCurrentSubredditNsfw(subreddit);
  const actions = effectiveGoalActions(subGoalData, subreddit);
  return {
    goal,
    recentSubscriber:
      subredditNsfw === false
        ? (options?.recentSubscriberOverride ??
          (subGoalData.recentSubscriber || null))
        : null,
    completedTime: subGoalData.completedTime ? subGoalData.completedTime : null,
    headerText: subGoalData.headerText ?? null,
    colorTheme: subGoalData.colorTheme,
    afterSubscribeAction: actions.primary,
    automaticAfterSubscribeAction: actions.secondary,
    trackCtaClicks: isClickActivityPreset(subGoalData.afterSubscribePreset),
    postHeight: subGoalData.postHeight === "short" ? "short" : "regular",
    language: subGoalData.language,
    subscribed,
    moderatorInstallPromoEligible: userContext.moderatorInstallPromoEligible,
    canViewStatistics,
    user: userContext.user,
    appSettings,
    subreddit: {
      id: subreddit.id,
      name: subGoalData.subredditDisplayName ?? subreddit.name,
      icon: subredditIcon,
      subscribers,
      isNsfw: isNsfwOrUnknown(subredditNsfw),
    },
  };
};

export const buildSubscribeOnlyState = async (
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
    dependencies.subredditPromise ?? reddit.getCurrentSubreddit();
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
    afterSubscribeAction: effectiveGoalActions(subGoalData, subreddit).primary,
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

export const buildCtaOnlyState = async (
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
    afterSubscribeAction: effectiveGoalActions(subGoalData, subreddit).primary,
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

export function effectiveGoalActions(
  data: SubGoalData,
  subreddit: Pick<CurrentSubreddit, "name" | "nsfw">,
) {
  return getEffectiveAfterSubscribeActions(
    data.afterSubscribeAction ?? defaultAfterSubscribeAction,
    {
      language: data.language ?? "en",
      subredditName: subreddit.name,
      isNsfw: isNsfwOrUnknown(subreddit.nsfw),
    },
  );
}
