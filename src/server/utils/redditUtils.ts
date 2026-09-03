import { cache, type CacheHelper } from "@devvit/web/server";
import { isLinkId, isSubredditId, type RedditClient } from "../types";
import { logCrosspostEvent, toErrorMessage } from "./crosspostLogs";
import { isMissingPostError } from "./postStatus";
import {
  subscriberGoalPostKind,
  subscribeOnlyPostKind,
} from "../../shared/postKind";

export type WikiPageRevision = {
  id: string;
  reason: string;
  dateMs?: number;
};

export const WIKI_REVISION_FETCH_LIMIT = 100;
export const WIKI_FETCH_TIMEOUT_MS = 10_000;

export type WikiRevisionsFetchResult = {
  ok: boolean;
  revisions: WikiPageRevision[];
  errorMessage?: string;
  durationMs: number;
};

function normalizeTimestampMs(value: number): number {
  // Devvit may return timestamps in either seconds or milliseconds.
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function getSubredditIcon(
  reddit: RedditClient,
  subredditId: string,
  subredditSettings?: { communityIcon?: string },
  // Keep fallback app-owned to avoid external dependency for missing subreddit icons.
  // This replaces the prior remote redditforbusiness-derived fallback URL.
  defaultIconUrl: string = "/reddit_temp_logo.jpg",
  cacheHelper: CacheHelper = cache,
): Promise<string> {
  if (!isSubredditId(subredditId)) {
    return defaultIconUrl;
  }
  if (subredditSettings?.communityIcon) {
    return subredditSettings.communityIcon;
  }
  return await cacheHelper(
    async () => {
      const subredditStyles = await reddit.getSubredditStyles(subredditId);
      return subredditStyles.icon ?? defaultIconUrl;
    },
    {
      key: `subgoal:subreddit-icon:v1:${subredditId}`,
      ttl: 60 * 60,
    },
  );
}

export async function clearUserStickies(
  reddit: RedditClient,
  username: string,
  options: {
    knownPostIds?: string[];
    subreddit?: { id: string; name: string };
  } = {},
): Promise<void> {
  const subreddit = options.subreddit ?? (await reddit.getCurrentSubreddit());
  const seenPostIds = new Set<string>();
  let unstickiedCount = 0;

  const unstickyIfAppOwned = async (
    post: Awaited<ReturnType<RedditClient["getPostById"]>>,
    source: "known_post" | "hot_post",
  ): Promise<void> => {
    if (seenPostIds.has(post.id)) {
      return;
    }
    seenPostIds.add(post.id);

    if (post.subredditId !== subreddit.id || post.authorName !== username) {
      return;
    }

    let isStickied = post.stickied;
    const verifier = (post as { isStickied?: () => boolean | Promise<boolean> })
      .isStickied;
    if (!isStickied && typeof verifier === "function") {
      try {
        isStickied = await Promise.resolve(verifier.call(post));
      } catch (error) {
        console.warn(
          `[sticky] failed to verify existing app-owned sticky: subreddit=${subreddit.name} postId=${post.id} source=${source} error=${toErrorMessage(
            error,
          )}`,
        );
      }
    }

    if (!isStickied) {
      return;
    }

    try {
      await post.unsticky();
      unstickiedCount += 1;
      console.info(
        `[sticky] unstickied app-owned post: subreddit=${subreddit.name} postId=${post.id} source=${source}`,
      );
    } catch (error) {
      console.warn(
        `[sticky] failed to unsticky app-owned post: subreddit=${subreddit.name} postId=${post.id} source=${source} error=${toErrorMessage(
          error,
        )}`,
      );
    }
  };

  for (const postId of [...new Set(options.knownPostIds ?? [])]) {
    if (!isLinkId(postId)) {
      continue;
    }
    try {
      await unstickyIfAppOwned(await reddit.getPostById(postId), "known_post");
    } catch (error) {
      console.warn(
        `[sticky] failed to fetch known app-owned sticky candidate: subreddit=${subreddit.name} postId=${postId} error=${toErrorMessage(
          error,
        )}`,
      );
    }
  }

  const hotPosts = await reddit
    .getHotPosts({ limit: 100, subredditName: subreddit.name })
    .get(100);

  for (const post of hotPosts) {
    await unstickyIfAppOwned(post, "hot_post");
  }

  if (unstickiedCount === 0) {
    console.info(
      `[sticky] no existing app-owned stickies found: subreddit=${subreddit.name}`,
    );
  }
}

export type SubscriberGoalStickyCleanupResult = {
  inspected: number;
  unstickied: string[];
  skippedCrossSubreddit: string[];
  missing: string[];
};

export class SubscriberGoalStickyCleanupError extends Error {
  readonly postIds: string[];

  constructor(postIds: string[]) {
    super(
      "Subscriber Goal could not replace the current goal because one or more older Subscriber Goal posts could not be safely unpinned. Moderator action is required.",
    );
    this.name = "SubscriberGoalStickyCleanupError";
    this.postIds = postIds;
  }
}

type SubscriberGoalPost = Awaited<ReturnType<RedditClient["getPostById"]>>;

async function getPostStickyState(post: SubscriberGoalPost): Promise<boolean> {
  if (post.stickied) return true;
  const verifier = (post as { isStickied?: () => boolean | Promise<boolean> })
    .isStickied;
  return typeof verifier === "function"
    ? Boolean(await Promise.resolve(verifier.call(post)))
    : false;
}

async function unstickyAndVerify(
  reddit: RedditClient,
  post: SubscriberGoalPost,
): Promise<boolean> {
  await post.unsticky();
  try {
    const refreshed = await reddit.getPostById(post.id);
    return !(await getPostStickyState(refreshed));
  } catch (error) {
    // A post that disappeared after the write cannot remain highlighted.
    if (isMissingPostError(error)) return true;
    throw error;
  }
}

function hasSubscriberGoalPostKind(post: SubscriberGoalPost): boolean {
  const data = (post as { postData?: unknown; customPostData?: unknown })
    .postData ??
    (post as { customPostData?: unknown }).customPostData;
  const kind =
    data && typeof data === "object"
      ? (data as { postKind?: unknown }).postKind
      : undefined;
  return kind === subscriberGoalPostKind || kind === subscribeOnlyPostKind;
}

/**
 * Removes only authoritative or self-identifying Subscriber Goal highlights.
 * Known IDs are trusted regardless of author, but are always constrained to the
 * current subreddit. Any unresolved known sticky blocks replacement creation.
 */
export async function clearSubscriberGoalStickies(
  reddit: RedditClient,
  options: {
    knownPostIds: string[];
    subreddit: { id: string; name: string };
  },
): Promise<SubscriberGoalStickyCleanupResult> {
  const result: SubscriberGoalStickyCleanupResult = {
    inspected: 0,
    unstickied: [],
    skippedCrossSubreddit: [],
    missing: [],
  };
  const seen = new Set<string>();
  const blocked = new Set<string>();

  const inspect = async (
    post: SubscriberGoalPost,
    trusted: boolean,
  ): Promise<void> => {
    if (seen.has(post.id)) return;
    seen.add(post.id);
    result.inspected += 1;
    if (post.subredditId !== options.subreddit.id) {
      result.skippedCrossSubreddit.push(post.id);
      return;
    }
    if (!trusted && !hasSubscriberGoalPostKind(post)) return;
    try {
      if (!(await getPostStickyState(post))) return;
      if (!(await unstickyAndVerify(reddit, post))) {
        blocked.add(post.id);
        return;
      }
      result.unstickied.push(post.id);
      console.info(
        `[sticky] unstickied Subscriber Goal: subreddit=${options.subreddit.name} postId=${post.id}`,
      );
    } catch (error) {
      blocked.add(post.id);
      console.warn(
        `[sticky] failed to unsticky Subscriber Goal: subreddit=${options.subreddit.name} postId=${post.id} error=${toErrorMessage(error)}`,
      );
    }
  };

  for (const postId of [...new Set(options.knownPostIds)]) {
    if (!isLinkId(postId)) continue;
    try {
      await inspect(await reddit.getPostById(postId), true);
    } catch (error) {
      if (isMissingPostError(error)) {
        result.missing.push(postId);
      } else {
        blocked.add(postId);
      }
    }
  }

  // This catches recognizable custom goals from older installs without ever
  // treating an unrelated highlight as an app goal.
  try {
    const hotPosts = await reddit
      .getHotPosts({ limit: 100, subredditName: options.subreddit.name })
      .get(100);
    for (const post of hotPosts) await inspect(post, false);
  } catch (error) {
    console.warn(
      `[sticky] failed to inspect hot posts for legacy Subscriber Goals: subreddit=${options.subreddit.name} error=${toErrorMessage(error)}`,
    );
  }

  if (blocked.size) throw new SubscriberGoalStickyCleanupError([...blocked]);
  return result;
}

export async function reconcileSubscriberGoalStickies(
  reddit: RedditClient,
  options: {
    knownPostIds: string[];
    subreddit: { id: string; name: string };
  },
): Promise<{ keptPostId?: string; unstickied: string[]; failed: string[] }> {
  const pinned: SubscriberGoalPost[] = [];
  const orderedPostIds = [...new Set(options.knownPostIds)];
  const candidateOrder = new Map(
    orderedPostIds.map((postId, index) => [postId, index]),
  );
  for (const postId of orderedPostIds) {
    if (!isLinkId(postId)) continue;
    try {
      const post = await reddit.getPostById(postId);
      if (
        post.subredditId === options.subreddit.id &&
        (await getPostStickyState(post))
      ) {
        pinned.push(post);
      }
    } catch (error) {
      if (!isMissingPostError(error)) {
        console.warn(
          `[sticky] lifecycle candidate fetch failed: subreddit=${options.subreddit.name} postId=${postId} error=${toErrorMessage(error)}`,
        );
      }
    }
  }
  const createdAtMs = (post: SubscriberGoalPost): number => {
    const value = post.createdAt;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value;
    return 0;
  };
  pinned.sort(
    (a, b) =>
      createdAtMs(b) - createdAtMs(a) ||
      (candidateOrder.get(b.id) ?? 0) - (candidateOrder.get(a.id) ?? 0),
  );
  const keep = pinned[0];
  const unstickied: string[] = [];
  const failed: string[] = [];
  for (const post of pinned.slice(1)) {
    try {
      if (await unstickyAndVerify(reddit, post)) unstickied.push(post.id);
      else failed.push(post.id);
    } catch (error) {
      failed.push(post.id);
      console.warn(
        `[sticky] lifecycle reconciliation failed: subreddit=${options.subreddit.name} postId=${post.id} error=${toErrorMessage(error)}`,
      );
    }
  }
  return {
    ...(keep ? { keptPostId: keep.id } : {}),
    unstickied,
    failed,
  };
}

export async function safeGetWikiPageRevisions(
  reddit: RedditClient,
  subredditName: string,
  page: string,
): Promise<WikiRevisionsFetchResult> {
  const startedAt = Date.now();

  try {
    const listing = reddit.getWikiPageRevisions({
      subredditName,
      page,
      limit: WIKI_REVISION_FETCH_LIMIT,
    });
    const revisions = await withTimeout(
      listing.get(WIKI_REVISION_FETCH_LIMIT),
      WIKI_FETCH_TIMEOUT_MS,
      `Timed out fetching wiki revisions for ${subredditName}/${page}`,
    );
    const mapped = revisions.map((revision) => {
      const maybeDate =
        revision.date ?? (revision as { revisionDate?: unknown }).revisionDate;
      let dateMs: number | undefined;
      if (maybeDate instanceof Date) {
        dateMs = maybeDate.getTime();
      } else if (typeof maybeDate === "number") {
        dateMs = normalizeTimestampMs(maybeDate);
      } else if (typeof maybeDate === "string") {
        const parsed = Date.parse(maybeDate);
        if (!Number.isNaN(parsed)) {
          dateMs = parsed;
        }
      }

      return {
        id: revision.id,
        reason: revision.reason ?? "",
        ...(typeof dateMs === "number" ? { dateMs } : {}),
      };
    });
    const durationMs = Date.now() - startedAt;
    return {
      ok: true,
      revisions: mapped,
      durationMs,
    };
  } catch (e) {
    const errorMessage = toErrorMessage(e);
    const durationMs = Date.now() - startedAt;
    logCrosspostEvent(
      {
        event: "wiki_fetch_failed",
        targetSubreddit: subredditName,
        page,
        reason: "fetch_wiki_revisions",
        errorMessage,
        durationMs,
      },
      "error",
    );
    return {
      ok: false,
      revisions: [],
      errorMessage,
      durationMs,
    };
  }
}
