import type { AppSettings } from '../../shared/types/api';
import type { LinkId, RedditClient, RedisClient } from '../types';

export type PostActionType = 'remove' | 'approve' | 'delete';

export const crosspostWikiPages = {
  newPost: 'post',
  action: {
    remove: 'remove',
    approve: 'approve',
    delete: 'delete',
  } as Record<PostActionType, string>,
} as const;

export const modToPostActionMap: Record<string, PostActionType> = {
  removelink: 'remove',
  spamlink: 'remove',
  approvelink: 'approve',
};

const newPostReasonRegex = /^Post (t3_[\w\d]+) with goal (\d+)$/;

export function parseNewPostDispatchReason(
  reason: string
): { postId: LinkId; goal: number } | undefined {
  const match = reason.match(newPostReasonRegex);
  if (!match) {
    return undefined;
  }
  const [, postId, goalString] = match;
  if (!postId || !goalString) {
    return undefined;
  }
  const goal = parseInt(goalString, 10);
  if (Number.isNaN(goal)) {
    return undefined;
  }
  return { postId: postId as LinkId, goal };
}

export function parsePostActionDispatchReason(
  reason: string,
  expectedAction: PostActionType
): { postId: LinkId } | undefined {
  const actionRegex = new RegExp(
    `^Dispatch ${expectedAction} for (t3_[\\w\\d]+)$`
  );
  const match = reason.match(actionRegex);
  if (!match) {
    return undefined;
  }
  const [, postId] = match;
  if (!postId) {
    return undefined;
  }
  return { postId: postId as LinkId };
}

export async function dispatchNewPost(
  reddit: RedditClient,
  appSettings: AppSettings,
  postId: string,
  goal: number
): Promise<void> {
  const page = crosspostWikiPages.newPost;
  const reason = `Post ${postId} with goal ${goal}`;
  console.info(
    `[crosspost] dispatch new post: subreddit=${appSettings.promoSubreddit} page=${page} postId=${postId} goal=${goal}`
  );
  await reddit.updateWikiPage({
    subredditName: appSettings.promoSubreddit,
    page,
    content: `${postId}\n${goal}`,
    reason,
  });
}

export async function dispatchPostAction(
  reddit: RedditClient,
  appSettings: AppSettings,
  postId: string,
  action: PostActionType
): Promise<void> {
  const page = crosspostWikiPages.action[action];
  const reason = `Dispatch ${action} for ${postId}`;
  console.info(
    `[crosspost] dispatch action: subreddit=${appSettings.promoSubreddit} page=${page} action=${action} postId=${postId}`
  );
  await reddit.updateWikiPage({
    subredditName: appSettings.promoSubreddit,
    page,
    content: postId,
    reason,
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
