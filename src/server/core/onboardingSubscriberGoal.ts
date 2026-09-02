import { createTopPostFallbackAction } from "../../shared/afterSubscribeAction";
import { getSubGoalPostMessages } from "../../shared/subGoalPostI18n";
import {
  subscriberGoalPostKind,
  subscribeOnlyPostKind,
} from "../../shared/postKind";
import type { ServerAppSettings } from "../settings";
import { isLinkId, type RedditClient, type RedisClient } from "../types";
import { getDefaultSubscriberGoal } from "../utils/numberUtils";
import {
  getPostUrl,
  notifyStickyFailure,
} from "../utils/stickyFailureNotifications";
import {
  cancelUpdates,
  getQueuedUpdates,
  getTrackedPosts,
  untrackPost,
} from "../data/updaterData";
import {
  postGoalSuffix,
  postHeightSuffix,
  postKindSuffix,
  subscriberGoalsKey,
} from "../data/subGoalData";
import {
  getRegisteredSubscriberGoalPosts,
  registerSubscriberGoalPost,
  removeSubscriberGoalPost,
} from "../data/subscriberGoalPostRegistry";
import {
  getTerminalRemovedByCategory,
  isMissingPostError,
} from "../utils/postStatus";
import { createSubscriberGoal } from "./createSubscriberGoal";

export const onboardingSubscriberGoalStateKey =
  "onboarding_subscriber_goal_v2_state";
export const onboardingSubscriberGoalVersion = "onboarding_subscriber_goal_v2";
export const onboardingSubscriberGoalDelayMs = 5 * 60 * 1000;
export const onboardingTinySubscriberThreshold = 1_000_000;
export const onboardingRecentPostWindowMs = 25 * 60 * 60 * 1000;
export const onboardingPinnedPostScanLimit = 100;
export const onboardingRecentPostScanLimit = 1_000;
export const onboardingRecentPostPageSize = 100;

type OnboardingStatus = "pending" | "processing" | "complete";

type OnboardingResultStatus = "created" | "existing" | "failed";

export type OnboardingLifecycleSource = "install" | "upgrade" | "unknown";
export type OnboardingExistingSource =
  | "registered"
  | "tracked"
  | "queued"
  | "persisted"
  | "pinned"
  | "recent";

export type OnboardingDetectionDiagnostics = {
  registeredInspected: number;
  trackedInspected: number;
  queuedInspected: number;
  persistedInspected: number;
  pinnedInspected: number;
  recentInspected: number;
  validated: number;
  stalePruned: number;
  failed: number;
};

export type OnboardingSubscriberGoalState = {
  version: typeof onboardingSubscriberGoalVersion;
  status: OnboardingStatus;
  nextRunAt: number;
  armedAt: number;
  lifecycleSource: OnboardingLifecycleSource;
  startedAt?: number;
  completedAt?: number;
  postId?: string;
  existingSource?: OnboardingExistingSource;
  resultStatus?: OnboardingResultStatus;
  errorMessage?: string;
};

export type OnboardingSubscriberGoalSummary = {
  status: "not_due" | "created" | "existing" | "failed" | "complete";
  registeredInspected: number;
  trackedInspected: number;
  queuedInspected: number;
  persistedInspected: number;
  pinnedInspected: number;
  recentInspected: number;
  validated: number;
  stalePruned: number;
  failed: number;
  postId?: string;
  existingSource?: OnboardingExistingSource;
  lifecycleSource?: OnboardingLifecycleSource;
  errorMessage?: string;
};

type CandidatePost = {
  id?: string;
  authorName?: string;
  subredditId?: string;
  subredditName?: string;
  stickied?: boolean;
  createdAt?: Date | string | number;
  postData?: unknown;
  customPostData?: unknown;
  removedByCategory?: string;
  isStickied?: () => boolean | Promise<boolean>;
};

const emptySummary = (): Omit<OnboardingSubscriberGoalSummary, "status"> => ({
  registeredInspected: 0,
  trackedInspected: 0,
  queuedInspected: 0,
  persistedInspected: 0,
  pinnedInspected: 0,
  recentInspected: 0,
  validated: 0,
  stalePruned: 0,
  failed: 0,
});

