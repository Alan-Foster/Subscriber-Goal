import { reddit, redis, context } from '@devvit/web/server';
import type { AppSettings } from '../../shared/types/api';
import { getAppSettings } from '../settings';
import {
  type PendingCrosspost,
  countPendingCrossposts,
  crosspostListKey,
  crosspostWikiPages,
  dispatchPostAction,
  getPendingCrosspost,
  getCrosspostPendingByRevisionKey,
  getCrosspostPendingByTimeKey,
  getCorrespondingPost,
  hasCrosspost,
  isProcessedRevision,
  listDuePendingCrossposts,
  processedRevisionsByTimeKey,
  processedRevisionsKey,
  modToPostActionMap,
  parseNewPostDispatchReason,
  parsePostActionDispatchReason,
  removePendingCrosspost,
  removeCorrespondingPost,
  removeProcessedRevisions,
  storeProcessedRevision,
  upsertPendingCrosspost,
} from '../data/crosspostData';
import { getTrackedPosts } from '../data/updaterData';
import { safeGetWikiPageRevisions } from '../utils/redditUtils';
import { logCrosspostEvent, toErrorMessage } from '../utils/crosspostLogs';
import { isLinkId, type LinkId, type RedisClient } from '../types';

export type ModActionEvent = {
  action?: string;
  targetPost?: {
    id: string;
    authorId?: string;
    subredditId?: string;
    nsfw?: boolean;
    subredditName?: string;
  };
  moderator?: {
    name?: string;
  };
};

type NewPostEvent = {
  postId: LinkId;
  revisionId: string;
  goal: number;
  revisionDateMs?: number;
};

type PostActionEvent = {
  postId: LinkId;
  revisionId: string;
  action: 'remove' | 'approve' | 'delete';
};

export type CrosspostIngestionStatus = 'success' | 'partial' | 'failed';

export type CrosspostIngestionSummary = {
  status: CrosspostIngestionStatus;
  revisionsFetched: number;
  newPostsSeen: number;
  crosspostsCreated: number;
  crosspostsSkipped: number;
  crosspostsFailed: number;
  actionsMirrored: number;
  actionsFailed: number;
  crosspostsCreatedThisRun: number;
  crosspostsBlockedByRunCap: number;
  crosspostsBlockedByHourlyCap: number;
  crosspostPersistenceFailedAfterCreate: number;
  crosspostsSkippedBySourceCooldown: number;
  crosspostsSkippedByInFlight: number;
  crosspostsSkippedByExistingDetection: number;
  errorMessage?: string;
};

const crosspostRetryDegradedCountKey = 'crosspostRetryDegradedCount';
const crosspostRetryDegradedThreshold = 3;
export const crosspostBookkeepingCleanupLastRunKey =
  'crosspostBookkeepingCleanupLastRun';
const processedRevisionRetentionMs = 30 * 24 * 60 * 60 * 1000;
const processedRevisionMaxEntries = 10_000;
const crosspostCleanupMinIntervalMs = 6 * 60 * 60 * 1000;
const crosspostIngestionLockKeyPrefix = 'crosspostIngestionLock';
const crosspostIngestionLockTtlMs = 60 * 1000;
const crosspostHourlyCreationHistoryKeyPrefix = 'crosspostHourlyCreationHistory';
const crosspostHourlyWindowMs = 60 * 60 * 1000;
const crosspostSourceCreateCooldownKeyPrefix = 'crosspostSourceCreateCooldown';
const crosspostSourceCreateCooldownTtlMs = 60 * 60 * 1000;
const crosspostTerminalRevisionKeyPrefix = 'crosspostTerminalRevision';
const crosspostTerminalRevisionTtlMs = 30 * 24 * 60 * 60 * 1000;
const crosspostCreateInFlightKeyPrefix = 'crosspostCreateInFlight';
const crosspostCreateInFlightTtlMs = 90 * 1000;
const crosspostTargetDuplicateScanLimit = 25;
const crosspostSchedulerDaisyChainMaxPasses = 3;

type CrosspostBookkeepingCleanupOptions = {
  retentionMs?: number;
  maxEntries?: number;
  minIntervalMs?: number;
  nowMs?: number;
};

type RedisLockClient = Pick<RedisClient, 'get' | 'set' | 'del'>;

type RedisFinalizeTransaction = {
  multi(): Promise<void>;
  set(
    key: string,
    value: string,
    options?: { expiration?: Date; nx?: boolean }
  ): Promise<unknown>;
  hSet(key: string, fields: Record<string, string>): Promise<unknown>;
  hDel(key: string, fields: string[]): Promise<unknown>;
  zRem(key: string, members: string[]): Promise<unknown>;
  exec(): Promise<unknown>;
};

type RedisTransactionCapable = RedisClient & {
  watch: (...keys: string[]) => Promise<RedisFinalizeTransaction>;
};

function emptySummary(): CrosspostIngestionSummary {
  return {
    status: 'success',
    revisionsFetched: 0,
    newPostsSeen: 0,
    crosspostsCreated: 0,
    crosspostsSkipped: 0,
    crosspostsFailed: 0,
    actionsMirrored: 0,
    actionsFailed: 0,
    crosspostsCreatedThisRun: 0,
    crosspostsBlockedByRunCap: 0,
    crosspostsBlockedByHourlyCap: 0,
    crosspostPersistenceFailedAfterCreate: 0,
    crosspostsSkippedBySourceCooldown: 0,
    crosspostsSkippedByInFlight: 0,
    crosspostsSkippedByExistingDetection: 0,
  };
}

const withErrorMessage = (errorMessage?: string): { errorMessage?: string } =>
  errorMessage ? { errorMessage } : {};

const isPermanentCrosspostError = (errorMessage: string): boolean =>
  /(OVER18_SUBREDDIT_CROSSPOST|SUBREDDIT_NOEXIST|INVALID_SUBREDDIT|FORBIDDEN|NOT_ALLOWED|INVALID_CROSSPOST_THING|root_post_id|link that isn't working|is private|must be a moderator|doesn't allow crossposts|does not allow crossposts)/i.test(
    errorMessage
  );

export const isMissingSourcePostError = (errorMessage: string): boolean =>
  /(no post\s+t3_|not[\s-]?found|does not exist|deleted|no longer exists)/i.test(
    errorMessage
  );

const isPermanentMirrorError = (errorMessage: string): boolean =>
  /only allowed inside (the )?current subreddit/i.test(errorMessage);

