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
export const processedRevisionsByTimeKey = 'processedRevisionsByTime';
export const crosspostListKey = 'crosspostList';
export const crosspostPendingByTimeKeyPrefix = 'crosspostPendingByTime';
export const crosspostPendingByRevisionKeyPrefix = 'crosspostPendingByRevision';

export type PendingCrosspostStatus =
  | 'queued_for_crosspost'
  | 'crosspost_retrying'
  | 'crosspost_reconciliation_pending'
  | 'crosspost_terminal_failed'
  | 'crosspost_succeeded';

export type PendingCrosspost = {
  revisionId: string;
  postId: LinkId;
  goal: number;
  firstSeenMs: number;
  nextAttemptMs: number;
  attemptCount: number;
  lastError: string | null;
  status: PendingCrosspostStatus;
  revisionDateMs?: number;
  createdCrosspostId?: LinkId;
  persistenceFailureReason?: string;
  reconciliationAttemptCount?: number;
};

const toNormalizedSubredditName = (value: string): string =>
  value.trim().replace(/^r\//i, '').toLowerCase();

export const getCrosspostPendingByTimeKey = (targetSubreddit: string): string =>
  `${crosspostPendingByTimeKeyPrefix}:${toNormalizedSubredditName(targetSubreddit)}`;

export const getCrosspostPendingByRevisionKey = (
  targetSubreddit: string
): string =>
  `${crosspostPendingByRevisionKeyPrefix}:${toNormalizedSubredditName(targetSubreddit)}`;

function isPendingCrosspostStatus(value: unknown): value is PendingCrosspostStatus {
  return (
    value === 'queued_for_crosspost' ||
    value === 'crosspost_retrying' ||
    value === 'crosspost_reconciliation_pending' ||
    value === 'crosspost_terminal_failed' ||
    value === 'crosspost_succeeded'
  );
}

function toPendingCrosspost(value: unknown): PendingCrosspost | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Partial<PendingCrosspost>;
  if (
    typeof candidate.revisionId !== 'string' ||
    typeof candidate.postId !== 'string' ||
    typeof candidate.goal !== 'number' ||
    !Number.isFinite(candidate.goal) ||
    typeof candidate.firstSeenMs !== 'number' ||
    !Number.isFinite(candidate.firstSeenMs) ||
    typeof candidate.nextAttemptMs !== 'number' ||
    !Number.isFinite(candidate.nextAttemptMs) ||
    typeof candidate.attemptCount !== 'number' ||
    !Number.isFinite(candidate.attemptCount) ||
    !isPendingCrosspostStatus(candidate.status)
  ) {
    return undefined;
  }

  const normalized: PendingCrosspost = {
    revisionId: candidate.revisionId,
    postId: candidate.postId as LinkId,
    goal: Math.floor(candidate.goal),
    firstSeenMs: Math.floor(candidate.firstSeenMs),
    nextAttemptMs: Math.floor(candidate.nextAttemptMs),
    attemptCount: Math.max(0, Math.floor(candidate.attemptCount)),
    lastError:
      typeof candidate.lastError === 'string' && candidate.lastError.length > 0
        ? candidate.lastError
        : null,
    status: candidate.status,
  };

  if (typeof candidate.revisionDateMs === 'number' && Number.isFinite(candidate.revisionDateMs)) {
    normalized.revisionDateMs = Math.floor(candidate.revisionDateMs);
  }
  if (
    typeof candidate.createdCrosspostId === 'string' &&
    /^t3_[\w\d]+$/.test(candidate.createdCrosspostId)
  ) {
    normalized.createdCrosspostId = candidate.createdCrosspostId as LinkId;
  }
  if (
    typeof candidate.persistenceFailureReason === 'string' &&
    candidate.persistenceFailureReason.length > 0
  ) {
    normalized.persistenceFailureReason = candidate.persistenceFailureReason;
  }
  if (
    typeof candidate.reconciliationAttemptCount === 'number' &&
    Number.isFinite(candidate.reconciliationAttemptCount)
  ) {
    normalized.reconciliationAttemptCount = Math.max(
      0,
      Math.floor(candidate.reconciliationAttemptCount)
    );
  }

  return normalized;
}

function serializePendingCrosspost(pending: PendingCrosspost): string {
  return JSON.stringify(pending);
}

