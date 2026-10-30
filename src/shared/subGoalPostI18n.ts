import { formatSubscriberCount } from "./numberFormat";
import {
  appLanguages,
  defaultAppLanguage,
  getLanguageMetadata,
  getMessageTemplate,
  resolveAppLanguage,
  translate,
  type AppLanguage,
} from "./i18n/catalog";

export const subGoalLanguages = appLanguages;
export type SubGoalLanguage = AppLanguage;
export const defaultSubGoalLanguage: SubGoalLanguage = defaultAppLanguage;
export const subredditTitleEntitySeparator = "\u200B";

type SubredditNameParams = { subredditName: string };
type SubscribersParams = { subscribersCount: number; subscribersText: string };
type PromoSubredditParams = { promoSubreddit: string };
type UsernameParams = { username: string | null };
type CompletedTitleParams = SubredditNameParams & {
  goalCount?: number;
  goalText: string;
};
type CompletedDateParams = { timeText: string; dateText: string };
type TextFallbackActiveParams = SubredditNameParams & {
  subscribersCount: number;
  subscribersText: string;
  goalCount: number;
  goalText: string;
};
type TextFallbackCompletedParams = SubredditNameParams & {
  goalCount: number;
  goalText: string;
  completedIso: string;
};

export type ModeratorInstallPromotionMessages = {
  greeting: string;
  body: string;
  installButton: string;
  mobileInstallButton: string;
};
export type SubGoalPostMessages = {
  languageLabel: string;
  intlLocale: string;
  defaultPostTitle: (params: SubredditNameParams) => string;
  welcome: (params: SubredditNameParams) => string;
  subscribeButton: (params: SubredditNameParams) => string;
  subscribedButton: (params: SubredditNameParams) => string;
  shareUsernameLabel: string;
  thanksTitle: string;
  thanksBody: (params: SubscribersParams) => string;
  thanksReturnButton: string;
  completedTitle: (params: CompletedTitleParams) => string;
  completedGoalFallback: string;
  completedReachedAt: (params: CompletedDateParams) => string;
  completedJustNow: string;
  promoAriaLabel: (params: PromoSubredditParams) => string;
  subscriberNotice: (params: UsernameParams) => string;
  subscribeSuccessToast: string;
  subscribeErrorToast: string;
  loginRequired: string;
  loadError: string;
  fallbackActive: (params: TextFallbackActiveParams) => string;
  fallbackCompleted: (params: TextFallbackCompletedParams) => string;
};
export type AfterSubscribePresetMessages = {
  joinDiscord: string;
  viewTopPostToday: string;
  readWiki: string;
  createNewPost: string;
  sharePicture: string;
  viewMostRecentPostToday: string;
  dynamicPostUnavailable: string;
  dynamicPostError: string;
};

export function resolveSubGoalLanguage(value: unknown): SubGoalLanguage {
  return resolveAppLanguage(value);
}

const buildRawPostMessages = (
  language: SubGoalLanguage,
): SubGoalPostMessages => {
  const metadata = getLanguageMetadata(language);
  return {
    languageLabel: metadata.label,
    intlLocale: metadata.locale,
    defaultPostTitle: ({ subredditName }) =>
      translate(language, "post.defaultTitle", {
        subredditName: `${subredditTitleEntitySeparator}${subredditName}`,
      }),
    welcome: (values) => translate(language, "post.welcome", values),
    subscribeButton: (values) => translate(language, "post.joinButton", values),
    subscribedButton: (values) =>
      translate(language, "post.joinedButton", values),
    shareUsernameLabel: translate(language, "post.shareUsername"),
    thanksTitle: translate(language, "post.thanksTitle"),
    thanksBody: ({ subscribersCount, subscribersText }) =>
      translate(language, "post.thanksBody", {
        subscriberCountLabel: formatCountMessage(
          language,
          "metric.subscribersCommunity",
          subscribersCount,
          subscribersText,
        ),
      }),
    thanksReturnButton: translate(language, "post.return"),
    completedTitle: ({ subredditName, goalCount, goalText }) =>
      translate(language, "post.completedTitle", {
        subredditName,
        goalCountLabel: formatCountMessage(
          language,
          "metric.subscribersReached",
          goalCount ?? 10,
          goalText,
        ),
      }),
    completedGoalFallback: translate(language, "post.completedGoalFallback"),
    completedReachedAt: (values) =>
      translate(language, "post.completedReachedAt", values),
    completedJustNow: translate(language, "post.completedJustNow"),
    promoAriaLabel: (values) =>
      translate(language, "post.promoAriaLabel", values),
    subscriberNotice: ({ username }) =>
      username
        ? translate(language, "post.memberJoinedNamed", { username })
        : translate(language, "post.memberJoinedAnonymous"),
    subscribeSuccessToast: translate(language, "post.joinSuccess"),
    subscribeErrorToast: translate(language, "post.joinError"),
    loginRequired: translate(language, "post.loginRequired"),
    loadError: translate(language, "post.loadError"),
    fallbackActive: ({
      subredditName,
      subscribersCount,
      subscribersText,
      goalCount,
      goalText,
    }) =>
      translate(language, "post.fallbackActive", {
        subredditName,
        subscriberCountLabel: formatCountMessage(
          language,
          "metric.subscribers",
          subscribersCount,
          subscribersText,
        ),
        goalCountLabel: formatCountMessage(
          language,
          "metric.subscribers",
          goalCount,
          goalText,
        ),
      }),
    fallbackCompleted: ({ subredditName, goalCount, goalText, completedIso }) =>
      translate(language, "post.fallbackCompleted", {
        subredditName,
        goalCountLabel: formatCountMessage(
          language,
          "metric.subscribersReached",
          goalCount,
          goalText,
        ),
        completedIso,
      }),
  };
};