export async function initializeOnboardingSubscriberGoal(
  redis: RedisClient,
  {
    lifecycleSource = "unknown",
    nowMs = Date.now(),
  }: {
    lifecycleSource?: OnboardingLifecycleSource;
    nowMs?: number;
  },
): Promise<void> {
  const state: OnboardingSubscriberGoalState = {
    version: onboardingSubscriberGoalVersion,
    status: "pending",
    armedAt: nowMs,
    nextRunAt: nowMs + onboardingSubscriberGoalDelayMs,
    lifecycleSource,
  };
  await redis.hSet(
    onboardingSubscriberGoalStateKey,
    serializeOnboardingState(state),
  );
  console.info(
    `[onboardingSubscriberGoal] initialized: status=${state.status} nextRunAt=${state.nextRunAt} source=${state.lifecycleSource} version=${state.version}`,
  );
}

export async function processDueOnboardingSubscriberGoal({
  reddit,
  redis,
  appSettings,
  nowMs = Date.now(),
}: {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  nowMs?: number;
}): Promise<OnboardingSubscriberGoalSummary> {
  const base = emptySummary();
  let inspected = base;
  let state = parseOnboardingState(
    await redis.hGetAll(onboardingSubscriberGoalStateKey),
  );
  if (!state) {
    await initializeOnboardingSubscriberGoal(redis, { nowMs });
    state = parseOnboardingState(
      await redis.hGetAll(onboardingSubscriberGoalStateKey),
    );
  }
  if (!state) {
    console.error("[onboardingSubscriberGoal] failed to initialize state");
    return { status: "failed", ...base, errorMessage: "state_unavailable" };
  }
  if (state.status === "complete") {
    return {
      status: "complete",
      ...base,
      ...(state.postId ? { postId: state.postId } : {}),
      lifecycleSource: state.lifecycleSource,
      ...(state.existingSource ? { existingSource: state.existingSource } : {}),
      ...(state.errorMessage ? { errorMessage: state.errorMessage } : {}),
    };
  }
  if (nowMs < state.nextRunAt) {
    return { status: "not_due", ...base };
  }

  try {
    console.info(
      `[onboardingSubscriberGoal] starting check: source=${state.lifecycleSource} nextRunAt=${state.nextRunAt} status=${state.status}`,
    );
    await saveOnboardingState(redis, {
      ...state,
      status: "processing",
      startedAt: nowMs,
    });

    const existing = await findExistingSubscriberGoal(reddit, redis, nowMs);
    inspected = {
      registeredInspected: existing.registeredInspected,
      trackedInspected: existing.trackedInspected,
      queuedInspected: existing.queuedInspected,
      persistedInspected: existing.persistedInspected,
      pinnedInspected: existing.pinnedInspected,
      recentInspected: existing.recentInspected,
      validated: existing.validated,
      stalePruned: existing.stalePruned,
      failed: existing.failed,
    };
    if (existing.postId) {
      await saveOnboardingState(redis, {
        ...state,
        status: "complete",
        completedAt: nowMs,
        postId: existing.postId,
        existingSource: existing.source!,
        resultStatus: "existing",
      });
      console.info(
        `[onboardingSubscriberGoal] complete: status=existing existingSource=${existing.source} postId=${existing.postId} ${formatDetectionDiagnostics(inspected)}`,
      );
      return {
        status: "existing",
        postId: existing.postId,
        existingSource: existing.source!,
        lifecycleSource: state.lifecycleSource,
        ...inspected,
      };
    }

    const subreddit = await reddit.getCurrentSubreddit();
    const crosspost =
      (subreddit as { isNsfw?: boolean }).isNsfw !== true &&
      subreddit.name.toLowerCase() !== appSettings.promoSubreddit.toLowerCase();
    const useTinyPost =
      subreddit.numberOfSubscribers > onboardingTinySubscriberThreshold;
    const messages = getSubGoalPostMessages("en");
    const { post, stickyResult } = await createSubscriberGoal({
      reddit,
      redis,
      appSettings,
      options: {
        title: messages.defaultPostTitle({ subredditName: subreddit.name }),
        ...(useTinyPost
          ? {}
          : { goal: getDefaultSubscriberGoal(subreddit.numberOfSubscribers) }),
        subredditDisplayName: subreddit.name,
        crosspost,
        colorTheme: "red",
        postHeight: useTinyPost ? "tiny" : "regular",
        autoCreateNextGoal: !useTinyPost,
        language: "en",
        afterSubscribeAction: createTopPostFallbackAction({
          language: "en",
          colorTheme: "red",
        }),
      },
    });
    if (stickyResult.status === "not_pinned") {
      try {
        await notifyStickyFailure({
          reddit,
          subredditId: subreddit.id,
          subredditName: subreddit.name,
          postTitle: post.title,
          postUrl: getPostUrl(post),
          errorMessage: stickyResult.errorMessage,
        });
      } catch (notificationError) {
        console.warn(
          `[onboardingSubscriberGoal] failed to notify sticky failure: ${String(notificationError)}`,
        );
      }
    }
    await saveOnboardingState(redis, {
      ...state,
      status: "complete",
      completedAt: nowMs,
      postId: post.id,
      resultStatus: "created",
    });
    console.info(
      `[onboardingSubscriberGoal] complete: status=created postId=${post.id} ${formatDetectionDiagnostics(inspected)}`,
    );
    return {
      status: "created",
      postId: post.id,
      lifecycleSource: state.lifecycleSource,
      ...inspected,
    };
  } catch (error) {
    inspected = getDetectionDiagnosticsFromError(error) ?? inspected;
    const errorMessage = String(error);
    try {
      await saveOnboardingState(redis, {
        ...state,
        status: "complete",
        completedAt: nowMs,
        resultStatus: "failed",
        errorMessage,
      });
    } catch (stateError) {
      console.error(
        `[onboardingSubscriberGoal] failed to persist terminal failure: ${String(stateError)}`,
      );
    }
    console.error(
      `[onboardingSubscriberGoal] complete: status=failed error=${errorMessage} ${formatDetectionDiagnostics(inspected)}`,
    );
    return {
      status: "failed",
      errorMessage,
      lifecycleSource: state.lifecycleSource,
      ...inspected,
    };
  }
}

