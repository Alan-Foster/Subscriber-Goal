import { logDiagnostic } from "../../shared/diagnostics";
import {
  ctaOnlyPostKind,
  subscriberGoalPostKind,
  subscribeOnlyPostKind,
} from "../../shared/postKind";
import {
  isLinkId,
  type LinkId,
  type RedditClient,
  type RedisClient,
} from "../types";
import type { HighlightNotificationOutcome } from "../utils/highlightFailureNotifications";
import { getQueuedUpdates, getTrackedPosts } from "../data/updaterData";
import {
  getSubGoalData,
  postGoalSuffix,
  postHeightSuffix,
  postKindSuffix,
  subscriberGoalsKey,
} from "../data/subGoalData";
import {
  getRegisteredSubscriberGoalPosts,
  registerSubscriberGoalPost,
} from "../data/subscriberGoalPostRegistry";
import { getPostAvailability, isMissingPostError } from "../utils/postStatus";
import type { HighlightResult } from "../utils/communityHighlights";
import { getPersistedSubscriberGoalPostIds } from "../data/subscriberGoalCandidates";
import {
  isSubscriberGoalPostRetired,
  retireSubscriberGoalPost,
} from "./postRetirement";

export const onboardingAuthorSearchLimit = 100;

export type OnboardingLifecycleSource =
  "install" | "upgrade" | "recovery" | "unknown";

export type OnboardingExistingSource =
  | "registered"
  | "tracked"
  | "queued"
  | "persisted"
  | "highlighted"
  | "search"
  | "recent";

export type OnboardingGoalClassification =
  "classic" | "tiny" | "cta" | "ambiguous";

export type GoalClassificationConfidence =
  "explicit" | "migrated_consistent" | "ambiguous";

export type OnboardingDetectionDiagnostics = {
  registeredInspected: number;
  trackedInspected: number;
  queuedInspected: number;
  persistedInspected: number;
  highlightedInspected: number;
  searchInspected: number;
  recentInspected: number;
  validated: number;
  stalePruned: number;
  failed: number;
};

type CandidatePost = {
  id?: string;
  authorName?: string;
  subredditId?: string;
  subredditName?: string;
  createdAt?: Date | string | number;
  postData?: unknown;
  customPostData?: unknown;
  removedByCategory?: string;
  archived?: boolean;
  locked?: boolean;
  isHighlighted?: () => Promise<boolean>;
  highlight?: (options?: {
    highlightUntil?: Date;
    highlightLabelType?:
      "ANNOUNCEMENT" | "EVENT" | "MEGATHREAD" | "SHOW_POST_FLAIR";
  }) => Promise<void>;
  unhighlight?: () => Promise<void>;
  title?: string;
  permalink?: string;
  url?: string;
  postHeight?: unknown;
};

export type OnboardingGoalCandidate = {
  postId: LinkId;
  post: CandidatePost;
  source: OnboardingExistingSource;
  createdAtMs?: number;
  isHighlighted: boolean;
  postKind?: string;
  postHeight?: string;
  classification: OnboardingGoalClassification;
  classificationConfidence: GoalClassificationConfidence;
  goal?: number;
  completedTime?: number;
  autoCreateNextGoal?: boolean;
  autoCreateNextGoalConfigured?: boolean;
  discoveryOrder: number;
};

export type OnboardingHighlightEnsuranceResult =
  OnboardingDetectionDiagnostics & {
    status: "missing" | "existing" | "existing_not_highlighted" | "completed";
    postId?: string;
    source?: OnboardingExistingSource;
    classification?: OnboardingGoalClassification;
    classificationConfidence?: GoalClassificationConfidence;
    selectedWasAlreadyHighlighted?: boolean;
    pausedByRemovedGoal?: boolean;
    removedGoalBlockerPostIds?: string[];
    candidateCount: number;
    highlightedClassicCount: number;
    highlightedProtectedCount: number;
    highlightedAmbiguousCount: number;
    classicPostsUnhighlighted: string[];
    highlightSelectedPostId?: string;
    managedHighlightsRemoved?: string[];
    protectedHighlightsPreserved: string[];
    eligiblePostIds: string[];
    unhighlightedEligiblePostIds: string[];
    verificationResult?: "highlighted" | "not_highlighted";
    reconciliationOutcome?: "complete" | "degraded" | "failed";
    failureCategories?: HighlightResult["issues"][number]["category"][];
    capacityOutcome?: HighlightResult["capacityOutcome"];
    capacityOnly?: boolean;
    cleanupOutcome?: HighlightResult["cleanupOutcome"];
    rollbackOutcome?: HighlightResult["rollbackOutcome"];
    notificationOutcome?: HighlightNotificationOutcome;
    goal?: number;
    completedTime?: number;
    autoCreateNextGoal?: boolean;
    autoCreateNextGoalConfigured?: boolean;
    deferredCompletedGoal?: {
      postId: string;
      completedTime: number;
      autoCreateNextGoal: boolean;
    };
    supersededCompletedPostIds?: string[];
    errorMessage?: string;
  };

