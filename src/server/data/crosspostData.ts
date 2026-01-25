import type { RedditClient, RedisClient } from '../types';
import type { AppSettings } from '../settings';

export type PostActionType = 'remove' | 'approve' | 'delete';

export const modToPostActionMap: Record<string, PostActionType> = {
  removelink: 'remove',
  spamlink: 'remove',
  approvelink: 'approve',
};

export async function dispatchNewPost(
  reddit: RedditClient,
  appSettings: AppSettings,
  postId: string,
  goal: number
): Promise<void> {
  await reddit.updateWikiPage({
    subredditName: appSettings.promoSubreddit,
    page: '/post',
    content: `${postId}\n${goal}`,
    reason: `Post ${postId} with goal ${goal}`,
  });
}

export async function dispatchPostAction(
  reddit: RedditClient,
  appSettings: AppSettings,
  postId: string,
  action: PostActionType
): Promise<void> {
  await reddit.updateWikiPage({
    subredditName: appSettings.promoSubreddit,
    page: `/${action}`,
    content: postId,
    reason: `Dispatch ${action} for ${postId}`,
  });
}

export const wikiRevisionCutoffKey = 'revisionCutoff';
export const processedRevisionsKey = 'processedRevisions';
export const crosspostListKey = 'crosspostList';

export async function storeRevisionCutoff(
  redis: RedisClient,
  cutoff: Date
): Promise<void> {
  await redis.set(wikiRevisionCutoffKey, cutoff.getTime().toString());
}

export async function getRevisionCutoff(redis: RedisClient): Promise<Date> {
  const cutoff = await redis.get(wikiRevisionCutoffKey);
  if (!cutoff) {
    return new Date(0);
  }
  return new Date(parseInt(cutoff));
}

export async function storeProcessedRevision(
  redis: RedisClient,
  wikiRevisionId: string,
  postId: string
): Promise<void> {
  await redis.hSet(processedRevisionsKey, {
    [wikiRevisionId]: postId,
  });
}

export async function isProcessedRevision(
  redis: RedisClient,
  wikiRevisionId: string
): Promise<boolean> {
  const revision = await redis.hGet(processedRevisionsKey, wikiRevisionId);
  return !!revision;
}

export async function getAllProcessedRevisions(
  redis: RedisClient
): Promise<string[]> {
  const revisions = await redis.hGetAll(processedRevisionsKey);
  return Object.keys(revisions);
}

export async function storeCorrespondingPost(
  redis: RedisClient,
  postId: string,
  crosspostId: string
): Promise<void> {
  await redis.hSet(crosspostListKey, {
    [postId]: crosspostId,
  });
}

export async function getCorrespondingPost(
  redis: RedisClient,
  postId: string
): Promise<string | undefined> {
  const crosspostId = await redis.hGet(crosspostListKey, postId);
  return crosspostId;
}

export async function hasCrosspost(
  redis: RedisClient,
  postId: string
): Promise<boolean> {
  const crosspostId = await redis.hGet(crosspostListKey, postId);
  return !!crosspostId;
}