export async function findExistingSubscriberGoal(
  reddit: RedditClient,
  redis: RedisClient,
  nowMs: number,
): Promise<
  OnboardingDetectionDiagnostics & {
    postId?: string;
    source?: OnboardingExistingSource;
  }
> {
  const diagnostics: OnboardingDetectionDiagnostics = {
    registeredInspected: 0,
    trackedInspected: 0,
    queuedInspected: 0,
    persistedInspected: 0,
    pinnedInspected: 0,
    recentInspected: 0,
    validated: 0,
    stalePruned: 0,
    failed: 0,
  };
  const [registered, tracked, queued, persisted] = await Promise.all([
    getRegisteredSubscriberGoalPosts(redis),
    getTrackedPosts(redis),
    getQueuedUpdates(redis),
    getPersistedSubscriberGoalCandidates(redis),
  ]);
  const [subreddit, appUser] = await Promise.all([
    reddit.getCurrentSubreddit(),
    reddit.getAppUser(),
  ]);
  if (!appUser?.username) {
    throw new Error(
      "Could not resolve app user while checking onboarding posts.",
    );
  }

  const candidateSources: [OnboardingExistingSource, string[]][] = [
    ["registered", registered],
    ["tracked", tracked],
    ["queued", queued],
    ["persisted", persisted],
  ];
  const seen = new Set<string>();
  for (const [source, postIds] of candidateSources) {
    for (const postId of postIds) {
      if (seen.has(postId) || !isLinkId(postId)) {
        continue;
      }
      seen.add(postId);
      incrementInspected(diagnostics, source);
      let post: CandidatePost | undefined;
      try {
        post = (await reddit.getPostById(postId)) as CandidatePost;
      } catch (error) {
        if (!isMissingPostError(error)) {
          diagnostics.failed += 1;
          attachDetectionDiagnostics(error, diagnostics);
          throw error;
        }
        await pruneStaleCandidate(redis, postId);
        diagnostics.stalePruned += 1;
        continue;
      }
      if (
        !post ||
        !(await isSubscriberGoalCandidate(
          redis,
          post,
          subreddit,
          appUser.username,
        ))
      ) {
        await pruneStaleCandidate(redis, postId);
        diagnostics.stalePruned += 1;
        continue;
      }
      diagnostics.validated += 1;
      await registerSubscriberGoalPost(
        redis,
        postId,
        getCreatedAtMs(post.createdAt) ?? nowMs,
      );
      return { postId, source, ...diagnostics };
    }
  }

  const hotPosts = (await reddit
    .getHotPosts({
      subredditName: subreddit.name,
      limit: onboardingPinnedPostScanLimit,
    })
    .get(onboardingPinnedPostScanLimit)) as CandidatePost[];
  diagnostics.pinnedInspected = hotPosts.length;
  for (const post of hotPosts) {
    if (!(await isStickied(post))) {
      continue;
    }
    if (
      await isSubscriberGoalCandidate(redis, post, subreddit, appUser.username)
    ) {
      diagnostics.validated += 1;
      const postId = post.id!;
      await registerSubscriberGoalPost(
        redis,
        postId,
        getCreatedAtMs(post.createdAt) ?? nowMs,
      );
      return {
        postId,
        source: "pinned",
        ...diagnostics,
      };
    }
  }

  const recentPosts = (await reddit
    .getNewPosts({
      subredditName: subreddit.name,
      limit: onboardingRecentPostScanLimit,
      pageSize: onboardingRecentPostPageSize,
    })
    .all()) as CandidatePost[];
  diagnostics.recentInspected = recentPosts.length;
  const cutoff = nowMs - onboardingRecentPostWindowMs;
  for (const post of recentPosts) {
    const createdAt = getCreatedAtMs(post.createdAt);
    if (createdAt === undefined || createdAt < cutoff) {
      continue;
    }
    if (
      await isSubscriberGoalCandidate(redis, post, subreddit, appUser.username)
    ) {
      diagnostics.validated += 1;
      const postId = post.id!;
      await registerSubscriberGoalPost(redis, postId, createdAt ?? nowMs);
      return {
        postId,
        source: "recent",
        ...diagnostics,
      };
    }
  }
  return diagnostics;
}