export const emptySummary = (): OnboardingDetectionDiagnostics => ({
  registeredInspected: 0,
  trackedInspected: 0,
  queuedInspected: 0,
  persistedInspected: 0,
  highlightedInspected: 0,
  searchInspected: 0,
  recentInspected: 0,
  validated: 0,
  stalePruned: 0,
  failed: 0,
});

/**
 * Discovers every valid app-owned goal needed by highlight reconciliation.
 * Unlike duplicate prevention, this intentionally includes old unhighlighted goals so an
 * install/upgrade can restore the newest one instead of creating a duplicate.
 */
export async function findValidSubscriberGoals(
  reddit: RedditClient,
  redis: RedisClient,
  nowMs = Date.now(),
  includeRecovery = true,
): Promise<
  OnboardingDetectionDiagnostics & {
    candidates: OnboardingGoalCandidate[];
    removedActiveGoals: OnboardingGoalCandidate[];
  }
> {
  const diagnostics: OnboardingDetectionDiagnostics = {
    registeredInspected: 0,
    trackedInspected: 0,
    queuedInspected: 0,
    persistedInspected: 0,
    highlightedInspected: 0,
    searchInspected: 0,
    recentInspected: 0,
    validated: 0,
    stalePruned: 0,
    failed: 0,
  };
  const [registered, tracked, queued, persisted, subreddit, appUser] =
    await Promise.all([
      getRegisteredSubscriberGoalPosts(redis),
      getTrackedPosts(redis),
      getQueuedUpdates(redis),
      getPersistedSubscriberGoalPostIds(redis),
      reddit.getCurrentSubreddit(),
      reddit.getAppUser(),
    ]);
  if (!appUser?.username) {
    throw new Error(
      "Could not resolve app user while checking onboarding posts.",
    );
  }
  const highlightedPosts = await subreddit.getHighlightedPosts();
  const highlightedPostIds = new Set<string>(
    highlightedPosts.map(({ postId }) => postId),
  );
  diagnostics.highlightedInspected = highlightedPosts.length;

  const candidates: OnboardingGoalCandidate[] = [];
  const removedActiveGoals: OnboardingGoalCandidate[] = [];
  const seen = new Set<string>();
  const inspect = createGoalInspector({
    redis,
    subreddit,
    username: appUser.username,
    highlightedPostIds,
    candidates,
    removedActiveGoals,
    seen,
    diagnostics,
    nowMs,
  });

  const knownSources: [OnboardingExistingSource, string[]][] = [
    ["registered", registered],
    ["tracked", tracked],
    ["queued", queued],
    ["persisted", persisted],
  ];
  const discovery = { reddit, redis, nowMs, diagnostics, seen, inspect };
  await inspectKnownGoalPosts(discovery, knownSources);
  await inspectHighlightedGoalPosts(discovery, highlightedPosts);
  if (includeRecovery)
    await searchForGoalPosts(discovery, subreddit.name, appUser.username);
  return { ...diagnostics, candidates, removedActiveGoals };
}

type DiscoveryPass = {
  reddit: RedditClient;
  redis: RedisClient;
  nowMs: number;
  diagnostics: OnboardingDetectionDiagnostics;
  seen: Set<string>;
  inspect: (
    post: CandidatePost,
    source: OnboardingExistingSource,
    pruneInvalid: boolean,
  ) => Promise<void>;
};

