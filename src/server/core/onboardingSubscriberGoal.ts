import { createTopPostFallbackAction } from "../../shared/afterSubscribeAction";
import { getSubGoalPostMessages } from "../../shared/subGoalPostI18n";
import {
  subscriberGoalPostKind,
  subscribeOnlyPostKind,
} from "../../shared/postKind";
import type { ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import { getDefaultSubscriberGoal } from "../utils/numberUtils";
import {
  getPostUrl,
  notifyStickyFailure,
} from "../utils/stickyFailureNotifications";
import { getQueuedUpdates, getTrackedPosts } from "../data/updaterData";
import { createSubscriberGoal } from "./createSubscriberGoal";

export const onboardingSubscriberGoalStateKey =
  "onboarding_subscriber_goal_v2_state";
export const onboardingSubscriberGoalVersion = "onboarding_subscriber_goal_v2";
export const onboardingSubscriberGoalDelayMs = 24 * 60 * 60 * 1000;
export const onboardingRecentPostWindowMs = 2 * 60 * 60 * 1000;
export const onboardingPinnedPostScanLimit = 100;
export const onboardingRecentPostScanLimit = 1_000;
export const onboardingRecentPostPageSize = 100;

type OnboardingStatus = "pending" | "processing" | "complete";

type OnboardingResultStatus = "created" | "existing" | "failed";

export type OnboardingLifecycleSource = "install" | "upgrade" | "unknown";

export type OnboardingSubscriberGoalState = {
  version: typeof onboardingSubscriberGoalVersion;
  status: OnboardingStatus;
  nextRunAt: number;
  armedAt: number;
  lifecycleSource: OnboardingLifecycleSource;
  startedAt?: number;
  completedAt?: number;
  postId?: string;
  existingSource?: "tracked" | "queued" | "pinned" | "recent";
  resultStatus?: OnboardingResultStatus;
  errorMessage?: string;
};

export type OnboardingSubscriberGoalSummary = {
  status: "not_due" | "created" | "existing" | "failed" | "complete";
  trackedInspected: number;
  pinnedInspected: number;
  recentInspected: number;
  postId?: string;
  existingSource?: "tracked" | "queued" | "pinned" | "recent";
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
  isStickied?: () => boolean | Promise<boolean>;
};

const emptySummary = (): Omit<OnboardingSubscriberGoalSummary, "status"> => ({
  trackedInspected: 0,
  pinnedInspected: 0,
  recentInspected: 0,
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
  const raw = await redis.hGetAll(onboardingSubscriberGoalStateKey);
  if (parseOnboardingState(raw)) {
    return;
  }
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
      trackedInspected: existing.trackedInspected,
      pinnedInspected: existing.pinnedInspected,
      recentInspected: existing.recentInspected,
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
        `[onboardingSubscriberGoal] complete: status=existing existingSource=${existing.source} postId=${existing.postId} trackedInspected=${inspected.trackedInspected} pinnedInspected=${inspected.pinnedInspected} recentInspected=${inspected.recentInspected}`,
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
    const messages = getSubGoalPostMessages("en");
    const { post, stickyResult } = await createSubscriberGoal({
      reddit,
      redis,
      appSettings,
      options: {
        title: messages.defaultPostTitle({ subredditName: subreddit.name }),
        goal: getDefaultSubscriberGoal(subreddit.numberOfSubscribers),
        subredditDisplayName: subreddit.name,
        crosspost,
        colorTheme: "red",
        postHeight: "regular",
        autoCreateNextGoal: true,
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
      `[onboardingSubscriberGoal] complete: status=created postId=${post.id} trackedInspected=${inspected.trackedInspected} pinnedInspected=${inspected.pinnedInspected} recentInspected=${inspected.recentInspected}`,
    );
    return {
      status: "created",
      postId: post.id,
      lifecycleSource: state.lifecycleSource,
      ...inspected,
    };
  } catch (error) {
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
      `[onboardingSubscriberGoal] complete: status=failed error=${errorMessage} trackedInspected=${inspected.trackedInspected} pinnedInspected=${inspected.pinnedInspected} recentInspected=${inspected.recentInspected}`,
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
): Promise<{
  postId?: string;
  source?: "tracked" | "queued" | "pinned" | "recent";
  trackedInspected: number;
  pinnedInspected: number;
  recentInspected: number;
}> {
  const [tracked, queued] = await Promise.all([
    getTrackedPosts(redis),
    getQueuedUpdates(redis),
  ]);
  if (tracked.length > 0 || queued.length > 0) {
    const source = tracked.length > 0 ? "tracked" : "queued";
    const postId = (tracked.length > 0 ? tracked : queued)[0]!;
    return {
      postId,
      source,
      trackedInspected: tracked.length + queued.length,
      pinnedInspected: 0,
      recentInspected: 0,
    };
  }

  const [subreddit, appUser] = await Promise.all([
    reddit.getCurrentSubreddit(),
    reddit.getAppUser(),
  ]);
  if (!appUser?.username) {
    throw new Error(
      "Could not resolve app user while checking onboarding posts.",
    );
  }
  const hotPosts = (await reddit
    .getHotPosts({
      subredditName: subreddit.name,
      limit: onboardingPinnedPostScanLimit,
    })
    .get(onboardingPinnedPostScanLimit)) as CandidatePost[];
  for (const post of hotPosts) {
    if (!(await isStickied(post))) {
      continue;
    }
    if (isSubscriberGoalCandidate(post, subreddit, appUser.username)) {
      return {
        postId: post.id,
        source: "pinned",
        trackedInspected: 0,
        pinnedInspected: hotPosts.length,
        recentInspected: 0,
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
  const cutoff = nowMs - onboardingRecentPostWindowMs;
  for (const post of recentPosts) {
    const createdAt = getCreatedAtMs(post.createdAt);
    if (createdAt === undefined || createdAt < cutoff) {
      continue;
    }
    if (isSubscriberGoalCandidate(post, subreddit, appUser.username)) {
      return {
        postId: post.id,
        source: "recent",
        trackedInspected: 0,
        pinnedInspected: hotPosts.length,
        recentInspected: recentPosts.length,
      };
    }
  }
  return {
    trackedInspected: 0,
    pinnedInspected: hotPosts.length,
    recentInspected: recentPosts.length,
  };
}

function isSubscriberGoalCandidate(
  post: CandidatePost,
  subreddit: { id: string; name: string },
  appUsername: string,
): post is CandidatePost & { id: string } {
  if (!post.id || post.authorName !== appUsername) {
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
  return (
    postKind === subscriberGoalPostKind ||
    postKind === subscribeOnlyPostKind ||
    postKind === undefined
  );
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
    raw.existingSource === "tracked" ||
    raw.existingSource === "queued" ||
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
