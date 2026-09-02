import type { RedditClient, RedisClient } from "../types";
import type { ServerAppSettings } from "../settings";
import type { SubGoalColorTheme } from "../../shared/subGoalColorTheme";
import {
  defaultSubGoalColorTheme,
  isSubGoalColorTheme,
  resolveSubGoalColorTheme,
} from "../../shared/subGoalColorTheme";
import type { SubGoalLanguage } from "../../shared/subGoalPostI18n";
import {
  defaultSubGoalLanguage,
  resolveSubGoalLanguage,
} from "../../shared/subGoalPostI18n";
import type { SubGoalPostHeight } from "../../shared/subGoalPostHeight";
import { resolveSubGoalPostHeight } from "../../shared/subGoalPostHeight";
import {
  resolvePostKind,
  resolvePostKindFromPostData,
  subscriberGoalPostKind,
  subscribeOnlyPostKind,
  type PostKind,
} from "../../shared/postKind";
import { dispatchNewPost } from "./crosspostData";
import { postsKey, queueUpdate, trackPost } from "./updaterData";
import { logCrosspostEvent, toErrorMessage } from "../utils/crosspostLogs";
import {
  createTopPostFallbackAction,
  defaultAfterSubscribeAction,
  resolveAfterSubscribeAction,
  type AfterSubscribeAction,
} from "../../shared/afterSubscribeAction";
import { registerSubscriberGoalPost } from "./subscriberGoalPostRegistry";

export const subscriberGoalsKey = "subscriber_goals";
export const postGoalSuffix = "_goal";
export const postRecentSubscriberSuffix = "_recent_subscriber";
export const postCompletedTimeSuffix = "_completed_time";
export const postSubredditDisplayNameSuffix = "_subreddit_display_name";
export const postHeaderTextSuffix = "_header_text";
export const postColorThemeSuffix = "_color_theme";
export const postAutoCreateNextGoalSuffix = "_auto_create_next_goal";
export const postLanguageSuffix = "_language";
export const postHeightSuffix = "_post_height";
export const postKindSuffix = "_post_kind";
export const postAfterSubscribeActionSuffix = "_after_subscribe_action";
export const postAfterSubscribeButtonTextSuffix =
  "_after_subscribe_button_text";
export const postAfterSubscribeUrlSuffix = "_after_subscribe_url";
export const postAfterSubscribeColorThemeSuffix =
  "_after_subscribe_color_theme";
export const autoCreateNextGoalQueueKey = "auto_create_next_goal_queue";
export const recentSubscriberPostsByUsernameKey =
  "recent_subscriber_posts_by_username";
export const recentSubscriberIndexMigrationStateKey =
  "recent_subscriber_index_migration_state";
export const recentSubscriberIndexMigrationVersion =
  "recent_subscriber_index_v1";
export const autoCreateNextGoalDelayMs = 24 * 60 * 60 * 1000;

const recentSubscriberIndexBatchSize = 25;
const recentSubscriberIndexCooldownMinMs = 5 * 60 * 1000;
const recentSubscriberIndexCooldownMaxMs = 15 * 60 * 1000;

export type SubGoalData = {
  postKind: PostKind;
  goal: number;
  recentSubscriber: string | null;
  completedTime: number;
  subredditDisplayName: string | null;
  headerText?: string | null;
  colorTheme: SubGoalColorTheme;
  autoCreateNextGoal: boolean;
  language: SubGoalLanguage;
  postHeight: SubGoalPostHeight;
  afterSubscribeAction: AfterSubscribeAction;
};

type RedditPost = Awaited<ReturnType<RedditClient["submitCustomPost"]>>;

export type CrosspostDispatchResult = {
  status: "success" | "skipped" | "failed";
  errorMessage?: string;
};

type RecentSubscriberIndexMigrationStatus = "pending" | "running" | "complete";

type RecentSubscriberIndexMigrationState = {
  version: string;
  status: RecentSubscriberIndexMigrationStatus;
  cursor: number;
  nextRunAt: number;
  scannedTotal: number;
  indexedTotal: number;
  lastRunAt: number;
};

