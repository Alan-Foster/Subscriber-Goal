/**
 * @file These are the functions for sending events to the central promo subreddit via wiki revisions, as well as the way the central promo subreddit keeps track of crosspost-post relationships and processed revisions.
 */

import {RedisClient} from '@devvit/public-api';

export type PostActionType = 'remove' | 'approve' | 'delete';

export const modToPostActionMap: Record<string, PostActionType> = {
  removelink: 'remove',
  spamlink: 'remove',
  approvelink: 'approve',
};

/**
 * This function tells the central promo subreddit about a new post, it should be called when such a post is created.
 *
 * This should not be used on the central promo subreddit itself.
 * @param reddit - Instance of RedditAPIClient.
 * @param appSettings - Application settings object, specifically used for determining the central promo subreddit.
 * @param postId - The full ID of the post that was created (e.g., 't3_123456').
 * @param goal - The subscriber goal for the created post.
 */
// export async function dispatchNewPost (reddit: RedditAPIClient, appSettings: AppSettings, postId: string, goal: number): Promise<void> {
//   await reddit.updateWikiPage({subredditName: appSettings.promoSubreddit, page: '/post', content: `${postId}\n${goal}`, reason: `Post ${postId} with goal ${goal}`});
// }

/**
 * This function tells the central promo subreddit about an action taken on a post.
 * Dispatching removals and approvals this way allows the original pot to be removed temporarily from the original subreddit and also from the central promo subreddit, while allowing for the restoration of both posts if reapproved.
 *
 * This should not be used on the central promo subreddit itself.
 * @param reddit - Instance of RedditAPIClient.
 * @param appSettings - Application settings object, specifically used for determining the central promo subreddit.
 * @param postId - The full ID of the post that was actioned (e.g., 't3_123456').
 * @param action - This is either a `remove`, `delete`, or `approve` action, which will be sent to the central promo subreddit and mirrored there on the crosspost.
 */
// export async function dispatchPostAction (reddit: RedditAPIClient, appSettings: AppSettings, postId: string, action: PostActionType): Promise<void> {
//   await reddit.updateWikiPage({subredditName: appSettings.promoSubreddit, page: `/${action}`, content: postId, reason: `Dispatch ${action} for ${postId}`}); ;
// }

export const crosspostListKey = 'crosspostList';

/**
 * Stores a mapping between a post ID on a different subreddit and its corresponding crosspost ID on the central promo subreddit.
 * This is used to keep track of which posts actions dispatched from the originating subreddit should be mirrored to on the central promo subreddit.
 *
 * This should only be used by an instance of the app running on the central promo subreddit.
 * @param redis - Instance of RedisClient.
 * @param postId - The full ID of the post on the originating subreddit (e.g., 't3_123456').
 * @param crosspostId - The full ID of the crosspost on the central promo subreddit (e.g., 't3_654321').
 */
export async function storeCorrespondingPost (redis: RedisClient, postId: string, crosspostId: string): Promise<void> {
  await redis.hSet(crosspostListKey, {
    [postId]: crosspostId,
  });
};

/**
 * Retrieves the post ID of the crosspost on the central promo subreddit that corresponds to a given post ID on another subreddit.
 *
 * This should only be used by an instance of the app running on the central promo subreddit.
 * @param redis - Instance of RedisClient.
 * @param postId - The full ID of the post on the originating subreddit (e.g., 't3_123456').
 * @returns The full ID of the crosspost on the central promo subreddit, or undefined if no crosspost exists for the given post ID.
 */
export async function getCorrespondingPost (redis: RedisClient, postId: string): Promise<string | undefined> {
  const crosspostId = await redis.hGet(crosspostListKey, postId);
  return crosspostId;
};

/**
 * Checks if a post received from another subreddit has a corresponding crosspost on the central promo subreddit.
 *
 * This should only be used by an instance of the app running on the central promo subreddit.
 * @param redis - Instance of RedisClient.
 * @param postId - The full ID of the post on the originating subreddit (e.g., 't3_123456').
 * @returns A boolean indicating whether a crosspost exists for the given post ID.
 */
export async function hasCrosspost (redis: RedisClient, postId: string): Promise<boolean> {
  const crosspostId = await redis.hGet(crosspostListKey, postId);
  return !!crosspostId;
}
