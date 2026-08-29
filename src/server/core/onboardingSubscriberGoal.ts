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

export const onboardingSubscriberGoalStateKey = "onboarding_subscriber_goal_v1";
export const onboardingSubscriberGoalLockKey =
  "onboarding_subscriber_goal_v1_lock";
export const onboardingSubscriberGoalVersion = "onboarding_subscriber_goal_v1";
export const onboardingSubscriberGoalDelayMs = 60 * 60 * 1000;
export const onboardingRecentPostWindowMs = 2 * 60 * 60 * 1000;
export const onboardingPinnedPostScanLimit = 100;
export const onboardingRecentPostScanLimit = 1_000;
export const onboardingRecentPostPageSize = 100;

type OnboardingStatus =
  | "pending"
  | "processing"
  | "created"
  | "existing"
  | "failed";

export type OnboardingLifecycleSource = "install" | "upgrade" | "unknown";

export type OnboardingSubscriberGoalState = {
  version: typeof onboardingSubscriberGoalVersion;
  status: OnboardingStatus;
  dueAt: number;
  armedAt: number;
  armToken: string;
  lifecycleSource: OnboardingLifecycleSource;
  startedAt?: number;
  completedAt?: number;
  diagnosticLoggedAt?: number;
  postId?: string;
  errorMessage?: string;
};

export type OnboardingSubscriberGoalSummary = {
  status: "not_due" | "created" | "existing" | "failed" | "already_terminal";
  trackedInspected: number;
  pinnedInspected: number;
  recentInspected: number;
  postId?: string;
  existingSource?: "tracked" | "queued" | "pinned" | "recent";
  lifecycleSource?: OnboardingLifecycleSource;
  terminalStatus?: OnboardingStatus;
  shouldLog?: boolean;
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
    lifecycleSource,
    nowMs = Date.now(),
  }: {
    lifecycleSource: Exclude<OnboardingLifecycleSource, "unknown">;
    nowMs?: number;
  },
): Promise<{
  outcome: "armed" | "existing" | "failed";
  state: OnboardingSubscriberGoalState;
}> {
  const state: OnboardingSubscriberGoalState = {
    version: onboardingSubscriberGoalVersion,
    status: "pending",
    armedAt: nowMs,
    dueAt: nowMs + onboardingSubscriberGoalDelayMs,
    armToken: `${nowMs}:${Math.random().toString(36).slice(2)}`,
    lifecycleSource,
  };
  await redis.set(onboardingSubscriberGoalStateKey, JSON.stringify(state), {
    nx: true,
  });
  const armed =
    (await redis.get(onboardingSubscriberGoalStateKey)) ===
    JSON.stringify(state);
  if (armed) {
    return { outcome: "armed", state };
  }

  const existing = await getOnboardingState(redis);
  if (existing) {
    return { outcome: "existing", state: existing };
  }

  const failedState: OnboardingSubscriberGoalState = {
    ...state,
    status: "failed",
    completedAt: nowMs,
    diagnosticLoggedAt: nowMs,
    errorMessage: "Malformed existing onboarding state; it was not rearmed.",
  };
  await saveOnboardingState(redis, failedState);
  return { outcome: "failed", state: failedState };
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
  const rawState = await redis.get(onboardingSubscriberGoalStateKey);
  if (!rawState) {
    return { status: "not_due", ...base };
  }
  const state = parseOnboardingState(rawState);
  if (!state) {
    const failedState = createMalformedState(nowMs);
    await saveOnboardingState(redis, failedState);
    return {
      status: "failed",
      ...base,
      lifecycleSource: failedState.lifecycleSource,
      shouldLog: true,
      errorMessage:
        "Malformed onboarding state; automatic creation was skipped.",
    };
  }
  if (state.status === "pending" && nowMs < state.dueAt) {
    return { status: "not_due", ...base };
  }
  if (state.status !== "pending") {
    const shouldLog = state.diagnosticLoggedAt === undefined;
    if (shouldLog) {
      await saveOnboardingState(redis, {
        ...state,
        diagnosticLoggedAt: nowMs,
      });
    }
    return {
      status: "already_terminal",
      ...base,
      ...(state.postId ? { postId: state.postId } : {}),
      lifecycleSource: state.lifecycleSource,
      terminalStatus: state.status,
      shouldLog,
    };
  }

  const lockToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(onboardingSubscriberGoalLockKey, lockToken, {
    nx: true,
    expiration: new Date(nowMs + 5 * 60 * 1000),
  });
  if ((await redis.get(onboardingSubscriberGoalLockKey)) !== lockToken) {
    return { status: "already_terminal", ...base };
  }

  try {
    const reloadedState = await getOnboardingState(redis);
    if (!reloadedState || reloadedState.status !== "pending") {
      return { status: "already_terminal", ...base };
    }
    await saveOnboardingState(redis, {
      ...reloadedState,
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
        ...reloadedState,
        status: "existing",
        completedAt: nowMs,
        diagnosticLoggedAt: nowMs,
        postId: existing.postId,
      });
      return {
        status: "existing",
        postId: existing.postId,
        existingSource: existing.source!,
        lifecycleSource: reloadedState.lifecycleSource,
        shouldLog: true,
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
      ...reloadedState,
      status: "created",
      completedAt: nowMs,
      diagnosticLoggedAt: nowMs,
      postId: post.id,
    });
    return {
      status: "created",
      postId: post.id,
      lifecycleSource: reloadedState.lifecycleSource,
      shouldLog: true,
      ...inspected,
    };
  } catch (error) {
    const errorMessage = String(error);
    try {
      const current = await getOnboardingState(redis);
      if (current) {
        await saveOnboardingState(redis, {
          ...current,
          status: "failed",
          completedAt: nowMs,
          diagnosticLoggedAt: nowMs,
          errorMessage,
        });
      }
    } catch (stateError) {
      console.error(
        `[onboardingSubscriberGoal] failed to persist terminal failure: ${String(stateError)}`,
      );
    }
    return {
      status: "failed",
      errorMessage,
      lifecycleSource: state.lifecycleSource,
      shouldLog: true,
      ...inspected,
    };
  } finally {
    try {
      if ((await redis.get(onboardingSubscriberGoalLockKey)) === lockToken) {
        await redis.del(onboardingSubscriberGoalLockKey);
      }
    } catch (lockError) {
      console.warn(
        `[onboardingSubscriberGoal] failed to release execution lock: ${String(lockError)}`,
      );
    }
  }
}