const normalizeUsername = (username: string): string =>
  username.trim().toLowerCase();

const parsePostIdList = (raw: string | undefined): string[] => {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
};

const stringifyPostIdList = (postIds: string[]): string =>
  JSON.stringify([...new Set(postIds)]);

const nextCooldown = (
  nowMs: number,
  cooldownMinMs: number,
  cooldownMaxMs: number,
): number => {
  const min = Math.max(0, cooldownMinMs);
  const max = Math.max(min, cooldownMaxMs);
  return nowMs + min + Math.floor(Math.random() * (max - min + 1));
};

const parseRecentSubscriberIndexMigrationState = (
  raw: Record<string, string>,
): RecentSubscriberIndexMigrationState | undefined => {
  if (raw.version !== recentSubscriberIndexMigrationVersion) {
    return undefined;
  }
  const status =
    raw.status === "pending" ||
    raw.status === "running" ||
    raw.status === "complete"
      ? raw.status
      : undefined;
  if (!status) {
    return undefined;
  }
  return {
    version: raw.version,
    status,
    cursor: parseInt(raw.cursor ?? "0", 10) || 0,
    nextRunAt: parseInt(raw.nextRunAt ?? "0", 10) || 0,
    scannedTotal: parseInt(raw.scannedTotal ?? "0", 10) || 0,
    indexedTotal: parseInt(raw.indexedTotal ?? "0", 10) || 0,
    lastRunAt: parseInt(raw.lastRunAt ?? "0", 10) || 0,
  };
};

const serializeRecentSubscriberIndexMigrationState = (
  state: RecentSubscriberIndexMigrationState,
): Record<string, string> => ({
  version: state.version,
  status: state.status,
  cursor: state.cursor.toString(),
  nextRunAt: state.nextRunAt.toString(),
  scannedTotal: state.scannedTotal.toString(),
  indexedTotal: state.indexedTotal.toString(),
  lastRunAt: state.lastRunAt.toString(),
});

export async function addRecentSubscriberPostIndex(
  redis: RedisClient,
  username: string,
  postId: string,
): Promise<void> {
  const normalized = normalizeUsername(username);
  if (!normalized) {
    return;
  }
  const existing = parsePostIdList(
    await redis.hGet(recentSubscriberPostsByUsernameKey, normalized),
  );
  if (existing.includes(postId)) {
    return;
  }
  await redis.hSet(recentSubscriberPostsByUsernameKey, {
    [normalized]: stringifyPostIdList([...existing, postId]),
  });
}

export async function removeRecentSubscriberPostIndex(
  redis: RedisClient,
  username: string,
  postId: string,
): Promise<void> {
  const normalized = normalizeUsername(username);
  if (!normalized) {
    return;
  }
  const existing = parsePostIdList(
    await redis.hGet(recentSubscriberPostsByUsernameKey, normalized),
  );
  const next = existing.filter((existingPostId) => existingPostId !== postId);
  if (next.length === existing.length) {
    return;
  }
  if (next.length === 0) {
    await redis.hDel(recentSubscriberPostsByUsernameKey, [normalized]);
    return;
  }
  await redis.hSet(recentSubscriberPostsByUsernameKey, {
    [normalized]: stringifyPostIdList(next),
  });
}

