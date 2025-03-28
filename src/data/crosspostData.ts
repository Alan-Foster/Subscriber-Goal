import {RedditAPIClient} from '@devvit/public-api';

import {AppSettings} from '../settings.js';

export type PostActionType = 'remove' | 'approve' | 'delete';

export const modToPostActionMap: Record<string, PostActionType> = {
  removelink: 'remove',
  spamlink: 'remove',
  approvelink: 'approve',
};

export async function dispatchNewPost (reddit: RedditAPIClient, appSettings: AppSettings, postId: string, goal: number): Promise<void> {
  await reddit.updateWikiPage({subredditName: appSettings.promoSubreddit, page: '/post', content: `${postId}\n${goal}`, reason: `Post ${postId} with goal ${goal}`});
}

export async function dispatchPostAction (reddit: RedditAPIClient, appSettings: AppSettings, postId: string, action: PostActionType): Promise<void> {
  await reddit.updateWikiPage({subredditName: appSettings.promoSubreddit, page: `/${action}`, content: postId, reason: `Dispatch ${action} for ${postId}`}); ;
}