async function findExistingSubscriberGoal(
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

async function getOnboardingState(
  redis: RedisClient,
): Promise<OnboardingSubscriberGoalState | undefined> {
  const raw = await redis.get(onboardingSubscriberGoalStateKey);
  return raw ? parseOnboardingState(raw) : undefined;
}

function parseOnboardingState(
  raw: string,
): OnboardingSubscriberGoalState | undefined {
  try {
    const state = JSON.parse(raw) as Partial<OnboardingSubscriberGoalState>;
    if (
      state.version !== onboardingSubscriberGoalVersion ||
      !["pending", "processing", "created", "existing", "failed"].includes(
        state.status ?? "",
      ) ||
      !Number.isFinite(state.dueAt) ||
      !Number.isFinite(state.armedAt) ||
      typeof state.armToken !== "string" ||
      state.armToken.length === 0
    ) {
      return undefined;
    }
    return {
      ...state,
      lifecycleSource:
        state.lifecycleSource === "upgrade" ||
        state.lifecycleSource === "install"
          ? state.lifecycleSource
          : "unknown",
    } as OnboardingSubscriberGoalState;
  } catch {
    return undefined;
  }
}

function createMalformedState(nowMs: number): OnboardingSubscriberGoalState {
  return {
    version: onboardingSubscriberGoalVersion,
    status: "failed",
    armedAt: nowMs,
    dueAt: nowMs,
    armToken: `malformed:${nowMs}:${Math.random().toString(36).slice(2)}`,
    lifecycleSource: "unknown",
    completedAt: nowMs,
    diagnosticLoggedAt: nowMs,
    errorMessage: "Malformed onboarding state; automatic creation was skipped.",
  };
}

async function saveOnboardingState(
  redis: RedisClient,
  state: OnboardingSubscriberGoalState,
): Promise<void> {
  await redis.set(onboardingSubscriberGoalStateKey, JSON.stringify(state));
}