export async function getSubGoalData(
  redis: RedisClient,
  postId: string,
  customPostData?: unknown,
): Promise<SubGoalData> {
  const [
    goal,
    recentSubscriber,
    completedTime,
    subredditDisplayName,
    headerText,
    colorTheme,
    autoCreateNextGoal,
    language,
    postHeight,
    storedPostKind,
    afterSubscribeActionType,
    afterSubscribeButtonText,
    afterSubscribeUrl,
    afterSubscribeColorTheme,
  ] = (await redis.hMGet(subscriberGoalsKey, [
    `${postId}${postGoalSuffix}`,
    `${postId}${postRecentSubscriberSuffix}`,
    `${postId}${postCompletedTimeSuffix}`,
    `${postId}${postSubredditDisplayNameSuffix}`,
    `${postId}${postHeaderTextSuffix}`,
    `${postId}${postColorThemeSuffix}`,
    `${postId}${postAutoCreateNextGoalSuffix}`,
    `${postId}${postLanguageSuffix}`,
    `${postId}${postHeightSuffix}`,
    `${postId}${postKindSuffix}`,
    `${postId}${postAfterSubscribeActionSuffix}`,
    `${postId}${postAfterSubscribeButtonTextSuffix}`,
    `${postId}${postAfterSubscribeUrlSuffix}`,
    `${postId}${postAfterSubscribeColorThemeSuffix}`,
  ])) as [
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
  ];
  const parsedGoal = goal ? parseInt(goal, 10) || 0 : 0;
  const postDataKind = resolvePostKindFromPostData(customPostData);
  const persistedKind = resolvePostKind(storedPostKind);
  const rawHeight = resolveSubGoalPostHeight(postHeight);
  const hasPositiveGoal = parsedGoal > 0;
  const hasGoalField = goal !== null && goal !== undefined && goal !== "";
  const conflictingTinyGoal =
    hasPositiveGoal &&
    (postDataKind === subscribeOnlyPostKind ||
      persistedKind === subscribeOnlyPostKind ||
      rawHeight === "tiny");
  if (conflictingTinyGoal) {
    console.warn(
      `[postKind] preserving subscriber goal with conflicting Tiny metadata: postId=${postId}`,
    );
  }
  const postKind: PostKind = hasPositiveGoal
    ? subscriberGoalPostKind
    : postDataKind === subscriberGoalPostKind ||
        persistedKind === subscriberGoalPostKind
      ? subscriberGoalPostKind
      : postDataKind === subscribeOnlyPostKind ||
          persistedKind === subscribeOnlyPostKind ||
          (rawHeight === "tiny" && !hasGoalField)
        ? subscribeOnlyPostKind
        : subscriberGoalPostKind;
  const resolvedHeight: SubGoalPostHeight =
    postKind === subscribeOnlyPostKind
      ? "tiny"
      : rawHeight === "short"
        ? "short"
        : "regular";
  const resolvedColorTheme = resolveSubGoalColorTheme(colorTheme);
  const resolvedLanguage = resolveSubGoalLanguage(language);
  const hasActionMetadata =
    typeof afterSubscribeActionType === "string" &&
    afterSubscribeActionType.trim().length > 0;
  const isActionlessLegacySubscriberGoal =
    postKind === subscriberGoalPostKind && parsedGoal > 0 && !hasActionMetadata;
  const hasMalformedRecoverableAction =
    afterSubscribeActionType === "link" ||
    afterSubscribeActionType === "top-post-day" ||
    afterSubscribeActionType === "newest-post";
  const legacyFallbackAction = createTopPostFallbackAction({
    language: resolvedLanguage,
    colorTheme: isSubGoalColorTheme(afterSubscribeColorTheme)
      ? afterSubscribeColorTheme
      : resolvedColorTheme,
  });
  const afterSubscribeAction = isActionlessLegacySubscriberGoal
    ? legacyFallbackAction
    : resolveAfterSubscribeAction({
        type: afterSubscribeActionType,
        buttonText: afterSubscribeButtonText,
        url: afterSubscribeUrl,
        colorTheme: afterSubscribeColorTheme,
        fallbackColorTheme: resolvedColorTheme,
        ...(hasMalformedRecoverableAction
          ? { invalidConfigurationFallback: legacyFallbackAction }
          : {}),
      }).action;
  return {
    postKind,
    goal: parsedGoal,
    recentSubscriber: recentSubscriber ?? null,
    completedTime: completedTime ? parseInt(completedTime) : 0,
    subredditDisplayName:
      subredditDisplayName && subredditDisplayName.length > 0
        ? subredditDisplayName
        : null,
    headerText: headerText && headerText.length > 0 ? headerText : null,
    colorTheme: resolvedColorTheme,
    autoCreateNextGoal: autoCreateNextGoal === "true",
    language: resolvedLanguage,
    postHeight: resolvedHeight,
    afterSubscribeAction,
  };
}