function createGoalInspector({
  redis,
  subreddit,
  username,
  highlightedPostIds,
  candidates,
  removedActiveGoals,
  seen,
  diagnostics,
  nowMs,
}: {
  redis: RedisClient;
  subreddit: Awaited<ReturnType<RedditClient["getCurrentSubreddit"]>>;
  username: string;
  highlightedPostIds: ReadonlySet<string>;
  candidates: OnboardingGoalCandidate[];
  removedActiveGoals: OnboardingGoalCandidate[];
  seen: Set<string>;
  diagnostics: OnboardingDetectionDiagnostics;
  nowMs: number;
}): DiscoveryPass["inspect"] {
  let discoveryOrder = 0;
  return async (
    post: CandidatePost,
    source: OnboardingExistingSource,
    pruneInvalid: boolean,
  ): Promise<void> => {
    const postId = post.id;
    if (!postId || seen.has(postId) || !isLinkId(postId)) return;
    seen.add(postId);
    if (await isSubscriberGoalPostRetired(redis, postId)) return;
    const availability = getPostAvailability(post);
    const isCandidate = await isSubscriberGoalCandidate(
      redis,
      post,
      subreddit,
      username,
    );
    if (availability.status === "temporarily_removed") {
      // Historical removals must not block unrelated work. Only an unfinished
      // classic goal prevents a replacement; none of these posts are pruned.
      if (isCandidate) {
        const metadata = await getGoalCandidateMetadata(redis, post);
        if (metadata.classification === "classic") {
          const goalData = await getSubGoalData(
            redis,
            postId,
            post.postData ?? post.customPostData,
          );
          if (!goalData.completedTime) {
            const createdAtMs = getCreatedAtMs(post.createdAt);
            removedActiveGoals.push({
              postId,
              post,
              source,
              ...(createdAtMs === undefined ? {} : { createdAtMs }),
              isHighlighted: false,
              ...metadata,
              goal: goalData.goal,
              completedTime: goalData.completedTime,
              discoveryOrder: discoveryOrder++,
            });
          }
        }
      }
      return;
    }
    if (!isCandidate) {
      if (pruneInvalid) {
        await pruneStaleCandidate(redis, postId);
        diagnostics.stalePruned += 1;
      }
      return;
    }
    const metadata = await getGoalCandidateMetadata(redis, post);
    const isHighlighted = highlightedPostIds.has(postId);
    diagnostics.validated += 1;
    await registerSubscriberGoalPost(
      redis,
      postId,
      getCreatedAtMs(post.createdAt) ?? nowMs,
    );
    const createdAtMs = getCreatedAtMs(post.createdAt);
    candidates.push({
      postId,
      post,
      source,
      ...(createdAtMs === undefined ? {} : { createdAtMs }),
      isHighlighted,
      ...metadata,
      discoveryOrder: discoveryOrder++,
    });
  };
}

async function inspectKnownGoalPosts(
  { reddit, redis, nowMs, diagnostics, seen, inspect }: DiscoveryPass,
  knownSources: [OnboardingExistingSource, string[]][],
): Promise<void> {
  for (const [source, postIds] of knownSources) {
    for (const postId of postIds) {
      if (seen.has(postId) || !isLinkId(postId)) continue;
      incrementInspected(diagnostics, source);
      try {
        const fetched = (await reddit.getPostById(postId)) as
          CandidatePost | undefined;
        if (!fetched) {
          throw new Error(
            `Reddit returned no post and no confirmed missing-post response for ${postId}.`,
          );
        }
        await inspect(fetched, source, true);
      } catch (error) {
        if (isMissingPostError(error, postId)) {
          seen.add(postId);
          await retireSubscriberGoalPost(
            redis,
            postId,
            "confirmed_missing",
            nowMs,
          );
          diagnostics.stalePruned += 1;
          continue;
        }
        diagnostics.failed += 1;
        attachDetectionDiagnostics(error, diagnostics);
        throw error;
      }
    }
  }
}

async function inspectHighlightedGoalPosts(
  { reddit, redis, nowMs, diagnostics, seen, inspect }: DiscoveryPass,
  highlightedPosts: Awaited<
    ReturnType<
      Awaited<
        ReturnType<RedditClient["getCurrentSubreddit"]>
      >["getHighlightedPosts"]
    >
  >,
): Promise<void> {
  for (const { postId } of highlightedPosts) {
    if (seen.has(postId)) continue;
    try {
      await inspect(
        (await reddit.getPostById(postId)) as CandidatePost,
        "highlighted",
        false,
      );
    } catch (error) {
      if (isMissingPostError(error, postId) && isLinkId(postId)) {
        await retireSubscriberGoalPost(
          redis,
          postId,
          "confirmed_missing_highlight",
          nowMs,
        );
        diagnostics.stalePruned += 1;
      } else {
        diagnostics.failed += 1;
        attachDetectionDiagnostics(error, diagnostics);
        throw error;
      }
    }
  }
}

async function searchForGoalPosts(
  { reddit, diagnostics, inspect }: DiscoveryPass,
  subredditName: string,
  username: string,
): Promise<void> {
  const searchedPosts = (await reddit
    .searchPosts({
      query: `author:${username}`,
      subredditName,
      sort: "new",
      timeframe: "all",
      limit: onboardingAuthorSearchLimit,
      pageSize: onboardingAuthorSearchLimit,
    })
    .all()) as CandidatePost[];
  diagnostics.searchInspected = searchedPosts.length;
  for (const post of searchedPosts) await inspect(post, "search", false);
}