const toNormalizedSubredditName = (value: string): string =>
  value.trim().replace(/^r\//i, '').toLowerCase();

const getCrosspostAuthoritySubreddit = (appSettings: AppSettings): string =>
  toNormalizedSubredditName(
    appSettings.crosspostAuthoritySubreddit || appSettings.promoSubreddit
  );

const getCrosspostMaxSourcePostAgeMs = (appSettings: AppSettings): number => {
  const minutes =
    Number.isFinite(appSettings.crosspostMaxSourcePostAgeMinutes) &&
    appSettings.crosspostMaxSourcePostAgeMinutes > 0
      ? Math.floor(appSettings.crosspostMaxSourcePostAgeMinutes)
      : 10;
  return minutes * 60 * 1000;
};

const getCrosspostMaxRevisionAgeMs = (appSettings: AppSettings): number => {
  const minutes =
    Number.isFinite(appSettings.crosspostMaxRevisionAgeMinutes) &&
    appSettings.crosspostMaxRevisionAgeMinutes > 0
      ? Math.floor(appSettings.crosspostMaxRevisionAgeMinutes)
      : 10;
  return minutes * 60 * 1000;
};

const getMaxCrosspostsPerRun = (appSettings: AppSettings): number =>
  Number.isFinite(appSettings.maxCrosspostsPerRun) &&
  appSettings.maxCrosspostsPerRun > 0
    ? Math.floor(appSettings.maxCrosspostsPerRun)
    : 5;

const getMaxCrosspostsPerHour = (appSettings: AppSettings): number =>
  Number.isFinite(appSettings.maxCrosspostsPerHour) &&
  appSettings.maxCrosspostsPerHour > 0
    ? Math.floor(appSettings.maxCrosspostsPerHour)
    : 30;

const getCrosspostRetryWindowMs = (appSettings: AppSettings): number => {
  const minutes =
    Number.isFinite(appSettings.crosspostRetryWindowMinutes) &&
    appSettings.crosspostRetryWindowMinutes > 0
      ? Math.floor(appSettings.crosspostRetryWindowMinutes)
      : 1440;
  return minutes * 60 * 1000;
};

const getCrosspostRetryBaseDelayMs = (appSettings: AppSettings): number => {
  const seconds =
    Number.isFinite(appSettings.crosspostRetryBaseDelaySeconds) &&
    appSettings.crosspostRetryBaseDelaySeconds > 0
      ? Math.floor(appSettings.crosspostRetryBaseDelaySeconds)
      : 60;
  return seconds * 1000;
};

const getCrosspostRetryMaxDelayMs = (appSettings: AppSettings): number => {
  const minutes =
    Number.isFinite(appSettings.crosspostRetryMaxDelayMinutes) &&
    appSettings.crosspostRetryMaxDelayMinutes > 0
      ? Math.floor(appSettings.crosspostRetryMaxDelayMinutes)
      : 30;
  return minutes * 60 * 1000;
};

const getCrosspostPendingBatchSize = (appSettings: AppSettings): number =>
  Number.isFinite(appSettings.crosspostPendingBatchSize) &&
  appSettings.crosspostPendingBatchSize > 0
    ? Math.floor(appSettings.crosspostPendingBatchSize)
    : 25;

const getPostCreatedAtMs = (post: {
  createdAt?: Date | string | number;
}): number => {
  const rawCreatedAt = post.createdAt;
  if (rawCreatedAt instanceof Date) {
    return rawCreatedAt.getTime();
  }
  if (typeof rawCreatedAt === 'number') {
    // Devvit may return timestamps in either seconds or milliseconds.
    return rawCreatedAt < 1_000_000_000_000 ? rawCreatedAt * 1000 : rawCreatedAt;
  }
  if (typeof rawCreatedAt === 'string') {
    const parsed = Date.parse(rawCreatedAt);
    return Number.isNaN(parsed) ? NaN : parsed;
  }
  return NaN;
};

const getNextRetryDelayMs = (
  attemptCount: number,
  baseDelayMs: number,
  maxDelayMs: number
): number => {
  const exponentialDelay = baseDelayMs * 2 ** Math.max(0, attemptCount);
  return Math.min(exponentialDelay, maxDelayMs);
};

const isRetryWindowExpired = (
  pending: PendingCrosspost,
  retryWindowMs: number,
  nowMs: number
): boolean => nowMs - pending.firstSeenMs >= retryWindowMs;

async function finalizeCrosspostPersistenceAtomic(params: {
  redisClient: RedisClient;
  targetSubreddit: string;
  sourcePostId: LinkId;
  crosspostId: LinkId;
  revisionId: string;
}): Promise<void> {
  const {
    redisClient,
    targetSubreddit,
    sourcePostId,
    crosspostId,
    revisionId,
  } = params;
  const pendingRevisionKey = getCrosspostPendingByRevisionKey(targetSubreddit);
  const pendingTimeKey = getCrosspostPendingByTimeKey(targetSubreddit);
  const terminalKey = getTerminalRevisionKey(revisionId);

  const transactionRedis = redisClient as unknown as RedisTransactionCapable;
  if (typeof transactionRedis.watch !== 'function') {
    throw new Error('redis_watch_not_supported');
  }
  const tx = await transactionRedis.watch(
    terminalKey,
    crosspostListKey,
    pendingRevisionKey,
    pendingTimeKey
  );
  await tx.multi();
  await tx.set(terminalKey, '1', {
    expiration: new Date(Date.now() + crosspostTerminalRevisionTtlMs),
  });
  await tx.hSet(crosspostListKey, {
    [sourcePostId]: crosspostId,
  });
  await tx.hDel(pendingRevisionKey, [revisionId]);
  await tx.zRem(pendingTimeKey, [revisionId]);
  await tx.exec();
}

async function acquireCrosspostIngestionLock(
  redisClient: RedisLockClient,
  lockKey: string
): Promise<{ acquired: boolean; lockToken: string; lockKey: string }> {
  const lockToken = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const expiration = new Date(Date.now() + crosspostIngestionLockTtlMs);
  await redisClient.set(lockKey, lockToken, {
    nx: true,
    expiration,
  });
  const currentToken = await redisClient.get(lockKey);
  return {
    acquired: currentToken === lockToken,
    lockToken,
    lockKey,
  };
}

async function releaseCrosspostIngestionLock(
  redisClient: RedisLockClient,
  lockKey: string,
  lockToken: string
): Promise<void> {
  const currentToken = await redisClient.get(lockKey);
  if (currentToken === lockToken) {
    await redisClient.del(lockKey);
  }
}

const getSourceCreateCooldownKey = (sourcePostId: LinkId): string =>
  `${crosspostSourceCreateCooldownKeyPrefix}:${sourcePostId}`;

async function hasSourceCreateCooldown(
  redisClient: Pick<RedisClient, 'get'>,
  sourcePostId: LinkId
): Promise<boolean> {
  const value = await redisClient.get(getSourceCreateCooldownKey(sourcePostId));
  return value === '1';
}

async function setSourceCreateCooldown(
  redisClient: Pick<RedisClient, 'set'>,
  sourcePostId: LinkId
): Promise<void> {
  await redisClient.set(getSourceCreateCooldownKey(sourcePostId), '1', {
    expiration: new Date(Date.now() + crosspostSourceCreateCooldownTtlMs),
  });
}

const getTerminalRevisionKey = (revisionId: string): string =>
  `${crosspostTerminalRevisionKeyPrefix}:${revisionId}`;

async function isTerminalRevisionMarked(
  redisClient: Pick<RedisClient, 'get'>,
  revisionId: string
): Promise<boolean> {
  const value = await redisClient.get(getTerminalRevisionKey(revisionId));
  return value === '1';
}

const getCrosspostCreateInFlightKey = (sourcePostId: LinkId): string =>
  `${crosspostCreateInFlightKeyPrefix}:${sourcePostId}`;

async function acquireSourceCreateInFlightLock(
  redisClient: RedisLockClient,
  sourcePostId: LinkId
): Promise<{ acquired: boolean; lockToken: string; lockKey: string }> {
  const lockKey = getCrosspostCreateInFlightKey(sourcePostId);
  const lockToken = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  await redisClient.set(lockKey, lockToken, {
    nx: true,
    expiration: new Date(Date.now() + crosspostCreateInFlightTtlMs),
  });
  const currentToken = await redisClient.get(lockKey);
  return {
    acquired: currentToken === lockToken,
    lockToken,
    lockKey,
  };
}

async function releaseSourceCreateInFlightLock(
  redisClient: RedisLockClient,
  lockKey: string,
  lockToken: string
): Promise<void> {
  const currentToken = await redisClient.get(lockKey);
  if (currentToken === lockToken) {
    await redisClient.del(lockKey);
  }
}

async function findExistingTargetCrosspost(
  sourcePostId: LinkId,
  targetSubreddit: string
): Promise<LinkId | undefined> {
  try {
    const sourceBase36 = sourcePostId.slice(3).toLowerCase();
    const posts = await reddit
      .getNewPosts({
        subredditName: targetSubreddit,
        limit: crosspostTargetDuplicateScanLimit,
      })
      .get(crosspostTargetDuplicateScanLimit);

    for (const post of posts) {
      const normalizedUrl = (post.url ?? '').toLowerCase();
      const haystack = `${normalizedUrl}\n${post.title ?? ''}\n${post.body ?? ''}`.toLowerCase();
      const urlReferencesSource = normalizedUrl.includes(`/comments/${sourceBase36}/`);
      if (
        (haystack.includes(sourcePostId.toLowerCase()) || urlReferencesSource) &&
        isLinkId(post.id)
      ) {
        return post.id;
      }
    }
  } catch (error) {
    console.warn(
      `[crosspost] existing-target detection failed; continuing: sourcePostId=${sourcePostId} targetSubreddit=${targetSubreddit} error=${toErrorMessage(
        error
      )}`
    );
  }
  return undefined;
}

async function getCurrentHourlyCrosspostCount(
  redisClient: Pick<RedisClient, 'zRange' | 'zRem'>,
  historyKey: string,
  nowMs: number
): Promise<number> {
  const entries = await redisClient.zRange(historyKey, 0, -1);
  const cutoffMs = nowMs - crosspostHourlyWindowMs;
  const staleMembers = entries
    .filter((entry) => Number(entry.score) < cutoffMs)
    .map((entry) => entry.member);
  if (staleMembers.length > 0) {
    await redisClient.zRem(historyKey, staleMembers);
  }
  return entries.length - staleMembers.length;
}

async function recordCrosspostCreation(
  redisClient: Pick<RedisClient, 'zAdd'>,
  historyKey: string,
  revisionId: string,
  nowMs: number
): Promise<void> {
  const member = `${nowMs}:${revisionId}:${Math.random().toString(36).slice(2)}`;
  await redisClient.zAdd(historyKey, { member, score: nowMs });
}

export async function cleanupCrosspostBookkeeping(
  redisClient: RedisClient,
  options: CrosspostBookkeepingCleanupOptions = {}
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const retentionMs = options.retentionMs ?? processedRevisionRetentionMs;
  const maxEntries = options.maxEntries ?? processedRevisionMaxEntries;
  const minIntervalMs = options.minIntervalMs ?? crosspostCleanupMinIntervalMs;
  const cutoffMs = nowMs - retentionMs;

  const lastRunRaw = await redisClient.get(crosspostBookkeepingCleanupLastRunKey);
  const lastRunMs = lastRunRaw ? Number.parseInt(lastRunRaw, 10) : 0;
  if (!Number.isNaN(lastRunMs) && lastRunMs > 0 && nowMs - lastRunMs < minIntervalMs) {
    return;
  }
  const revisionIndexEntries = await redisClient.zRange(
    processedRevisionsByTimeKey,
    0,
    -1
  );
  const indexedRevisions = revisionIndexEntries
    .map((entry) => ({ member: entry.member, score: Number(entry.score) }))
    .filter((entry) => entry.member && !Number.isNaN(entry.score))
    .sort((a, b) => a.score - b.score);
  const processedRevisionHash = await redisClient.hGetAll(processedRevisionsKey);
  const hashRevisionIds = new Set(Object.keys(processedRevisionHash));
  const indexedRevisionIds = new Set(indexedRevisions.map((entry) => entry.member));
  const processedRevisionIdsToRemove = new Set<string>();
  const processedRevisionIdsToIndex: string[] = [];

  for (const indexedRevisionId of indexedRevisionIds) {
    if (!hashRevisionIds.has(indexedRevisionId)) {
      processedRevisionIdsToRemove.add(indexedRevisionId);
    }
  }

  for (const hashRevisionId of hashRevisionIds) {
    if (!indexedRevisionIds.has(hashRevisionId)) {
      processedRevisionIdsToIndex.push(hashRevisionId);
    }
  }

  if (processedRevisionIdsToIndex.length > 0) {
    const toIndex = processedRevisionIdsToIndex.map((revisionId) => ({
      member: revisionId,
      score: nowMs,
    }));
    await redisClient.zAdd(processedRevisionsByTimeKey, ...toIndex);
  }

  const effectiveIndexedRevisions = [
    ...indexedRevisions.filter(
      (entry) => !processedRevisionIdsToRemove.has(entry.member)
    ),
    ...processedRevisionIdsToIndex.map((revisionId) => ({
      member: revisionId,
      score: nowMs,
    })),
  ].sort((a, b) => a.score - b.score);

  for (const entry of effectiveIndexedRevisions) {
    if (entry.score < cutoffMs) {
      processedRevisionIdsToRemove.add(entry.member);
    }
  }

  const retainedIndexedRevisions = effectiveIndexedRevisions.filter(
    (entry) => !processedRevisionIdsToRemove.has(entry.member)
  );
  const excessCount = retainedIndexedRevisions.length - maxEntries;
  if (excessCount > 0) {
    for (let i = 0; i < excessCount; i += 1) {
      const entry = retainedIndexedRevisions[i];
      if (entry) {
        processedRevisionIdsToRemove.add(entry.member);
      }
    }
  }

  if (processedRevisionIdsToRemove.size > 0) {
    await removeProcessedRevisions(redisClient, [
      ...processedRevisionIdsToRemove,
    ]);
  }

  const trackedPosts = new Set(await getTrackedPosts(redisClient));
  const sourceToCrosspostMappings = await redisClient.hGetAll(crosspostListKey);
  const staleSourcePostIds: string[] = [];

  for (const [sourcePostId, mappedCrosspostId] of Object.entries(
    sourceToCrosspostMappings
  )) {
    const staleSourcePost =
      !isLinkId(sourcePostId) || !trackedPosts.has(sourcePostId);
    const staleMappedCrosspost =
      typeof mappedCrosspostId !== 'string' || !isLinkId(mappedCrosspostId);
    if (staleSourcePost || staleMappedCrosspost) {
      staleSourcePostIds.push(sourcePostId);
    }
  }

  for (const sourcePostId of staleSourcePostIds) {
    await removeCorrespondingPost(redisClient, sourcePostId);
  }

  await redisClient.set(crosspostBookkeepingCleanupLastRunKey, nowMs.toString());
}

async function getNewPosts(
  appSettings: AppSettings
): Promise<{
  events: NewPostEvent[];
  revisionsFetched: number;
  ok: boolean;
  errorMessage?: string;
}> {
  const result = await safeGetWikiPageRevisions(
    reddit,
    appSettings.promoSubreddit,
    crosspostWikiPages.newPost
  );
  if (!result.ok) {
    return {
      events: [],
      revisionsFetched: 0,
      ok: false,
      ...withErrorMessage(result.errorMessage),
    };
  }

  const newPosts: Set<NewPostEvent> = new Set();
  for (const revision of result.revisions) {
    if (
      (await isProcessedRevision(redis, revision.id)) ||
      (await isTerminalRevisionMarked(redis, revision.id))
    ) {
      continue;
    }

    const parsedReason = parseNewPostDispatchReason(revision.reason);
    if (!parsedReason) {
      console.warn(
        `[crosspost] skipping revision with unexpected new-post reason: revisionId=${revision.id} reason=${revision.reason}`
      );
      continue;
    }
    const { postId, goal } = parsedReason;
    if (!postId || Number.isNaN(goal) || !isLinkId(postId)) {
      console.warn(
        `[crosspost] skipping new-post revision with invalid payload: revisionId=${revision.id} postId=${postId} goal=${goal}`
      );
      continue;
    }

    const event: NewPostEvent = {
      postId,
      revisionId: revision.id,
      goal,
      ...(typeof revision.dateMs === 'number'
        ? { revisionDateMs: revision.dateMs }
        : {}),
    };
    newPosts.add(event);
  }

  return {
    events: Array.from(newPosts),
    revisionsFetched: result.revisions.length,
    ok: true,
  };
}

async function getNewPostActions(
  appSettings: AppSettings,
  actionType: 'remove' | 'approve' | 'delete'
): Promise<{
  events: PostActionEvent[];
  revisionsFetched: number;
  ok: boolean;
  errorMessage?: string;
}> {
  const result = await safeGetWikiPageRevisions(
    reddit,
    appSettings.promoSubreddit,
    crosspostWikiPages.action[actionType]
  );
  if (!result.ok) {
    return {
      events: [],
      revisionsFetched: 0,
      ok: false,
      ...withErrorMessage(result.errorMessage),
    };
  }

  const newPosts: Set<PostActionEvent> = new Set();
  for (const revision of result.revisions) {
    if (await isProcessedRevision(redis, revision.id)) {
      continue;
    }

    const parsedReason = parsePostActionDispatchReason(
      revision.reason,
      actionType
    );
    if (!parsedReason) {
      console.warn(
        `[crosspost] skipping revision with unexpected action reason: revisionId=${revision.id} action=${actionType} reason=${revision.reason}`
      );
      continue;
    }
    const { postId } = parsedReason;
    if (!postId || !isLinkId(postId)) {
      console.warn(
        `[crosspost] skipping action revision with invalid post id: revisionId=${revision.id} action=${actionType} postId=${postId}`
      );
      continue;
    }

    newPosts.add({
      postId,
      revisionId: revision.id,
      action: actionType,
    });
  }

  return {
    events: Array.from(newPosts),
    revisionsFetched: result.revisions.length,
    ok: true,
  };
}

async function updateFromWikis(
  appSettings: AppSettings,
  options: {
    sourcePostFreshnessWindowMs: number;
    revisionFreshnessWindowMs: number;
    maxCrosspostsPerRun: number;
    maxCrosspostsPerHour: number;
  }
): Promise<CrosspostIngestionSummary> {
  const {
    sourcePostFreshnessWindowMs,
    revisionFreshnessWindowMs,
    maxCrosspostsPerRun,
    maxCrosspostsPerHour,
  } = options;
  const summary = emptySummary();
  const fetchErrors: string[] = [];
  let fetchFailureCount = 0;
  let fetchSuccessCount = 0;
  const nowMs = Date.now();
  const hourlyHistoryKey = `${crosspostHourlyCreationHistoryKeyPrefix}:${toNormalizedSubredditName(
    appSettings.promoSubreddit
  )}`;
  let hourlyCreatedCount = await getCurrentHourlyCrosspostCount(
    redis,
    hourlyHistoryKey,
    nowMs
  );
  const retryWindowMs = getCrosspostRetryWindowMs(appSettings);
  const retryBaseDelayMs = getCrosspostRetryBaseDelayMs(appSettings);
  const retryMaxDelayMs = getCrosspostRetryMaxDelayMs(appSettings);
  const pendingBatchSize = getCrosspostPendingBatchSize(appSettings);

  const newPostBatch = await getNewPosts(appSettings);
  summary.revisionsFetched += newPostBatch.revisionsFetched;
  if (newPostBatch.ok) {
    fetchSuccessCount += 1;
  } else {
    fetchFailureCount += 1;
    if (newPostBatch.errorMessage) {
      fetchErrors.push(`post:${newPostBatch.errorMessage}`);
    }
  }

  const newPostIds = newPostBatch.events;
  summary.newPostsSeen = newPostIds.length;
  for (const newPost of newPostIds) {
    try {
      const existing = await getPendingCrosspost(
        redis,
        appSettings.promoSubreddit,
        newPost.revisionId
      );
      await upsertPendingCrosspost(redis, appSettings.promoSubreddit, {
        revisionId: newPost.revisionId,
        postId: newPost.postId,
        goal: newPost.goal,
        firstSeenMs: existing?.firstSeenMs ?? nowMs,
        nextAttemptMs: existing?.nextAttemptMs ?? nowMs,
        attemptCount: existing?.attemptCount ?? 0,
        lastError: existing?.lastError ?? null,
        status: existing?.status ?? 'queued_for_crosspost',
        ...(typeof newPost.revisionDateMs === 'number'
          ? { revisionDateMs: newPost.revisionDateMs }
          : {}),
      });
      await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
      logCrosspostEvent({
        event: 'crosspost_attempt_started',
        sourcePostId: newPost.postId,
        targetSubreddit: appSettings.promoSubreddit,
        reason: 'queued_for_crosspost',
        revisionId: newPost.revisionId,
      });
    } catch (queueError) {
      summary.crosspostsFailed += 1;
      logCrosspostEvent(
        {
          event: 'crosspost_attempt_failed',
          sourcePostId: newPost.postId,
          targetSubreddit: appSettings.promoSubreddit,
          reason: 'queue_enqueue_failed',
          revisionId: newPost.revisionId,
          errorMessage: toErrorMessage(queueError),
        },
        'error'
      );
    }
  }

  const duePendingCrossposts = await listDuePendingCrossposts(
    redis,
    appSettings.promoSubreddit,
    { nowMs, limit: pendingBatchSize }
  );

  const scheduleRetry = async (
    pending: PendingCrosspost,
    reason: string,
    errorMessage?: string,
    options?: {
      createdCrosspostId?: LinkId;
      persistenceFailureReason?: string;
      forceReconciliation?: boolean;
      incrementReconciliation?: boolean;
    }
  ): Promise<void> => {
    const nextReconciliationAttemptCount =
      (pending.reconciliationAttemptCount ?? 0) +
      (options?.incrementReconciliation ? 1 : 0);
    const nextCreatedCrosspostId =
      options?.createdCrosspostId ?? pending.createdCrosspostId;
    if (isRetryWindowExpired(pending, retryWindowMs, nowMs)) {
      await removePendingCrosspost(redis, appSettings.promoSubreddit, pending.revisionId);
      summary.crosspostsSkipped += 1;
      logCrosspostEvent(
        {
          event: 'crosspost_attempt_skipped',
          sourcePostId: pending.postId,
          targetSubreddit: appSettings.promoSubreddit,
          reason: `${reason}_retry_window_expired`,
          revisionId: pending.revisionId,
          ...(nextCreatedCrosspostId
            ? { crosspostId: nextCreatedCrosspostId }
            : {}),
          ...(nextReconciliationAttemptCount > 0
            ? { reconciliationAttemptCount: nextReconciliationAttemptCount }
            : {}),
          ...(options?.persistenceFailureReason
            ? { persistenceFailureReason: options.persistenceFailureReason }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
        'warn'
      );
      console.warn(
        `[crosspost] crosspost_terminal_failed: revisionId=${pending.revisionId} postId=${pending.postId} reason=${reason}_retry_window_expired`
      );
      return;
    }

    const nextDelayMs = getNextRetryDelayMs(
      pending.attemptCount,
      retryBaseDelayMs,
      retryMaxDelayMs
    );
    await upsertPendingCrosspost(redis, appSettings.promoSubreddit, {
      ...pending,
      attemptCount: pending.attemptCount + 1,
      nextAttemptMs: nowMs + nextDelayMs,
      lastError: errorMessage ?? reason,
      status:
        options?.forceReconciliation || nextCreatedCrosspostId
          ? 'crosspost_reconciliation_pending'
          : 'crosspost_retrying',
      ...(nextCreatedCrosspostId
        ? { createdCrosspostId: nextCreatedCrosspostId }
        : {}),
      ...(options?.persistenceFailureReason
        ? { persistenceFailureReason: options.persistenceFailureReason }
        : pending.persistenceFailureReason
          ? { persistenceFailureReason: pending.persistenceFailureReason }
          : {}),
      ...(nextReconciliationAttemptCount > 0
        ? { reconciliationAttemptCount: nextReconciliationAttemptCount }
        : {}),
    });
    summary.crosspostsSkipped += 1;
    logCrosspostEvent(
      {
        event: 'crosspost_attempt_skipped',
        sourcePostId: pending.postId,
        targetSubreddit: appSettings.promoSubreddit,
        reason,
        revisionId: pending.revisionId,
        ...(nextCreatedCrosspostId
          ? { crosspostId: nextCreatedCrosspostId }
          : {}),
        ...(nextReconciliationAttemptCount > 0
          ? { reconciliationAttemptCount: nextReconciliationAttemptCount }
          : {}),
        ...(options?.persistenceFailureReason
          ? { persistenceFailureReason: options.persistenceFailureReason }
          : {}),
        ...(errorMessage ? { errorMessage } : {}),
      },
      'warn'
    );
    console.info(
      `[crosspost] crosspost_retrying: revisionId=${pending.revisionId} postId=${pending.postId} reason=${reason} attempt=${pending.attemptCount + 1} nextAttemptMs=${nowMs + nextDelayMs}`
    );
  };

  const markTerminalFailure = async (
    pending: PendingCrosspost,
    reason: string,
    errorMessage?: string
  ): Promise<void> => {
    await removePendingCrosspost(redis, appSettings.promoSubreddit, pending.revisionId);
    summary.crosspostsSkipped += 1;
    logCrosspostEvent(
      {
        event: 'crosspost_attempt_skipped',
        sourcePostId: pending.postId,
        targetSubreddit: appSettings.promoSubreddit,
        reason,
        revisionId: pending.revisionId,
        ...(pending.createdCrosspostId
          ? { crosspostId: pending.createdCrosspostId }
          : {}),
        ...(pending.reconciliationAttemptCount
          ? { reconciliationAttemptCount: pending.reconciliationAttemptCount }
          : {}),
        ...(pending.persistenceFailureReason
          ? { persistenceFailureReason: pending.persistenceFailureReason }
          : {}),
        ...(errorMessage ? { errorMessage } : {}),
      },
      'warn'
    );
    console.warn(
      `[crosspost] crosspost_terminal_failed: revisionId=${pending.revisionId} postId=${pending.postId} reason=${reason}`
    );
  };

  const reconciliationFirstPending = duePendingCrossposts.filter(
    (pending) =>
      pending.status === 'crosspost_reconciliation_pending' ||
      Boolean(pending.createdCrosspostId)
  );
  const normalPending = duePendingCrossposts.filter(
    (pending) =>
      pending.status !== 'crosspost_reconciliation_pending' &&
      !pending.createdCrosspostId
  );

  for (const pending of [...reconciliationFirstPending, ...normalPending]) {
    let sourceSubredditIsNsfw = false;
    try {
      const revisionDateMs = pending.revisionDateMs;
      if (typeof revisionDateMs !== 'number' || !Number.isFinite(revisionDateMs)) {
        await scheduleRetry(pending, 'revision_age_unknown');
        continue;
      }
      const revisionAgeMs = nowMs - revisionDateMs;
      if (revisionAgeMs > revisionFreshnessWindowMs) {
        await scheduleRetry(pending, 'revision_too_old');
        continue;
      }
      if (summary.crosspostsCreatedThisRun >= maxCrosspostsPerRun) {
        summary.crosspostsBlockedByRunCap += 1;
        await scheduleRetry(pending, 'crosspost_cap_per_run_reached');
        continue;
      }
      if (hourlyCreatedCount >= maxCrosspostsPerHour) {
        summary.crosspostsBlockedByHourlyCap += 1;
        await scheduleRetry(pending, 'crosspost_cap_hourly_reached');
        continue;
      }

      const post = await reddit.getPostById(pending.postId);
      if (!post) {
        await markTerminalFailure(pending, 'source_post_missing');
        continue;
      }
      const createdAtMs = getPostCreatedAtMs(post);
      if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
        await scheduleRetry(pending, 'source_post_age_unknown');
        continue;
      }
      const postAgeMs = Date.now() - createdAtMs;
      if (postAgeMs > sourcePostFreshnessWindowMs) {
        await scheduleRetry(pending, 'source_post_too_old');
        continue;
      }

      const sourceSubredditInfo = await reddit.getSubredditInfoById(post.subredditId);
      sourceSubredditIsNsfw = sourceSubredditInfo.isNsfw === true;
      if (sourceSubredditIsNsfw) {
        await markTerminalFailure(pending, 'source_subreddit_nsfw');
        continue;
      }
      if (await hasCrosspost(redis, pending.postId)) {
        await removePendingCrosspost(redis, appSettings.promoSubreddit, pending.revisionId);
        summary.crosspostsSkipped += 1;
        logCrosspostEvent({
          event: 'crosspost_attempt_skipped',
          sourcePostId: pending.postId,
          targetSubreddit: appSettings.promoSubreddit,
          reason: 'already_mapped',
          revisionId: pending.revisionId,
        });
        continue;
      }
      if (await hasSourceCreateCooldown(redis, pending.postId)) {
        summary.crosspostsSkippedBySourceCooldown += 1;
        await scheduleRetry(pending, 'source_post_recently_crossposted');
        continue;
      }
      const existingCrosspostId = await findExistingTargetCrosspost(
        pending.postId,
        appSettings.promoSubreddit
      );
      const reconciliationCrosspostId =
        pending.createdCrosspostId ?? existingCrosspostId;
      if (reconciliationCrosspostId) {
        logCrosspostEvent({
          event: 'crosspost_reconciliation_started',
          sourcePostId: pending.postId,
          targetSubreddit: appSettings.promoSubreddit,
          crosspostId: reconciliationCrosspostId,
          reason: pending.createdCrosspostId
            ? 'reconcile_from_saved_crosspost_id'
            : 'reconcile_from_existing_detection',
          revisionId: pending.revisionId,
          ...(pending.reconciliationAttemptCount
            ? { reconciliationAttemptCount: pending.reconciliationAttemptCount }
            : {}),
        });
        try {
          await finalizeCrosspostPersistenceAtomic({
            redisClient: redis,
            targetSubreddit: appSettings.promoSubreddit,
            sourcePostId: pending.postId,
            crosspostId: reconciliationCrosspostId,
            revisionId: pending.revisionId,
          });
          summary.crosspostsSkipped += 1;
          summary.crosspostsSkippedByExistingDetection += 1;
          logCrosspostEvent({
            event: 'crosspost_reconciliation_succeeded',
            sourcePostId: pending.postId,
            targetSubreddit: appSettings.promoSubreddit,
            crosspostId: reconciliationCrosspostId,
            reason: 'reconciliation_mapping_backfilled',
            revisionId: pending.revisionId,
            ...(pending.reconciliationAttemptCount
              ? { reconciliationAttemptCount: pending.reconciliationAttemptCount }
              : {}),
          });
          continue;
        } catch (reconcileError) {
          const reconcileErrorMessage = toErrorMessage(reconcileError);
          logCrosspostEvent(
            {
              event: 'crosspost_reconciliation_failed',
              sourcePostId: pending.postId,
              targetSubreddit: appSettings.promoSubreddit,
              crosspostId: reconciliationCrosspostId,
              reason: 'reconciliation_finalize_failed',
              revisionId: pending.revisionId,
              ...(pending.reconciliationAttemptCount
                ? { reconciliationAttemptCount: pending.reconciliationAttemptCount + 1 }
                : { reconciliationAttemptCount: 1 }),
              errorMessage: reconcileErrorMessage,
            },
            'warn'
          );
          await scheduleRetry(
            pending,
            'crosspost_reconciliation_failed',
            reconcileErrorMessage,
            {
              createdCrosspostId: reconciliationCrosspostId,
              forceReconciliation: true,
              incrementReconciliation: true,
            }
          );
          continue;
        }
      }

      const sourceCreateLock = await acquireSourceCreateInFlightLock(redis, pending.postId);
      if (!sourceCreateLock.acquired) {
        summary.crosspostsSkippedByInFlight += 1;
        await scheduleRetry(pending, 'source_create_inflight');
        continue;
      }
      logCrosspostEvent({
        event: 'crosspost_attempt_started',
        sourcePostId: pending.postId,
        targetSubreddit: appSettings.promoSubreddit,
        reason: 'dispatch_new_post',
        revisionId: pending.revisionId,
      });

      let crosspostId: string;
      try {
        const crosspost = await reddit.crosspost({
          subredditName: appSettings.promoSubreddit,
          title: `Visit r/${post.subredditName}, they are trying to reach ${pending.goal} subscribers!`,
          postId: post.id,
          nsfw: post.nsfw ?? sourceSubredditInfo.isNsfw,
        });
        crosspostId = crosspost.id;
      } catch (error) {
        logCrosspostEvent(
          {
            event: 'crosspost_attempt_failed',
            sourcePostId: pending.postId,
            targetSubreddit: appSettings.promoSubreddit,
            reason: 'dispatch_new_post',
            revisionId: pending.revisionId,
            errorMessage: toErrorMessage(error),
          },
          'error'
        );
        throw error;
      } finally {
        await releaseSourceCreateInFlightLock(
          redis,
          sourceCreateLock.lockKey,
          sourceCreateLock.lockToken
        );
      }
      logCrosspostEvent({
        event: 'crosspost_attempt_succeeded',
        sourcePostId: pending.postId,
        targetSubreddit: appSettings.promoSubreddit,
        crosspostId,
        reason: 'crosspost_succeeded',
        revisionId: pending.revisionId,
      });

      try {
        await setSourceCreateCooldown(redis, pending.postId);
      } catch (cooldownError) {
        console.warn(
          `[crosspost] failed to set source create cooldown: revisionId=${pending.revisionId} sourcePostId=${pending.postId} error=${toErrorMessage(
            cooldownError
          )}`
        );
      }

      try {
        await finalizeCrosspostPersistenceAtomic({
          redisClient: redis,
          targetSubreddit: appSettings.promoSubreddit,
          sourcePostId: pending.postId,
          crosspostId: crosspostId as LinkId,
          revisionId: pending.revisionId,
        });
        summary.crosspostsCreated += 1;
        summary.crosspostsCreatedThisRun += 1;
        hourlyCreatedCount += 1;
        await recordCrosspostCreation(
          redis,
          hourlyHistoryKey,
          pending.revisionId,
          Date.now()
        );
      } catch (finalizeError) {
        const finalizeErrorMessage = toErrorMessage(finalizeError);
        summary.crosspostPersistenceFailedAfterCreate += 1;
        logCrosspostEvent(
          {
            event: 'crosspost_finalize_transaction_failed',
            sourcePostId: pending.postId,
            targetSubreddit: appSettings.promoSubreddit,
            crosspostId,
            reason: 'crosspost_finalize_transaction_failed',
            revisionId: pending.revisionId,
            errorMessage: finalizeErrorMessage,
          },
          'error'
        );
        await scheduleRetry(
          pending,
          'crosspost_persistence_failed_after_create',
          finalizeErrorMessage,
          {
            createdCrosspostId: crosspostId as LinkId,
            persistenceFailureReason: 'crosspost_finalize_transaction_failed',
            forceReconciliation: true,
            incrementReconciliation: true,
          }
        );
        logCrosspostEvent(
          {
            event: 'crosspost_persistence_failed_after_create',
            sourcePostId: pending.postId,
            targetSubreddit: appSettings.promoSubreddit,
            crosspostId,
            reason: 'crosspost_persistence_failed_after_create',
            revisionId: pending.revisionId,
            errorMessage: finalizeErrorMessage,
          },
          'error'
        );
      }
    } catch (e) {
      const errorMessage = toErrorMessage(e);
      const permanentFailure = isPermanentCrosspostError(errorMessage);
      const missingSourcePost = isMissingSourcePostError(errorMessage);
      if (permanentFailure || sourceSubredditIsNsfw || missingSourcePost) {
        const terminalReason = sourceSubredditIsNsfw
          ? 'source_subreddit_nsfw'
          : missingSourcePost
            ? 'source_post_missing'
            : /INVALID_CROSSPOST_THING|root_post_id|link that isn't working/i.test(errorMessage)
              ? 'source_not_crosspostable'
              : 'target_policy_reject_or_denied';
        await markTerminalFailure(pending, terminalReason, errorMessage);
        continue;
      }

      summary.crosspostsFailed += 1;
      await scheduleRetry(pending, 'crosspost_attempt_failed', errorMessage);
    }
  }

  const actionBatches = await Promise.all([
    getNewPostActions(appSettings, 'remove'),
    getNewPostActions(appSettings, 'approve'),
    getNewPostActions(appSettings, 'delete'),
  ]);
  const postActions = actionBatches.flatMap((batch) => batch.events);
  for (const batch of actionBatches) {
    summary.revisionsFetched += batch.revisionsFetched;
    if (batch.ok) {
      fetchSuccessCount += 1;
    } else {
      fetchFailureCount += 1;
      if (batch.errorMessage) {
        fetchErrors.push(batch.errorMessage);
      }
    }
  }

  for (const postAction of postActions) {
    let terminal = false;
    let mirrored = false;
    try {
      const crosspostId = await getCorrespondingPost(redis, postAction.postId);
      if (!crosspostId) {
        summary.crosspostsSkipped += 1;
        logCrosspostEvent({
          event: 'crosspost_attempt_skipped',
          sourcePostId: postAction.postId,
          targetSubreddit: appSettings.promoSubreddit,
          reason: `action_${postAction.action}_missing_mapping`,
          revisionId: postAction.revisionId,
        });
        console.info(
          `[crosspost] no mapping found for action; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId}`
        );
        terminal = true;
        await storeProcessedRevision(redis, postAction.revisionId, postAction.postId);
        continue;
      }

      const expectedSubreddit = appSettings.promoSubreddit.toLowerCase();
      const getCrosspostOrSkip = async (resolvedCrosspostId: LinkId) => {
        const crosspost = await reddit.getPostById(resolvedCrosspostId);
        if (!crosspost) {
          summary.crosspostsSkipped += 1;
          logCrosspostEvent(
            {
              event: 'crosspost_attempt_skipped',
              sourcePostId: postAction.postId,
              targetSubreddit: appSettings.promoSubreddit,
              crosspostId: resolvedCrosspostId,
              reason: `action_${postAction.action}_target_missing`,
              revisionId: postAction.revisionId,
            },
            'warn'
          );
          console.warn(
            `[crosspost] missing target while mirroring action; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} crosspostId=${resolvedCrosspostId}`
          );
          await removeCorrespondingPost(redis, postAction.postId);
          terminal = true;
          return null;
        }

        if (crosspost.subredditName.toLowerCase() !== expectedSubreddit) {
          summary.crosspostsSkipped += 1;
          logCrosspostEvent(
            {
              event: 'crosspost_attempt_skipped',
              sourcePostId: postAction.postId,
              targetSubreddit: appSettings.promoSubreddit,
              crosspostId: resolvedCrosspostId,
              reason: `action_${postAction.action}_wrong_subreddit`,
              revisionId: postAction.revisionId,
            },
            'warn'
          );
          console.warn(
            `[crosspost] mapped target subreddit mismatch; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} crosspostId=${resolvedCrosspostId} expectedSubreddit=${appSettings.promoSubreddit} actualSubreddit=${crosspost.subredditName}`
          );
          await removeCorrespondingPost(redis, postAction.postId);
          terminal = true;
          return null;
        }

        return crosspost;
      };

      switch (postAction.action) {
        case 'remove': {
          if (!isLinkId(crosspostId)) {
            summary.crosspostsSkipped += 1;
            logCrosspostEvent(
              {
                event: 'crosspost_attempt_skipped',
                sourcePostId: postAction.postId,
                targetSubreddit: appSettings.promoSubreddit,
                crosspostId,
                reason: `action_${postAction.action}_invalid_target`,
                revisionId: postAction.revisionId,
              },
              'warn'
            );
            console.warn(
              `[crosspost] mapped id is not a valid post id; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} mappedId=${crosspostId}`
            );
            await removeCorrespondingPost(redis, postAction.postId);
            terminal = true;
            break;
          }
          const crosspost = await getCrosspostOrSkip(crosspostId);
          if (!crosspost) {
            break;
          }
          await crosspost.remove(false);
          mirrored = true;
          break;
        }
        case 'approve': {
          if (!isLinkId(crosspostId)) {
            summary.crosspostsSkipped += 1;
            logCrosspostEvent(
              {
                event: 'crosspost_attempt_skipped',
                sourcePostId: postAction.postId,
                targetSubreddit: appSettings.promoSubreddit,
                crosspostId,
                reason: `action_${postAction.action}_invalid_target`,
                revisionId: postAction.revisionId,
              },
              'warn'
            );
            console.warn(
              `[crosspost] mapped id is not a valid post id; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} mappedId=${crosspostId}`
            );
            await removeCorrespondingPost(redis, postAction.postId);
            terminal = true;
            break;
          }
          const crosspost = await getCrosspostOrSkip(crosspostId);
          if (!crosspost) {
            break;
          }
          await crosspost.approve();
          mirrored = true;
          break;
        }
        case 'delete': {
          if (!isLinkId(crosspostId)) {
            summary.crosspostsSkipped += 1;
            logCrosspostEvent(
              {
                event: 'crosspost_attempt_skipped',
                sourcePostId: postAction.postId,
                targetSubreddit: appSettings.promoSubreddit,
                crosspostId,
                reason: `action_${postAction.action}_invalid_target`,
                revisionId: postAction.revisionId,
              },
              'warn'
            );
            console.warn(
              `[crosspost] mapped id is not a valid post id for delete; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} mappedId=${crosspostId}`
            );
            await removeCorrespondingPost(redis, postAction.postId);
            terminal = true;
            break;
          }
          const crosspost = await getCrosspostOrSkip(crosspostId);
          if (!crosspost) {
            break;
          }
          await crosspost.delete();
          mirrored = true;
          break;
        }
      }
      if (mirrored) {
        terminal = true;
        summary.actionsMirrored += 1;
        logCrosspostEvent({
          event: 'crosspost_attempt_succeeded',
          sourcePostId: postAction.postId,
          targetSubreddit: appSettings.promoSubreddit,
          crosspostId,
          reason: `action_${postAction.action}_mirrored`,
          revisionId: postAction.revisionId,
        });
        console.info(
          `[crosspost] mirrored action and marked processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} crosspostId=${crosspostId}`
        );
      }
    } catch (e) {
      const errorText = e instanceof Error ? e.message : String(e);
      const missingCrosspost =
        /not[\s-]?found|does not exist|deleted|no longer exists/i.test(errorText);
      const permanentMirrorFailure = isPermanentMirrorError(errorText);
      if (missingCrosspost || permanentMirrorFailure) {
        terminal = true;
        summary.crosspostsSkipped += 1;
        logCrosspostEvent(
          {
            event: 'crosspost_attempt_skipped',
            sourcePostId: postAction.postId,
            targetSubreddit: appSettings.promoSubreddit,
            reason: missingCrosspost
              ? `action_${postAction.action}_target_missing`
              : `action_${postAction.action}_terminal_context_error`,
            revisionId: postAction.revisionId,
            errorMessage: errorText,
          },
          'warn'
        );
        console.warn(
          `[crosspost] terminal mirror error; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} error=${errorText}`
        );
        if (missingCrosspost) {
          await removeCorrespondingPost(redis, postAction.postId);
        }
      } else {
        summary.actionsFailed += 1;
        logCrosspostEvent(
          {
            event: 'crosspost_attempt_failed',
            sourcePostId: postAction.postId,
            targetSubreddit: appSettings.promoSubreddit,
            reason: `action_${postAction.action}_mirror_failed`,
            revisionId: postAction.revisionId,
            errorMessage: errorText,
          },
          'error'
        );
        console.error(
          `[crosspost] error mirroring action: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId}`,
          e
        );
      }
    }

    if (terminal) {
      await storeProcessedRevision(
        redis,
        postAction.revisionId,
        postAction.postId
      );
    }
  }

  if (fetchFailureCount > 0 && fetchSuccessCount === 0) {
    summary.status = 'failed';
  } else if (fetchFailureCount > 0) {
    summary.status = 'partial';
  } else {
    summary.status = 'success';
  }

  if (fetchErrors.length > 0) {
    summary.errorMessage = fetchErrors.join(' | ');
  }

  return summary;
}

export async function processCrosspostDispatchQueue(
  appSettings: AppSettings,
  reason: string
): Promise<CrosspostIngestionSummary> {
  const crosspostIngestionEnabled = appSettings.crosspostIngestionEnabled !== false;
  const currentInstallSubredditRaw =
    context.subredditName ?? (await reddit.getCurrentSubreddit()).name;
  const currentInstallSubreddit = toNormalizedSubredditName(
    currentInstallSubredditRaw
  );
  const authoritySubreddit = getCrosspostAuthoritySubreddit(appSettings);
  const freshnessWindowMs = getCrosspostMaxSourcePostAgeMs(appSettings);
  const revisionFreshnessWindowMs = getCrosspostMaxRevisionAgeMs(appSettings);
  const maxCrosspostsPerRun = getMaxCrosspostsPerRun(appSettings);
  const maxCrosspostsPerHour = getMaxCrosspostsPerHour(appSettings);
  const ingestionAllowed = currentInstallSubreddit === authoritySubreddit;
  const logContext = {
    currentInstallSubreddit,
    authoritySubreddit,
    ingestionAllowed,
    freshnessWindowMs,
    revisionFreshnessWindowMs,
  };

  logCrosspostEvent({
    event: 'crosspost_retry_started',
    targetSubreddit: appSettings.promoSubreddit,
    reason,
    ...logContext,
  });

  if (!crosspostIngestionEnabled) {
    logCrosspostEvent(
      {
        event: 'crosspost_retry_skipped',
        targetSubreddit: appSettings.promoSubreddit,
        reason: 'ingestion_disabled',
        status: 'success',
        ...logContext,
      },
      'warn'
    );
    return emptySummary();
  }

  if (!ingestionAllowed) {
    logCrosspostEvent(
      {
        event: 'crosspost_retry_skipped',
        targetSubreddit: appSettings.promoSubreddit,
        reason: 'non_authority',
        status: 'success',
        ...logContext,
      },
      'warn'
    );
    return emptySummary();
  }

  const lockKey = `${crosspostIngestionLockKeyPrefix}:${toNormalizedSubredditName(
    appSettings.promoSubreddit
  )}`;
  const lock = await acquireCrosspostIngestionLock(redis, lockKey);
  if (!lock.acquired) {
    logCrosspostEvent(
      {
        event: 'crosspost_retry_skipped',
        targetSubreddit: appSettings.promoSubreddit,
        reason: 'lock_held',
        status: 'success',
        ...logContext,
      },
      'warn'
    );
    return emptySummary();
  }

  try {
    try {
      try {
        await cleanupCrosspostBookkeeping(redis);
      } catch (cleanupError) {
        console.warn(
          `[crosspost] bookkeeping cleanup failed; continuing ingestion: error=${toErrorMessage(
            cleanupError
          )}`
        );
      }

      const summary = emptySummary();
      const runErrorMessages: string[] = [];
      const maxPasses =
        reason === 'scheduler_posts_updater'
          ? crosspostSchedulerDaisyChainMaxPasses
          : 1;
      for (let pass = 1; pass <= maxPasses; pass += 1) {
        const passSummary = await updateFromWikis(appSettings, {
          sourcePostFreshnessWindowMs: freshnessWindowMs,
          revisionFreshnessWindowMs,
          maxCrosspostsPerRun,
          maxCrosspostsPerHour,
        });

        summary.revisionsFetched += passSummary.revisionsFetched;
        summary.newPostsSeen += passSummary.newPostsSeen;
        summary.crosspostsCreated += passSummary.crosspostsCreated;
        summary.crosspostsSkipped += passSummary.crosspostsSkipped;
        summary.crosspostsFailed += passSummary.crosspostsFailed;
        summary.actionsMirrored += passSummary.actionsMirrored;
        summary.actionsFailed += passSummary.actionsFailed;
        summary.crosspostsCreatedThisRun += passSummary.crosspostsCreatedThisRun;
        summary.crosspostsBlockedByRunCap += passSummary.crosspostsBlockedByRunCap;
        summary.crosspostsBlockedByHourlyCap += passSummary.crosspostsBlockedByHourlyCap;
        summary.crosspostPersistenceFailedAfterCreate +=
          passSummary.crosspostPersistenceFailedAfterCreate;
        summary.crosspostsSkippedBySourceCooldown +=
          passSummary.crosspostsSkippedBySourceCooldown;
        summary.crosspostsSkippedByInFlight +=
          passSummary.crosspostsSkippedByInFlight;
        summary.crosspostsSkippedByExistingDetection +=
          passSummary.crosspostsSkippedByExistingDetection;

        if (passSummary.status === 'failed') {
          summary.status = 'failed';
        } else if (passSummary.status === 'partial' && summary.status !== 'failed') {
          summary.status = 'partial';
        }
        if (passSummary.errorMessage) {
          runErrorMessages.push(passSummary.errorMessage);
        }

        const pendingDepth = await countPendingCrossposts(
          redis,
          appSettings.promoSubreddit
        );
        console.info(
          `[crosspost] daisy-chain pass ${pass}/${maxPasses}: pendingDepth=${pendingDepth} status=${passSummary.status}`
        );
        if (pendingDepth === 0) {
          break;
        }
      }
      if (runErrorMessages.length > 0) {
        summary.errorMessage = runErrorMessages.join(' | ');
      }

      if (summary.status === 'success') {
        await redis.set(crosspostRetryDegradedCountKey, '0');
      } else {
        const previous = parseInt(
          (await redis.get(crosspostRetryDegradedCountKey)) ?? '0',
          10
        );
        const consecutiveFailures = Number.isNaN(previous) ? 1 : previous + 1;
        await redis.set(
          crosspostRetryDegradedCountKey,
          consecutiveFailures.toString()
        );

        if (consecutiveFailures >= crosspostRetryDegradedThreshold) {
          logCrosspostEvent(
            {
              event: 'crosspost_retry_degraded',
              targetSubreddit: appSettings.promoSubreddit,
              reason,
              status: summary.status,
              revisionsFetched: summary.revisionsFetched,
              newPostsSeen: summary.newPostsSeen,
              crosspostsCreated: summary.crosspostsCreated,
              crosspostsSkipped: summary.crosspostsSkipped,
              crosspostsFailed: summary.crosspostsFailed,
              actionsMirrored: summary.actionsMirrored,
              actionsFailed: summary.actionsFailed,
              crosspostsCreatedThisRun: summary.crosspostsCreatedThisRun,
              crosspostsBlockedByRunCap: summary.crosspostsBlockedByRunCap,
              crosspostsBlockedByHourlyCap: summary.crosspostsBlockedByHourlyCap,
              crosspostPersistenceFailedAfterCreate:
                summary.crosspostPersistenceFailedAfterCreate,
              crosspostsSkippedBySourceCooldown:
                summary.crosspostsSkippedBySourceCooldown,
              crosspostsSkippedByInFlight: summary.crosspostsSkippedByInFlight,
              crosspostsSkippedByExistingDetection:
                summary.crosspostsSkippedByExistingDetection,
              ...withErrorMessage(summary.errorMessage),
              consecutiveFailures,
              ...logContext,
            },
            'warn'
          );
        }
      }

      logCrosspostEvent(
        {
          event:
            summary.status === 'failed'
              ? 'crosspost_retry_failed'
              : 'crosspost_retry_succeeded',
          targetSubreddit: appSettings.promoSubreddit,
          reason,
          status: summary.status,
          revisionsFetched: summary.revisionsFetched,
          newPostsSeen: summary.newPostsSeen,
          crosspostsCreated: summary.crosspostsCreated,
          crosspostsSkipped: summary.crosspostsSkipped,
          crosspostsFailed: summary.crosspostsFailed,
          actionsMirrored: summary.actionsMirrored,
          actionsFailed: summary.actionsFailed,
          crosspostsCreatedThisRun: summary.crosspostsCreatedThisRun,
          crosspostsBlockedByRunCap: summary.crosspostsBlockedByRunCap,
          crosspostsBlockedByHourlyCap: summary.crosspostsBlockedByHourlyCap,
          crosspostPersistenceFailedAfterCreate:
            summary.crosspostPersistenceFailedAfterCreate,
          crosspostsSkippedBySourceCooldown:
            summary.crosspostsSkippedBySourceCooldown,
          crosspostsSkippedByInFlight: summary.crosspostsSkippedByInFlight,
          crosspostsSkippedByExistingDetection:
            summary.crosspostsSkippedByExistingDetection,
          ...withErrorMessage(summary.errorMessage),
          ...logContext,
        },
        summary.status === 'failed' ? 'error' : 'info'
      );

      return summary;
    } catch (error) {
      const summary: CrosspostIngestionSummary = {
        ...emptySummary(),
        status: 'failed',
        errorMessage: toErrorMessage(error),
      };

      const previous = parseInt(
        (await redis.get(crosspostRetryDegradedCountKey)) ?? '0',
        10
      );
      const consecutiveFailures = Number.isNaN(previous) ? 1 : previous + 1;
      await redis.set(
        crosspostRetryDegradedCountKey,
        consecutiveFailures.toString()
      );
      if (consecutiveFailures >= crosspostRetryDegradedThreshold) {
        logCrosspostEvent(
          {
            event: 'crosspost_retry_degraded',
            targetSubreddit: appSettings.promoSubreddit,
            reason,
            status: summary.status,
            revisionsFetched: summary.revisionsFetched,
            newPostsSeen: summary.newPostsSeen,
            crosspostsCreated: summary.crosspostsCreated,
            crosspostsSkipped: summary.crosspostsSkipped,
            crosspostsFailed: summary.crosspostsFailed,
            actionsMirrored: summary.actionsMirrored,
            actionsFailed: summary.actionsFailed,
            crosspostsCreatedThisRun: summary.crosspostsCreatedThisRun,
            crosspostsBlockedByRunCap: summary.crosspostsBlockedByRunCap,
            crosspostsBlockedByHourlyCap: summary.crosspostsBlockedByHourlyCap,
            crosspostPersistenceFailedAfterCreate:
              summary.crosspostPersistenceFailedAfterCreate,
            crosspostsSkippedBySourceCooldown:
              summary.crosspostsSkippedBySourceCooldown,
            crosspostsSkippedByInFlight: summary.crosspostsSkippedByInFlight,
            crosspostsSkippedByExistingDetection:
              summary.crosspostsSkippedByExistingDetection,
            ...withErrorMessage(summary.errorMessage),
            consecutiveFailures,
            ...logContext,
          },
          'warn'
        );
      }

      logCrosspostEvent(
        {
          event: 'crosspost_retry_failed',
          targetSubreddit: appSettings.promoSubreddit,
          reason,
          status: summary.status,
          revisionsFetched: summary.revisionsFetched,
          newPostsSeen: summary.newPostsSeen,
          crosspostsCreated: summary.crosspostsCreated,
          crosspostsSkipped: summary.crosspostsSkipped,
          crosspostsFailed: summary.crosspostsFailed,
          actionsMirrored: summary.actionsMirrored,
          actionsFailed: summary.actionsFailed,
          crosspostsCreatedThisRun: summary.crosspostsCreatedThisRun,
          crosspostsBlockedByRunCap: summary.crosspostsBlockedByRunCap,
          crosspostsBlockedByHourlyCap: summary.crosspostsBlockedByHourlyCap,
          crosspostPersistenceFailedAfterCreate:
            summary.crosspostPersistenceFailedAfterCreate,
          crosspostsSkippedBySourceCooldown:
            summary.crosspostsSkippedBySourceCooldown,
          crosspostsSkippedByInFlight: summary.crosspostsSkippedByInFlight,
          crosspostsSkippedByExistingDetection:
            summary.crosspostsSkippedByExistingDetection,
          ...withErrorMessage(summary.errorMessage),
          ...logContext,
        },
        'error'
      );

      return summary;
    }
  } finally {
    await releaseCrosspostIngestionLock(
      redis,
      lock.lockKey,
      lock.lockToken
    );
  }
}

export async function onModAction(event: ModActionEvent): Promise<void> {
  const appSettings = await getAppSettings(
    (context as { settings?: { getAll<T>(): Promise<Partial<T>> } }).settings
  );
  const subredditName =
    context.subredditName ?? (await reddit.getCurrentSubreddit()).name;
  const authoritySubreddit = getCrosspostAuthoritySubreddit(appSettings);

  if (
    toNormalizedSubredditName(subredditName) === authoritySubreddit
  ) {
    if (event.action === 'wikirevise') {
      await processCrosspostDispatchQueue(appSettings, 'mod_action_wikirevise');
    }
    return;
  }

  if (
    event.action !== 'removelink' &&
    event.action !== 'approvelink' &&
    event.action !== 'spamlink'
  ) {
    return;
  }

  if (!event.targetPost) {
    console.warn('ModAction missing targetPost', event);
    return;
  }

  const appAccount = await reddit.getAppUser();
  if (!appAccount) {
    console.warn('ModAction missing app account context');
    return;
  }
  if (event.moderator?.name === appAccount.username) {
    return;
  }

  if (event.targetPost.authorId !== appAccount.id) {
    return;
  }

  const mappedAction = modToPostActionMap[event.action];
  if (!mappedAction) {
    return;
  }

  await dispatchPostAction(
    reddit,
    appSettings,
    event.targetPost.id,
    mappedAction
  );
}