export async function setSubGoalData(
  redis: RedisClient,
  postId: string,
  data: Omit<SubGoalData, "postKind" | "afterSubscribeAction"> & {
    postKind?: PostKind;
    afterSubscribeAction?: AfterSubscribeAction;
  },
): Promise<void> {
  const afterSubscribeAction =
    data.afterSubscribeAction ?? defaultAfterSubscribeAction;
  await redis.hSet(subscriberGoalsKey, {
    [`${postId}${postKindSuffix}`]: subscriberGoalPostKind,
    [`${postId}${postGoalSuffix}`]: data.goal.toString(),
    [`${postId}${postRecentSubscriberSuffix}`]: data.recentSubscriber ?? "",
    [`${postId}${postCompletedTimeSuffix}`]: data.completedTime.toString(),
    [`${postId}${postSubredditDisplayNameSuffix}`]:
      data.subredditDisplayName ?? "",
    [`${postId}${postHeaderTextSuffix}`]: data.headerText ?? "",
    [`${postId}${postColorThemeSuffix}`]: resolveSubGoalColorTheme(
      data.colorTheme,
    ),
    [`${postId}${postAutoCreateNextGoalSuffix}`]: data.autoCreateNextGoal
      ? "true"
      : "false",
    [`${postId}${postLanguageSuffix}`]: resolveSubGoalLanguage(data.language),
    [`${postId}${postHeightSuffix}`]: resolveSubGoalPostHeight(data.postHeight),
    [`${postId}${postAfterSubscribeActionSuffix}`]: afterSubscribeAction.type,
    [`${postId}${postAfterSubscribeButtonTextSuffix}`]:
      afterSubscribeAction.type !== "disabled"
        ? afterSubscribeAction.buttonText
        : "",
    [`${postId}${postAfterSubscribeUrlSuffix}`]:
      afterSubscribeAction.type === "link" ? afterSubscribeAction.url : "",
    [`${postId}${postAfterSubscribeColorThemeSuffix}`]:
      afterSubscribeAction.type !== "disabled"
        ? afterSubscribeAction.colorTheme
        : data.colorTheme,
  });
}

export async function setAfterSubscribeActionForPost(
  redis: RedisClient,
  postId: string,
  action: AfterSubscribeAction,
  fallbackColorTheme: SubGoalColorTheme,
): Promise<void> {
  await redis.hSet(subscriberGoalsKey, {
    [`${postId}${postAfterSubscribeActionSuffix}`]: action.type,
    [`${postId}${postAfterSubscribeButtonTextSuffix}`]:
      action.type !== "disabled" ? action.buttonText : "",
    [`${postId}${postAfterSubscribeUrlSuffix}`]:
      action.type === "link" ? action.url : "",
    [`${postId}${postAfterSubscribeColorThemeSuffix}`]:
      action.type !== "disabled" ? action.colorTheme : fallbackColorTheme,
  });
}

export async function setAfterSubscribeActionForPostIfMissing(
  redis: RedisClient,
  postId: string,
  action: AfterSubscribeAction,
  fallbackColorTheme: SubGoalColorTheme,
): Promise<boolean> {
  const created = await redis.hSetNX(
    subscriberGoalsKey,
    `${postId}${postAfterSubscribeActionSuffix}`,
    action.type,
  );
  if (!created) {
    return false;
  }
  await redis.hSet(subscriberGoalsKey, {
    [`${postId}${postAfterSubscribeButtonTextSuffix}`]:
      action.type !== "disabled" ? action.buttonText : "",
    [`${postId}${postAfterSubscribeUrlSuffix}`]:
      action.type === "link" ? action.url : "",
    [`${postId}${postAfterSubscribeColorThemeSuffix}`]:
      action.type !== "disabled" ? action.colorTheme : fallbackColorTheme,
  });
  return true;
}

