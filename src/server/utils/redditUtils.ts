import { isLinkId, isSubredditId, type RedditClient } from '../types';
import { logCrosspostEvent, toErrorMessage } from './crosspostLogs';

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
  timeoutMessage: string
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
  defaultIconUrl: string = '/reddit_temp_logo.jpg'
): Promise<string> {
  if (!isSubredditId(subredditId)) {
    return defaultIconUrl;
  }
  if (subredditSettings?.communityIcon) {
    return subredditSettings.communityIcon;
  }
  const subredditStyles = await reddit.getSubredditStyles(subredditId);
  return (
    subredditStyles.icon ??
    defaultIconUrl
  );
}

export async function clearUserStickies(
  reddit: RedditClient,
  username: string,
  options: {
    knownPostIds?: string[];
    subreddit?: { id: string; name: string };
  } = {}
): Promise<void> {
  const subreddit = options.subreddit ?? (await reddit.getCurrentSubreddit());
  const seenPostIds = new Set<string>();
  let unstickiedCount = 0;

  const unstickyIfAppOwned = async (
    post: Awaited<ReturnType<RedditClient['getPostById']>>,
    source: 'known_post' | 'hot_post'
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
    if (!isStickied && typeof verifier === 'function') {
      try {
        isStickied = await Promise.resolve(verifier.call(post));
      } catch (error) {
        console.warn(
          `[sticky] failed to verify existing app-owned sticky: subreddit=${subreddit.name} postId=${post.id} source=${source} error=${toErrorMessage(
            error
          )}`
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
        `[sticky] unstickied app-owned post: subreddit=${subreddit.name} postId=${post.id} source=${source}`
      );
    } catch (error) {
      console.warn(
        `[sticky] failed to unsticky app-owned post: subreddit=${subreddit.name} postId=${post.id} source=${source} error=${toErrorMessage(
          error
        )}`
      );
    }
  };

  for (const postId of [...new Set(options.knownPostIds ?? [])]) {
    if (!isLinkId(postId)) {
      continue;
    }
    try {
      await unstickyIfAppOwned(await reddit.getPostById(postId), 'known_post');
    } catch (error) {
      console.warn(
        `[sticky] failed to fetch known app-owned sticky candidate: subreddit=${subreddit.name} postId=${postId} error=${toErrorMessage(
          error
        )}`
      );
    }
  }

  const hotPosts = await reddit
    .getHotPosts({ limit: 100, subredditName: subreddit.name })
    .get(100);

  for (const post of hotPosts) {
    await unstickyIfAppOwned(post, 'hot_post');
  }

  if (unstickiedCount === 0) {
    console.info(
      `[sticky] no existing app-owned stickies found: subreddit=${subreddit.name}`
    );
  }
}

export async function safeGetWikiPageRevisions(
  reddit: RedditClient,
  subredditName: string,
  page: string
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
      `Timed out fetching wiki revisions for ${subredditName}/${page}`
    );
    const mapped = revisions.map((revision) => {
      const maybeDate =
        revision.date ??
        (revision as { revisionDate?: unknown }).revisionDate;
      let dateMs: number | undefined;
      if (maybeDate instanceof Date) {
        dateMs = maybeDate.getTime();
      } else if (typeof maybeDate === 'number') {
        dateMs = normalizeTimestampMs(maybeDate);
      } else if (typeof maybeDate === 'string') {
        const parsed = Date.parse(maybeDate);
        if (!Number.isNaN(parsed)) {
          dateMs = parsed;
        }
      }

      return {
        id: revision.id,
        reason: revision.reason ?? '',
        ...(typeof dateMs === 'number' ? { dateMs } : {}),
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
        event: 'wiki_fetch_failed',
        targetSubreddit: subredditName,
        page,
        reason: 'fetch_wiki_revisions',
        errorMessage,
        durationMs,
      },
      'error'
    );
    return {
      ok: false,
      revisions: [],
      errorMessage,
      durationMs,
    };
  }
}
