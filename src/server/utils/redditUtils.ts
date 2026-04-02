import { isSubredditId, type RedditClient } from '../types';
import { logCrosspostEvent, toErrorMessage } from './crosspostLogs';

export type WikiPageRevision = {
  id: string;
  reason: string;
};

export const WIKI_REVISION_FETCH_LIMIT = 100;
export const WIKI_FETCH_TIMEOUT_MS = 10_000;

export type WikiRevisionsFetchResult = {
  ok: boolean;
  revisions: WikiPageRevision[];
  errorMessage?: string;
  durationMs: number;
};

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
  defaultIconUrl: string = 'https://i.redd.it/xaaj3xsdy0re1.png'
): Promise<string> {
  if (!isSubredditId(subredditId)) {
    return defaultIconUrl;
  }
  const subredditStyles = await reddit.getSubredditStyles(subredditId);
  return (
    subredditStyles.icon ??
    defaultIconUrl
  );
}

export async function clearUserStickies(
  reddit: RedditClient,
  username: string
): Promise<void> {
  const subreddit = await reddit.getCurrentSubreddit();
  const hotPosts = await reddit
    .getHotPosts({ limit: 100, subredditName: subreddit.name })
    .get(100);
  const stickyPosts = hotPosts.filter(
    (post) => post.stickied && post.authorName === username
  );

  for (const post of stickyPosts) {
    try {
      await post.unsticky();
      console.info(
        `[sticky] unstickied app-owned post: subreddit=${subreddit.name} postId=${post.id}`
      );
    } catch (error) {
      console.warn(
        `[sticky] failed to unsticky app-owned post: subreddit=${subreddit.name} postId=${post.id} error=${toErrorMessage(
          error
        )}`
      );
    }
  }

  if (stickyPosts.length === 0) {
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
  logCrosspostEvent({
    event: 'wiki_fetch_started',
    targetSubreddit: subredditName,
    page,
    reason: 'fetch_wiki_revisions',
  });

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
    const mapped = revisions.map((revision) => ({
      id: revision.id,
      reason: revision.reason ?? '',
    }));
    const durationMs = Date.now() - startedAt;
    logCrosspostEvent({
      event: 'wiki_fetch_succeeded',
      targetSubreddit: subredditName,
      page,
      reason: 'fetch_wiki_revisions',
      revisionsFetched: mapped.length,
      durationMs,
    });
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