export async function setSubscribeOnlyPostData(
  redis: RedisClient,
  postId: string,
  data: {
    subredditDisplayName: string;
    colorTheme: SubGoalColorTheme;
    language: SubGoalLanguage;
    afterSubscribeAction?: AfterSubscribeAction;
  },
): Promise<void> {
  const afterSubscribeAction =
    data.afterSubscribeAction ?? defaultAfterSubscribeAction;
  await redis.hSet(subscriberGoalsKey, {
    [`${postId}${postKindSuffix}`]: subscribeOnlyPostKind,
    [`${postId}${postSubredditDisplayNameSuffix}`]: data.subredditDisplayName,
    [`${postId}${postColorThemeSuffix}`]: resolveSubGoalColorTheme(
      data.colorTheme,
    ),
    [`${postId}${postLanguageSuffix}`]: resolveSubGoalLanguage(data.language),
    [`${postId}${postHeightSuffix}`]: "tiny",
    [`${postId}${postAfterSubscribeActionSuffix}`]: afterSubscribeAction.type,
    [`${postId}${postAfterSubscribeButtonTextSuffix}`]:
      afterSubscribeAction.type !== "disabled"
        ? afterSubscribeAction.buttonText
        : "",
    [`${postId}${postAfterSubscribeUrlSuffix}`]:
      afterSubscribeAction.type === "link" ? afterSubscribeAction.url : "",
    [`${postId}${postAfterSubscribeColorThemeSuffix}`]:
      afterSubscribeAction.type !== "disabled"
        ? afterSubscribeAction.colorTheme
        : data.colorTheme,
  });
}

export async function scheduleAutoCreateNextGoal(
  redis: RedisClient,
  postId: string,
  completedTime: number,
): Promise<void> {
  await redis.zAdd(autoCreateNextGoalQueueKey, {
    member: postId,
    score: completedTime + autoCreateNextGoalDelayMs,
  });
}

export async function cancelAutoCreateNextGoal(
  redis: RedisClient,
  postId: string,
): Promise<void> {
  await redis.zRem(autoCreateNextGoalQueueKey, [postId]);
}

export async function cancelAllAutoCreateNextGoals(
  redis: RedisClient,
): Promise<void> {
  const pending = await redis.zRange(autoCreateNextGoalQueueKey, 0, -1);
  const postIds = pending.map((entry) => entry.member);
  if (postIds.length) {
    await redis.zRem(autoCreateNextGoalQueueKey, postIds);
  }
}

export async function getDueAutoCreateNextGoalPostIds(
  redis: RedisClient,
  nowMs: number,
): Promise<string[]> {
  const pending = await redis.zRange(autoCreateNextGoalQueueKey, 0, -1);
  return pending
    .filter((entry) => entry.score <= nowMs)
    .map((entry) => entry.member);
}

export async function setSubredditDisplayNameForPost(
  redis: RedisClient,
  postId: string,
  subredditDisplayName: string,
): Promise<void> {
  await redis.hSet(subscriberGoalsKey, {
    [`${postId}${postSubredditDisplayNameSuffix}`]: subredditDisplayName,
  });
}

export async function checkCompletionStatus(
  reddit: RedditClient,
  redis: RedisClient,
  postId: string,
): Promise<number> {
  const subGoalData = await getSubGoalData(redis, postId);
  if (subGoalData.completedTime) {
    return subGoalData.completedTime;
  }

  const currentSubscribers = (await reddit.getCurrentSubreddit())
    .numberOfSubscribers;
  if (currentSubscribers >= subGoalData.goal) {
    subGoalData.completedTime = Date.now();
    await setSubGoalData(redis, postId, subGoalData);
    if (subGoalData.autoCreateNextGoal) {
      await scheduleAutoCreateNextGoal(
        redis,
        postId,
        subGoalData.completedTime,
      );
    }
    return subGoalData.completedTime;
  }
  return 0;
}

