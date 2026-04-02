import { isSubredditId, type RedditClient } from '../types';

export type WikiPageRevision = {
  id: string;
  reason: string;
};

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
  const topPosts = await reddit
    .getHotPosts({ limit: 2, subredditName: subreddit.name })
    .all();
  for (const post of topPosts) {
    if (post.stickied && post.authorName === username) {
      await post.unsticky();
      console.log(`Unstickied post: ${post.id}`);
    }
  }
}

export async function safeGetWikiPageRevisions(
  reddit: RedditClient,
  subredditName: string,
  page: string
): Promise<WikiPageRevision[] | undefined> {
  try {
    const revisions = await reddit.getWikiPageRevisions({ subredditName, page }).all();
    return revisions.map((revision) => ({
      id: revision.id,
      reason: revision.reason ?? '',
    }));
  } catch (e) {
    console.error(`Failed to get wiki page ${page} for subreddit ${subredditName}:`, e);
    return undefined;
  }
}