export async function getPendingCrosspost(
  redis: RedisClient,
  targetSubreddit: string,
  revisionId: string
): Promise<PendingCrosspost | undefined> {
  const raw = await redis.hGet(
    getCrosspostPendingByRevisionKey(targetSubreddit),
    revisionId
  );
  if (!raw) {
    return undefined;
  }
  try {
    return toPendingCrosspost(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export async function upsertPendingCrosspost(
  redis: RedisClient,
  targetSubreddit: string,
  pending: PendingCrosspost
): Promise<void> {
  const byRevisionKey = getCrosspostPendingByRevisionKey(targetSubreddit);
  const byTimeKey = getCrosspostPendingByTimeKey(targetSubreddit);
  const existing = await getPendingCrosspost(
    redis,
    targetSubreddit,
    pending.revisionId
  );
  const merged: PendingCrosspost = existing
    ? {
        ...existing,
        ...pending,
        firstSeenMs: Math.min(existing.firstSeenMs, pending.firstSeenMs),
      }
    : pending;
  await redis.hSet(byRevisionKey, {
    [merged.revisionId]: serializePendingCrosspost(merged),
  });
  await redis.zAdd(byTimeKey, {
    member: merged.revisionId,
    score: merged.nextAttemptMs,
  });
}

export async function removePendingCrosspost(
  redis: RedisClient,
  targetSubreddit: string,
  revisionId: string
): Promise<void> {
  await redis.hDel(getCrosspostPendingByRevisionKey(targetSubreddit), [revisionId]);
  await redis.zRem(getCrosspostPendingByTimeKey(targetSubreddit), [revisionId]);
}

export async function listDuePendingCrossposts(
  redis: RedisClient,
  targetSubreddit: string,
  options: { nowMs?: number; limit?: number } = {}
): Promise<PendingCrosspost[]> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.floor(options.limit ?? 25));
  const index = await redis.zRange(getCrosspostPendingByTimeKey(targetSubreddit), 0, -1);
  const dueRevisionIds = index
    .filter((entry) => Number(entry.score) <= nowMs)
    .slice(0, limit)
    .map((entry) => entry.member);
  if (dueRevisionIds.length === 0) {
    return [];
  }
  const hash = await redis.hGetAll(getCrosspostPendingByRevisionKey(targetSubreddit));
  const due: PendingCrosspost[] = [];
  const staleIndexMembers: string[] = [];
  for (const revisionId of dueRevisionIds) {
    const raw = hash[revisionId];
    if (!raw) {
      staleIndexMembers.push(revisionId);
      continue;
    }
    try {
      const parsed = toPendingCrosspost(JSON.parse(raw));
      if (!parsed) {
        staleIndexMembers.push(revisionId);
        continue;
      }
      due.push(parsed);
    } catch {
      staleIndexMembers.push(revisionId);
    }
  }
  if (staleIndexMembers.length > 0) {
    await redis.zRem(getCrosspostPendingByTimeKey(targetSubreddit), staleIndexMembers);
  }
  return due;
}

export async function countPendingCrossposts(
  redis: RedisClient,
  targetSubreddit: string
): Promise<number> {
  const hash = await redis.hGetAll(getCrosspostPendingByRevisionKey(targetSubreddit));
  return Object.keys(hash).length;
}

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
  postId: string,
  processedAtMs: number = Date.now()
): Promise<void> {
  await redis.hSet(processedRevisionsKey, {
    [wikiRevisionId]: postId,
  });
  await redis.zAdd(processedRevisionsByTimeKey, {
    member: wikiRevisionId,
    score: processedAtMs,
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

export async function removeProcessedRevisions(
  redis: RedisClient,
  revisionIds: string[]
): Promise<void> {
  if (revisionIds.length === 0) {
    return;
  }
  await redis.hDel(processedRevisionsKey, revisionIds);
  await redis.zRem(processedRevisionsByTimeKey, revisionIds);
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

export async function removeCorrespondingPost(
  redis: RedisClient,
  postId: string
): Promise<void> {
  await redis.hDel(crosspostListKey, [postId]);
}

export async function hasCrosspost(
  redis: RedisClient,
  postId: string
): Promise<boolean> {
  const crosspostId = await redis.hGet(crosspostListKey, postId);
  return !!crosspostId;
}