export async function registerNewSubGoalPost(
  reddit: RedditClient,
  redis: RedisClient,
  appSettings: ServerAppSettings,
  post: RedditPost,
  goal: number,
  crosspost: boolean,
  subredditDisplayName: string,
  colorTheme: SubGoalColorTheme = defaultSubGoalColorTheme,
  autoCreateNextGoal = false,
  language: SubGoalLanguage = defaultSubGoalLanguage,
  headerText?: string,
  postHeight: Exclude<SubGoalPostHeight, "tiny"> = "regular",
  afterSubscribeAction: AfterSubscribeAction = defaultAfterSubscribeAction,
): Promise<CrosspostDispatchResult> {
  await setSubGoalData(redis, post.id, {
    goal,
    recentSubscriber: "",
    completedTime: 0,
    subredditDisplayName,
    headerText: headerText ?? null,
    colorTheme,
    autoCreateNextGoal,
    language,
    postHeight,
    afterSubscribeAction,
  });
  await registerSubscriberGoalPost(redis, post.id, post.createdAt);
  await trackPost(redis, post.id, post.createdAt);
  await queueUpdate(redis, post.id, post.createdAt);
  if (!crosspost) {
    logCrosspostEvent({
      event: "crosspost_attempt_skipped",
      sourcePostId: post.id,
      targetSubreddit: appSettings.promoSubreddit,
      reason: "crosspost_disabled",
    });
    return { status: "skipped" };
  }

  const sourceSubreddit = await reddit.getCurrentSubreddit();
  const sourceSubredditIsNsfw =
    (sourceSubreddit as { isNsfw?: boolean }).isNsfw === true;
  if (sourceSubredditIsNsfw) {
    logCrosspostEvent({
      event: "crosspost_attempt_skipped",
      sourcePostId: post.id,
      targetSubreddit: appSettings.promoSubreddit,
      reason: "source_subreddit_nsfw",
    });
    return { status: "skipped" };
  }

  if (
    appSettings.promoSubreddit.toLowerCase() ===
    post.subredditName.toLowerCase()
  ) {
    logCrosspostEvent({
      event: "crosspost_attempt_skipped",
      sourcePostId: post.id,
      targetSubreddit: appSettings.promoSubreddit,
      reason: "source_is_promo_subreddit",
    });
    return { status: "skipped" };
  }

  try {
    await dispatchNewPost(reddit, appSettings, post.id, goal);
    return { status: "success" };
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    logCrosspostEvent(
      {
        event: "crosspost_attempt_failed",
        sourcePostId: post.id,
        targetSubreddit: appSettings.promoSubreddit,
        reason: "dispatch_new_post_failed",
        errorMessage,
      },
      "error",
    );
    return {
      status: "failed",
      errorMessage,
    };
  }
}

export async function registerNewSubscribeOnlyPost(
  redis: RedisClient,
  appSettings: ServerAppSettings,
  post: RedditPost,
  subredditDisplayName: string,
  colorTheme: SubGoalColorTheme = defaultSubGoalColorTheme,
  language: SubGoalLanguage = defaultSubGoalLanguage,
  afterSubscribeAction: AfterSubscribeAction = defaultAfterSubscribeAction,
): Promise<CrosspostDispatchResult> {
  await setSubscribeOnlyPostData(redis, post.id, {
    subredditDisplayName,
    colorTheme,
    language,
    afterSubscribeAction,
  });
  await registerSubscriberGoalPost(redis, post.id, post.createdAt);
  logCrosspostEvent({
    event: "crosspost_attempt_skipped",
    sourcePostId: post.id,
    targetSubreddit: appSettings.promoSubreddit,
    reason: "tiny_post_height",
  });
  return { status: "skipped" };
}

export async function initializeRecentSubscriberIndexMigration(
  redis: RedisClient,
  options: {
    nowMs?: number;
    cooldownMinMs?: number;
    cooldownMaxMs?: number;
  } = {},
): Promise<void> {
  const existing = parseRecentSubscriberIndexMigrationState(
    await redis.hGetAll(recentSubscriberIndexMigrationStateKey),
  );
  if (existing) {
    return;
  }
  const nowMs = options.nowMs ?? Date.now();
  const cooldownMinMs =
    options.cooldownMinMs ?? recentSubscriberIndexCooldownMinMs;
  const cooldownMaxMs =
    options.cooldownMaxMs ?? recentSubscriberIndexCooldownMaxMs;
  await redis.hSet(
    recentSubscriberIndexMigrationStateKey,
    serializeRecentSubscriberIndexMigrationState({
      version: recentSubscriberIndexMigrationVersion,
      status: "pending",
      cursor: 0,
      nextRunAt: nextCooldown(nowMs, cooldownMinMs, cooldownMaxMs),
      scannedTotal: 0,
      indexedTotal: 0,
      lastRunAt: 0,
    }),
  );
}

