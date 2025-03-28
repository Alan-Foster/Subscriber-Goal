import {RedditAPIClient, WikiPageRevision} from '@devvit/public-api';

export async function getSubredditIcon (reddit: RedditAPIClient, subredditId: string, defaultIconUrl: string = 'https://i.redd.it/xaaj3xsdy0re1.png'): Promise<string> {
  const subredditStyles = await reddit.getSubredditStyles(subredditId);
  return subredditStyles.icon ?? defaultIconUrl;
}

export async function clearUserStickies (reddit: RedditAPIClient, username: string): Promise<void> {
  const subredditName = await reddit.getCurrentSubredditName();
  const topPosts = await reddit.getHotPosts({limit: 2, subredditName}).all();
  for (const post of topPosts) {
    if (post.stickied && post.authorName === username) {
      await post.unsticky();
      console.log(`Unstickied post: ${post.id}`);
    }
  }
}

export async function safeGetWikiPageRevisions (reddit: RedditAPIClient, subredditName: string, page: string): Promise<WikiPageRevision[] | undefined> {
  try {
    return reddit.getWikiPageRevisions({subredditName, page}).all();
  } catch (e) {
    console.error(`Failed to get wiki page ${page} for subreddit ${subredditName}:`, e);
    return undefined;
  }
}