const createLazyLanguageRecord = <T>(
  build: (language: SubGoalLanguage) => T,
): Record<SubGoalLanguage, T> => {
  const cache = new Map<SubGoalLanguage, T>();
  const record = {} as Record<SubGoalLanguage, T>;
  for (const language of subGoalLanguages) {
    Object.defineProperty(record, language, {
      configurable: false,
      enumerable: true,
      get: () => {
        let value = cache.get(language);
        if (value === undefined) {
          value = build(language);
          cache.set(language, value);
        }
        return value;
      },
    });
  }
  return Object.freeze(record);
};

export const subGoalPostMessages =
  createLazyLanguageRecord(buildRawPostMessages);

const formatCountMessage = (
  language: SubGoalLanguage,
  key:
    | "metric.subscribers"
    | "metric.subscribersCommunity"
    | "metric.subscribersReached"
    | "metric.growthToday"
    | "metric.growthWeek"
    | "activity.clicksWeek"
    | "activity.postsToday"
    | "activity.postsWeek",
  count: number,
  countText: string,
): string =>
  translate(
    language,
    key,
    getMessageTemplate(language, key).template.includes("{count,")
      ? { count, countText }
      : { countText },
  );
export const formatLocalizedSubscriberCount = (
  language: SubGoalLanguage,
  count: number,
  countText = formatSubscriberCount(count),
): string =>
  formatCountMessage(language, "metric.subscribers", count, countText);
export const formatLocalizedSubscriberGrowth = (
  language: SubGoalLanguage,
  growth: { count: number; period: "today" | "week" },
  countText = formatSubscriberCount(growth.count),
): string =>
  formatCountMessage(
    language,
    growth.period === "today" ? "metric.growthToday" : "metric.growthWeek",
    growth.count,
    countText,
  );
export const formatLocalizedCtaActivity = (
  language: SubGoalLanguage,
  activity: {
    kind: "posts" | "clicks";
    count: number;
    period: "today" | "week";
  },
  countText = formatSubscriberCount(activity.count),
): string =>
  formatCountMessage(
    language,
    activity.kind === "clicks"
      ? "activity.clicksWeek"
      : activity.period === "today"
        ? "activity.postsToday"
        : "activity.postsWeek",
    activity.count,
    countText,
  );

export function getModeratorInstallPromotionMessages(
  language: unknown,
): ModeratorInstallPromotionMessages {
  const resolved = resolveSubGoalLanguage(language);
  return {
    greeting: translate(resolved, "promotion.greeting"),
    body: translate(resolved, "promotion.body"),
    installButton: translate(resolved, "promotion.install"),
    mobileInstallButton: translate(resolved, "promotion.installMobile"),
  };
}

export function getSubGoalPostMessages(language: unknown): SubGoalPostMessages {
  return subGoalPostMessages[resolveSubGoalLanguage(language)];
}

const buildAfterJoinMessages = (
  language: SubGoalLanguage,
): AfterSubscribePresetMessages => ({
  joinDiscord: translate(language, "afterJoin.joinDiscord"),
  viewTopPostToday: translate(language, "afterJoin.viewTopPostToday"),
  readWiki: translate(language, "afterJoin.readWiki"),
  createNewPost: translate(language, "afterJoin.createNewPost"),
  sharePicture: translate(language, "afterJoin.sharePicture"),
  viewMostRecentPostToday: translate(
    language,
    "afterJoin.viewMostRecentPostToday",
  ),
  dynamicPostUnavailable: translate(
    language,
    "afterJoin.dynamicPostUnavailable",
  ),
  dynamicPostError: translate(language, "afterJoin.dynamicPostError"),
});
export const afterSubscribePresetMessages = createLazyLanguageRecord(
  buildAfterJoinMessages,
);
export function getAfterSubscribePresetMessages(
  language: unknown,
): AfterSubscribePresetMessages {
  return afterSubscribePresetMessages[resolveSubGoalLanguage(language)];
}
