/**
 * @file Utility functions for interacting with the RedditAPIClient.
 */

import {RedditAPIClient, WikiPageRevision} from '@devvit/public-api';

/**
 * Gets the subreddit icon URL if available, otherwise returns a default icon URL.
 * @param reddit - Instance of RedditAPIClient.
 * @param subredditId - The ID of the subreddit to get the icon for (e.g., 't5_2qh23').
 * @param defaultIconUrl - The default icon URL to return if the subreddit icon is not available.
 * @returns The URL of the subreddit icon or the default if undefined.
 */
export async function getSubredditIcon (reddit: RedditAPIClient, subredditId: string, defaultIconUrl: string = 'https://i.redd.it/xaaj3xsdy0re1.png'): Promise<string> {
  const subredditStyles = await reddit.getSubredditStyles(subredditId);
  return subredditStyles.icon ?? defaultIconUrl;
}

/**
 * Clears all stickied posts by a specific user in the current subreddit.
 * @param reddit - Instance of RedditAPIClient.
 * @param username - The username of whose stickied posts you want to clear.
 */
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

/**
 * Safely retrieves the revisions of a wiki page in a subreddit (catching errors, for example 404s for pages that haven't been created yet).
 * @param reddit - Instance of RedditAPIClient.
 * @param subredditName - The name of the subreddit where the wiki page is located.
 * @param page - The name of the wiki page, this can be top-level or nested (e.g., "page" or "page/subpage").
 * @returns Returns an array of the revisions, or undefined if an error occurs.
 * @todo Replace this with a generator that allows iterating through revisions page by page or at least support pagination properties such as after and before (pending {@link https://github.com/reddit/devvit/issues/197}).
 */
export async function safeGetWikiPageRevisions (reddit: RedditAPIClient, subredditName: string, page: string): Promise<WikiPageRevision[] | undefined> {
  try {
    return reddit.getWikiPageRevisions({subredditName, page}).all();
  } catch (e) {
    console.error(`Failed to get wiki page ${page} for subreddit ${subredditName}:`, e);
    return undefined;
  }
}