export async function processRecentSubscriberIndexMigrationBatch(
  redis: RedisClient,
  options: {
    nowMs?: number;
    batchSize?: number;
    cooldownMinMs?: number;
    cooldownMaxMs?: number;
  } = {},
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const cooldownMinMs =
    options.cooldownMinMs ?? recentSubscriberIndexCooldownMinMs;
  const cooldownMaxMs =
    options.cooldownMaxMs ?? recentSubscriberIndexCooldownMaxMs;
  const batchSize = Math.max(
    1,
    Math.floor(options.batchSize ?? recentSubscriberIndexBatchSize),
  );
  let state = parseRecentSubscriberIndexMigrationState(
    await redis.hGetAll(recentSubscriberIndexMigrationStateKey),
  );
  if (!state) {
    await initializeRecentSubscriberIndexMigration(redis, {
      nowMs,
      cooldownMinMs,
      cooldownMaxMs,
    });
    state = parseRecentSubscriberIndexMigrationState(
      await redis.hGetAll(recentSubscriberIndexMigrationStateKey),
    );
  }
  if (!state || state.status === "complete" || nowMs < state.nextRunAt) {
    return;
  }

  const result = await redis.zScan(
    postsKey,
    state.cursor,
    undefined,
    batchSize,
  );
  let indexedThisRun = 0;
  for (const entry of result.members) {
    const recentSubscriber = await redis.hGet(
      subscriberGoalsKey,
      `${entry.member}${postRecentSubscriberSuffix}`,
    );
    if (recentSubscriber && recentSubscriber.length > 0) {
      await addRecentSubscriberPostIndex(redis, recentSubscriber, entry.member);
      indexedThisRun += 1;
    }
  }

  const nextState: RecentSubscriberIndexMigrationState = {
    version: recentSubscriberIndexMigrationVersion,
    status: result.cursor === 0 ? "complete" : "running",
    cursor: result.cursor,
    nextRunAt:
      result.cursor === 0
        ? 0
        : nextCooldown(nowMs, cooldownMinMs, cooldownMaxMs),
    scannedTotal: state.scannedTotal + result.members.length,
    indexedTotal: state.indexedTotal + indexedThisRun,
    lastRunAt: nowMs,
  };
  await redis.hSet(
    recentSubscriberIndexMigrationStateKey,
    serializeRecentSubscriberIndexMigrationState(nextState),
  );
  console.info(
    `[recentSubscriberIndexMigration] batch complete: scanned=${result.members.length} indexed=${indexedThisRun} scannedTotal=${nextState.scannedTotal} indexedTotal=${nextState.indexedTotal} cursor=${nextState.cursor} status=${nextState.status}`,
  );
}
export async function eraseFromRecentSubscribers(
  redis: RedisClient,
  username: string,
): Promise<void> {
  const normalized = username.toLowerCase();
  const indexedPostIds = parsePostIdList(
    await redis.hGet(recentSubscriberPostsByUsernameKey, normalized),
  );
  const keysToUpdate: Record<string, string> = {};

  for (const postId of indexedPostIds) {
    const key = `${postId}${postRecentSubscriberSuffix}`;
    const value = await redis.hGet(subscriberGoalsKey, key);
    if (value?.toLowerCase() === normalized) {
      keysToUpdate[key] = "";
    }
  }

  if (Object.keys(keysToUpdate).length > 0) {
    await redis.hSet(subscriberGoalsKey, keysToUpdate);
  }
  await redis.hDel(recentSubscriberPostsByUsernameKey, [normalized]);
}