async function getGoalCandidateMetadata(
  redis: RedisClient,
  post: CandidatePost,
): Promise<{
  postKind?: string;
  postHeight?: string;
  classification: OnboardingGoalClassification;
  classificationConfidence: GoalClassificationConfidence;
}> {
  const data = post.postData ?? post.customPostData;
  const inline =
    data && typeof data === "object"
      ? (data as { postKind?: unknown; postHeight?: unknown })
      : undefined;
  const [persistedKind, persistedHeight] = await redis.hMGet(
    subscriberGoalsKey,
    [`${post.id}${postKindSuffix}`, `${post.id}${postHeightSuffix}`],
  );
  const inlineKind =
    typeof inline?.postKind === "string" ? inline.postKind : undefined;
  const inlineHeight = inline?.postHeight ?? post.postHeight;
  const explicitHeight =
    typeof inlineHeight === "string" ? inlineHeight : undefined;
  return classifyGoalCandidate(
    post.id,
    inlineKind,
    persistedKind,
    explicitHeight,
    persistedHeight,
  );
}

function classifyGoalCandidate(
  postId: CandidatePost["id"],
  inlineKind: string | undefined,
  persistedKind: string | null | undefined,
  explicitHeight: string | undefined,
  persistedHeight: string | null | undefined,
) {
  const postKind = inlineKind ?? persistedKind;
  const postHeight = explicitHeight ?? persistedHeight;
  let classification: OnboardingGoalClassification = "ambiguous";
  let classificationConfidence: GoalClassificationConfidence = "ambiguous";
  const kinds = new Set([inlineKind, persistedKind].filter(Boolean));
  const heights = new Set([explicitHeight, persistedHeight].filter(Boolean));
  const hasClassic =
    kinds.has(subscriberGoalPostKind) ||
    heights.has("regular") ||
    heights.has("short");
  const hasTiny = kinds.has(subscribeOnlyPostKind) || heights.has("tiny");
  const hasCta = kinds.has(ctaOnlyPostKind) || heights.has("cta");
  const conflicting = [hasClassic, hasTiny, hasCta].filter(Boolean).length > 1;
  if (!conflicting) {
    if (
      postKind === subscriberGoalPostKind &&
      (postHeight === "regular" || postHeight === "short")
    ) {
      classification = "classic";
    } else if (postKind === subscribeOnlyPostKind && postHeight === "tiny") {
      classification = "tiny";
    } else if (postKind === ctaOnlyPostKind && postHeight === "cta") {
      classification = "cta";
    }
    if (classification !== "ambiguous") {
      classificationConfidence =
        inlineKind !== undefined && explicitHeight !== undefined
          ? "explicit"
          : "migrated_consistent";
    }
  } else {
    logDiagnostic("warn", "subscriber_goal_metadata_conflict_preserved", {
      workflow: "onboarding_highlight_ensurance",
      phase: "classification",
      postId: postId ?? "unknown",
      inlineKind: inlineKind ?? "none",
      persistedKind: persistedKind ?? "none",
      inlineHeight: explicitHeight ?? "none",
      persistedHeight: persistedHeight ?? "none",
    });
  }
  return {
    ...(postKind ? { postKind } : {}),
    ...(postHeight ? { postHeight } : {}),
    classification,
    classificationConfidence,
  };
}

async function isSubscriberGoalCandidate(
  redis: RedisClient,
  post: CandidatePost,
  subreddit: { id: string; name: string },
  appUsername: string,
): Promise<boolean> {
  if (
    !post.id ||
    post.authorName?.toLowerCase() !== appUsername.toLowerCase() ||
    getPostAvailability(post).status === "terminal"
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
    postKind === subscribeOnlyPostKind ||
    postKind === ctaOnlyPostKind
  ) {
    return true;
  }
  return await hasCompatiblePersistedPostData(redis, post.id);
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
    postKind === ctaOnlyPostKind ||
    (Number.isFinite(Number(goal)) && Number(goal) > 0) ||
    height === "tiny" ||
    height === "cta"
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

export function formatDetectionDiagnostics(
  diagnostics: OnboardingDetectionDiagnostics,
): string {
  return `registeredInspected=${diagnostics.registeredInspected} trackedInspected=${diagnostics.trackedInspected} queuedInspected=${diagnostics.queuedInspected} persistedInspected=${diagnostics.persistedInspected} highlightedInspected=${diagnostics.highlightedInspected} searchInspected=${diagnostics.searchInspected} recentInspected=${diagnostics.recentInspected} validated=${diagnostics.validated} stalePruned=${diagnostics.stalePruned} failed=${diagnostics.failed}`;
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
  postId: LinkId,
): Promise<void> {
  await retireSubscriberGoalPost(
    redis,
    postId,
    "invalid_reconciliation_candidate",
  );
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