async function isSubscriberGoalCandidate(
  redis: RedisClient,
  post: CandidatePost,
  subreddit: { id: string; name: string },
  appUsername: string,
): Promise<boolean> {
  if (
    !post.id ||
    post.authorName !== appUsername ||
    getTerminalRemovedByCategory(post) !== undefined
  ) {
    return false;
  }
  if (
    post.subredditId !== subreddit.id &&
    post.subredditName?.toLowerCase() !== subreddit.name.toLowerCase()
  ) {
    return false;
  }
  const data = post.postData ?? post.customPostData;
  const postKind =
    data && typeof data === "object"
      ? (data as { postKind?: unknown }).postKind
      : undefined;
  if (
    postKind === subscriberGoalPostKind ||
    postKind === subscribeOnlyPostKind
  ) {
    return true;
  }
  return await hasCompatiblePersistedPostData(redis, post.id);
}

async function getPersistedSubscriberGoalCandidates(
  redis: RedisClient,
): Promise<string[]> {
  const postIds = new Set<string>();
  let cursor = 0;
  do {
    const page = await redis.hScan(subscriberGoalsKey, cursor, undefined, 500);
    cursor = page.cursor;
    for (const { field, value } of page.fieldValues) {
      if (
        field.endsWith(postKindSuffix) &&
        (value === subscriberGoalPostKind || value === subscribeOnlyPostKind)
      ) {
        postIds.add(field.slice(0, -postKindSuffix.length));
      } else if (
        field.endsWith(postGoalSuffix) &&
        Number.isFinite(Number(value)) &&
        Number(value) > 0
      ) {
        postIds.add(field.slice(0, -postGoalSuffix.length));
      } else if (field.endsWith(postHeightSuffix) && value === "tiny") {
        postIds.add(field.slice(0, -postHeightSuffix.length));
      }
    }
  } while (cursor !== 0);
  return [...postIds];
}

async function hasCompatiblePersistedPostData(
  redis: RedisClient,
  postId: string,
): Promise<boolean> {
  const [postKind, goal, height] = await redis.hMGet(subscriberGoalsKey, [
    `${postId}${postKindSuffix}`,
    `${postId}${postGoalSuffix}`,
    `${postId}${postHeightSuffix}`,
  ]);
  return (
    postKind === subscriberGoalPostKind ||
    postKind === subscribeOnlyPostKind ||
    (Number.isFinite(Number(goal)) && Number(goal) > 0) ||
    height === "tiny"
  );
}

function incrementInspected(
  diagnostics: OnboardingDetectionDiagnostics,
  source: OnboardingExistingSource,
): void {
  if (source === "registered") diagnostics.registeredInspected += 1;
  else if (source === "tracked") diagnostics.trackedInspected += 1;
  else if (source === "queued") diagnostics.queuedInspected += 1;
  else if (source === "persisted") diagnostics.persistedInspected += 1;
}

function formatDetectionDiagnostics(
  diagnostics: OnboardingDetectionDiagnostics,
): string {
  return `registeredInspected=${diagnostics.registeredInspected} trackedInspected=${diagnostics.trackedInspected} queuedInspected=${diagnostics.queuedInspected} persistedInspected=${diagnostics.persistedInspected} pinnedInspected=${diagnostics.pinnedInspected} recentInspected=${diagnostics.recentInspected} validated=${diagnostics.validated} stalePruned=${diagnostics.stalePruned} failed=${diagnostics.failed}`;
}

function attachDetectionDiagnostics(
  error: unknown,
  diagnostics: OnboardingDetectionDiagnostics,
): void {
  if (error && typeof error === "object") {
    Object.assign(error, {
      onboardingDetectionDiagnostics: { ...diagnostics },
    });
  }
}

export function getDetectionDiagnosticsFromError(
  error: unknown,
): OnboardingDetectionDiagnostics | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return (error as { onboardingDetectionDiagnostics?: unknown })
    .onboardingDetectionDiagnostics as OnboardingDetectionDiagnostics;
}

async function pruneStaleCandidate(
  redis: RedisClient,
  postId: string,
): Promise<void> {
  await Promise.all([
    removeSubscriberGoalPost(redis, postId),
    cancelUpdates(redis, postId),
    untrackPost(redis, postId),
  ]);
}

async function isStickied(post: CandidatePost): Promise<boolean> {
  if (post.stickied) {
    return true;
  }
  return typeof post.isStickied === "function"
    ? Boolean(await post.isStickied())
    : false;
}

function getCreatedAtMs(value: CandidatePost["createdAt"]): number | undefined {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function parseOnboardingState(
  raw: Record<string, string>,
): OnboardingSubscriberGoalState | undefined {
  const status = raw.status;
  const lifecycleSource = raw.lifecycleSource;
  const nextRunAt = parseStateNumber(raw.nextRunAt);
  const armedAt = parseStateNumber(raw.armedAt);
  if (
    raw.version !== onboardingSubscriberGoalVersion ||
    (status !== "pending" &&
      status !== "processing" &&
      status !== "complete") ||
    nextRunAt === undefined ||
    armedAt === undefined
  ) {
    return undefined;
  }
  const state: OnboardingSubscriberGoalState = {
    version: onboardingSubscriberGoalVersion,
    status,
    nextRunAt,
    armedAt,
    lifecycleSource:
      lifecycleSource === "install" || lifecycleSource === "upgrade"
        ? lifecycleSource
        : "unknown",
  };
  const startedAt = parseStateNumber(raw.startedAt);
  const completedAt = parseStateNumber(raw.completedAt);
  if (startedAt !== undefined) state.startedAt = startedAt;
  if (completedAt !== undefined) state.completedAt = completedAt;
  if (raw.postId) state.postId = raw.postId;
  if (raw.errorMessage) state.errorMessage = raw.errorMessage;
  if (
    raw.resultStatus === "created" ||
    raw.resultStatus === "existing" ||
    raw.resultStatus === "failed"
  ) {
    state.resultStatus = raw.resultStatus;
  }
  if (
    raw.existingSource === "registered" ||
    raw.existingSource === "tracked" ||
    raw.existingSource === "queued" ||
    raw.existingSource === "persisted" ||
    raw.existingSource === "pinned" ||
    raw.existingSource === "recent"
  ) {
    state.existingSource = raw.existingSource;
  }
  return state;
}

function parseStateNumber(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function serializeOnboardingState(
  state: OnboardingSubscriberGoalState,
): Record<string, string> {
  return {
    version: state.version,
    status: state.status,
    nextRunAt: String(state.nextRunAt),
    armedAt: String(state.armedAt),
    lifecycleSource: state.lifecycleSource,
    startedAt: String(state.startedAt ?? 0),
    completedAt: String(state.completedAt ?? 0),
    postId: state.postId ?? "",
    existingSource: state.existingSource ?? "",
    resultStatus: state.resultStatus ?? "",
    errorMessage: state.errorMessage ?? "",
  };
}

async function saveOnboardingState(
  redis: RedisClient,
  state: OnboardingSubscriberGoalState,
): Promise<void> {
  await redis.hSet(
    onboardingSubscriberGoalStateKey,
    serializeOnboardingState(state),
  );
}
