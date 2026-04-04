import { reddit, redis, context } from '@devvit/web/server';
import type { AppSettings } from '../../shared/types/api';
import { getAppSettings } from '../settings';
import {
  crosspostListKey,
  crosspostWikiPages,
  dispatchPostAction,
  getCorrespondingPost,
  hasCrosspost,
  isProcessedRevision,
  processedRevisionsByTimeKey,
  processedRevisionsKey,
  modToPostActionMap,
  parseNewPostDispatchReason,
  parsePostActionDispatchReason,
  removeCorrespondingPost,
  removeProcessedRevisions,
  storeCorrespondingPost,
  storeProcessedRevision,
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
  crosspostPersistencePartial: number;
  crosspostPersistenceFailedAfterCreate: number;
  crosspostsSkippedBySourceCooldown: number;
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

type CrosspostBookkeepingCleanupOptions = {
  retentionMs?: number;
  maxEntries?: number;
  minIntervalMs?: number;
  nowMs?: number;
};

type RedisLockClient = Pick<RedisClient, 'get' | 'set' | 'del'>;

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
    crosspostPersistencePartial: 0,
    crosspostPersistenceFailedAfterCreate: 0,
    crosspostsSkippedBySourceCooldown: 0,
  };
}

const withErrorMessage = (errorMessage?: string): { errorMessage?: string } =>
  errorMessage ? { errorMessage } : {};

const isPermanentCrosspostError = (errorMessage: string): boolean =>
  /(OVER18_SUBREDDIT_CROSSPOST|SUBREDDIT_NOEXIST|INVALID_SUBREDDIT|FORBIDDEN|NOT_ALLOWED|is private|must be a moderator|doesn't allow crossposts|does not allow crossposts)/i.test(
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

async function markTerminalRevision(
  redisClient: Pick<RedisClient, 'set'>,
  revisionId: string
): Promise<void> {
  await redisClient.set(getTerminalRevisionKey(revisionId), '1', {
    expiration: new Date(Date.now() + crosspostTerminalRevisionTtlMs),
  });
}

async function markTerminalRevisionWithLogging(
  revisionId: string,
  sourcePostId: LinkId,
  contextReason: 'crosspost_persistence_partial' | 'crosspost_persistence_failed_after_create'
): Promise<boolean> {
  try {
    await markTerminalRevision(redis.global, revisionId);
    console.info(
      `[crosspost] terminal dedupe marked: revisionId=${revisionId} sourcePostId=${sourcePostId} reason=${contextReason}`
    );
    return true;
  } catch (error) {
    console.error(
      `[crosspost] terminal dedupe mark failed: revisionId=${revisionId} sourcePostId=${sourcePostId} reason=${contextReason} error=${toErrorMessage(
        error
      )}`
    );
    return false;
  }
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
      (await isTerminalRevisionMarked(redis.global, revision.id))
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
    redis.global,
    hourlyHistoryKey,
    nowMs
  );

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
    let sourceSubredditIsNsfw = false;
    try {
      const revisionDateMs = newPost.revisionDateMs;
      if (typeof revisionDateMs !== 'number' || !Number.isFinite(revisionDateMs)) {
        summary.crosspostsSkipped += 1;
        logCrosspostEvent(
          {
            event: 'crosspost_attempt_skipped',
            sourcePostId: newPost.postId,
            targetSubreddit: appSettings.promoSubreddit,
            reason: 'revision_age_unknown',
            revisionId: newPost.revisionId,
          },
          'warn'
        );
        await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        continue;
      }
      const revisionAgeMs = nowMs - revisionDateMs;
      if (revisionAgeMs > revisionFreshnessWindowMs) {
        summary.crosspostsSkipped += 1;
        logCrosspostEvent(
          {
            event: 'crosspost_attempt_skipped',
            sourcePostId: newPost.postId,
            targetSubreddit: appSettings.promoSubreddit,
            reason: 'revision_too_old',
            revisionId: newPost.revisionId,
          },
          'warn'
        );
        await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        continue;
      }
      if (summary.crosspostsCreatedThisRun >= maxCrosspostsPerRun) {
        summary.crosspostsSkipped += 1;
        summary.crosspostsBlockedByRunCap += 1;
        logCrosspostEvent(
          {
            event: 'crosspost_attempt_skipped',
            sourcePostId: newPost.postId,
            targetSubreddit: appSettings.promoSubreddit,
            reason: 'crosspost_cap_per_run_reached',
            revisionId: newPost.revisionId,
          },
          'warn'
        );
        await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        continue;
      }
      if (hourlyCreatedCount >= maxCrosspostsPerHour) {
        summary.crosspostsSkipped += 1;
        summary.crosspostsBlockedByHourlyCap += 1;
        logCrosspostEvent(
          {
            event: 'crosspost_attempt_skipped',
            sourcePostId: newPost.postId,
            targetSubreddit: appSettings.promoSubreddit,
            reason: 'crosspost_cap_hourly_reached',
            revisionId: newPost.revisionId,
          },
          'warn'
        );
        await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        continue;
      }

      const post = await reddit.getPostById(newPost.postId);
      if (!post) {
        summary.crosspostsSkipped += 1;
        logCrosspostEvent(
          {
            event: 'crosspost_attempt_skipped',
            sourcePostId: newPost.postId,
            targetSubreddit: appSettings.promoSubreddit,
            reason: 'source_post_missing',
            revisionId: newPost.revisionId,
          },
          'warn'
        );
        console.info(
          `[crosspost] source post missing; marking processed: revisionId=${newPost.revisionId} postId=${newPost.postId}`
        );
        await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        continue;
      }
      const createdAtMs = getPostCreatedAtMs(post);
      if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
        summary.crosspostsSkipped += 1;
        logCrosspostEvent(
          {
            event: 'crosspost_attempt_skipped',
            sourcePostId: newPost.postId,
            targetSubreddit: appSettings.promoSubreddit,
            reason: 'source_post_age_unknown',
            revisionId: newPost.revisionId,
          },
          'warn'
        );
        console.warn(
          `[crosspost] source post age unknown; terminal skip and mark processed: revisionId=${newPost.revisionId} postId=${newPost.postId} freshnessWindowMs=${sourcePostFreshnessWindowMs}`
        );
        await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        continue;
      }
      const postAgeMs = Date.now() - createdAtMs;
      if (postAgeMs > sourcePostFreshnessWindowMs) {
        summary.crosspostsSkipped += 1;
        logCrosspostEvent(
          {
            event: 'crosspost_attempt_skipped',
            sourcePostId: newPost.postId,
            targetSubreddit: appSettings.promoSubreddit,
            reason: 'source_post_too_old',
            revisionId: newPost.revisionId,
          },
          'warn'
        );
        console.warn(
          `[crosspost] stale source post; terminal skip and mark processed: revisionId=${newPost.revisionId} postId=${newPost.postId} ageMs=${postAgeMs} freshnessWindowMs=${sourcePostFreshnessWindowMs}`
        );
        await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        continue;
      }
      const sourceSubredditInfo = await reddit.getSubredditInfoById(post.subredditId);
      sourceSubredditIsNsfw = sourceSubredditInfo.isNsfw === true;
      if (sourceSubredditIsNsfw) {
        summary.crosspostsSkipped += 1;
        logCrosspostEvent({
          event: 'crosspost_attempt_skipped',
          sourcePostId: newPost.postId,
          targetSubreddit: appSettings.promoSubreddit,
          reason: 'source_subreddit_nsfw',
          revisionId: newPost.revisionId,
        });
        await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        continue;
      }
      if (await hasCrosspost(redis, newPost.postId)) {
        summary.crosspostsSkipped += 1;
        logCrosspostEvent({
          event: 'crosspost_attempt_skipped',
          sourcePostId: newPost.postId,
          targetSubreddit: appSettings.promoSubreddit,
          reason: 'already_mapped',
          revisionId: newPost.revisionId,
        });
        console.info(
          `[crosspost] mapping already exists; skipping duplicate crosspost: revisionId=${newPost.revisionId} postId=${newPost.postId}`
        );
        await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        continue;
      }
      if (await hasSourceCreateCooldown(redis.global, newPost.postId)) {
        summary.crosspostsSkipped += 1;
        summary.crosspostsSkippedBySourceCooldown += 1;
        logCrosspostEvent(
          {
            event: 'crosspost_attempt_skipped',
            sourcePostId: newPost.postId,
            targetSubreddit: appSettings.promoSubreddit,
            reason: 'source_post_recently_crossposted',
            revisionId: newPost.revisionId,
          },
          'warn'
        );
        await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        continue;
      }
      logCrosspostEvent({
        event: 'crosspost_attempt_started',
        sourcePostId: newPost.postId,
        targetSubreddit: appSettings.promoSubreddit,
        reason: 'dispatch_new_post',
        revisionId: newPost.revisionId,
      });
      let crosspostId: string;
      try {
        const crosspost = await reddit.crosspost({
          subredditName: appSettings.promoSubreddit,
          title: `Visit r/${post.subredditName}, they are trying to reach ${newPost.goal} subscribers!`,
          postId: post.id,
          nsfw: post.nsfw ?? sourceSubredditInfo.isNsfw,
        });
        crosspostId = crosspost.id;
      } catch (error) {
        logCrosspostEvent(
          {
            event: 'crosspost_attempt_failed',
            sourcePostId: newPost.postId,
            targetSubreddit: appSettings.promoSubreddit,
            reason: 'dispatch_new_post',
            revisionId: newPost.revisionId,
            errorMessage: toErrorMessage(error),
          },
          'error'
        );
        throw error;
      }
      logCrosspostEvent({
        event: 'crosspost_attempt_succeeded',
        sourcePostId: newPost.postId,
        targetSubreddit: appSettings.promoSubreddit,
        crosspostId,
        reason: 'dispatch_new_post',
        revisionId: newPost.revisionId,
      });
      try {
        await setSourceCreateCooldown(redis.global, newPost.postId);
      } catch (cooldownError) {
        console.warn(
          `[crosspost] failed to set source create cooldown: revisionId=${newPost.revisionId} sourcePostId=${newPost.postId} error=${toErrorMessage(
            cooldownError
          )}`
        );
      }

      let processedStored = false;
      let mappingStored = false;
      let processedStoreErrorMessage: string | undefined;
      let mappingStoreErrorMessage: string | undefined;

      try {
        await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        processedStored = true;
      } catch (processedStoreError) {
        processedStoreErrorMessage = toErrorMessage(processedStoreError);
      }

      try {
        await storeCorrespondingPost(redis, newPost.postId, crosspostId);
        mappingStored = true;
      } catch (mappingStoreError) {
        mappingStoreErrorMessage = toErrorMessage(mappingStoreError);
      }

      summary.crosspostsCreated += 1;
      summary.crosspostsCreatedThisRun += 1;
      hourlyCreatedCount += 1;
      await recordCrosspostCreation(
        redis.global,
        hourlyHistoryKey,
        newPost.revisionId,
        Date.now()
      );

      if (processedStored && mappingStored) {
        console.info(
          `[crosspost] created crosspost and marked processed: revisionId=${newPost.revisionId} sourcePostId=${newPost.postId} crosspostId=${crosspostId}`
        );
        continue;
      }

      const persistenceErrorMessage = [
        processedStoreErrorMessage,
        mappingStoreErrorMessage,
      ]
        .filter(Boolean)
        .join(' | ');

      if (processedStored) {
        summary.crosspostPersistencePartial += 1;
        await markTerminalRevisionWithLogging(
          newPost.revisionId,
          newPost.postId,
          'crosspost_persistence_partial'
        );
        logCrosspostEvent(
          {
            event: 'crosspost_persistence_partial',
            sourcePostId: newPost.postId,
            targetSubreddit: appSettings.promoSubreddit,
            crosspostId,
            reason: 'crosspost_persistence_partial',
            revisionId: newPost.revisionId,
            errorMessage: persistenceErrorMessage,
          },
          'warn'
        );
        console.warn(
          `[crosspost] crosspost created with partial persistence (processed stored, mapping missing): revisionId=${newPost.revisionId} sourcePostId=${newPost.postId} crosspostId=${crosspostId} error=${persistenceErrorMessage}`
        );
        continue;
      }

      summary.crosspostsSkipped += 1;
      summary.crosspostPersistenceFailedAfterCreate += 1;
      await markTerminalRevisionWithLogging(
        newPost.revisionId,
        newPost.postId,
        'crosspost_persistence_failed_after_create'
      );
      logCrosspostEvent(
        {
          event: 'crosspost_persistence_failed_after_create',
          sourcePostId: newPost.postId,
          targetSubreddit: appSettings.promoSubreddit,
          crosspostId,
          reason: 'crosspost_persistence_failed_after_create',
          revisionId: newPost.revisionId,
          errorMessage: persistenceErrorMessage,
        },
        'error'
      );
      console.error(
        `[crosspost] crosspost created but persistence failed; marked terminal fallback: revisionId=${newPost.revisionId} sourcePostId=${newPost.postId} crosspostId=${crosspostId} error=${persistenceErrorMessage}`
      );
      continue;
    } catch (e) {
      const errorMessage = toErrorMessage(e);
      const permanentFailure = isPermanentCrosspostError(errorMessage);
      const missingSourcePost = isMissingSourcePostError(errorMessage);
      if (permanentFailure || sourceSubredditIsNsfw || missingSourcePost) {
        summary.crosspostsSkipped += 1;
        logCrosspostEvent(
          {
            event: 'crosspost_attempt_skipped',
            sourcePostId: newPost.postId,
            targetSubreddit: appSettings.promoSubreddit,
            reason: sourceSubredditIsNsfw
              ? 'source_subreddit_nsfw'
              : missingSourcePost
                ? 'source_post_missing'
              : 'target_policy_reject_or_denied',
            revisionId: newPost.revisionId,
            errorMessage,
          },
          'warn'
        );
        if (missingSourcePost) {
          console.warn(
            `[crosspost] terminal missing source post; marking processed: revisionId=${newPost.revisionId} postId=${newPost.postId} error=${errorMessage}`
          );
        }
        await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        continue;
      }
      summary.crosspostsFailed += 1;
      console.error(
        `[crosspost] error creating crosspost: revisionId=${newPost.revisionId} postId=${newPost.postId}`,
        e
      );
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
  const lock = await acquireCrosspostIngestionLock(redis.global, lockKey);
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

      const summary = await updateFromWikis(appSettings, {
        sourcePostFreshnessWindowMs: freshnessWindowMs,
        revisionFreshnessWindowMs,
        maxCrosspostsPerRun,
        maxCrosspostsPerHour,
      });
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
              crosspostPersistencePartial: summary.crosspostPersistencePartial,
              crosspostPersistenceFailedAfterCreate:
                summary.crosspostPersistenceFailedAfterCreate,
              crosspostsSkippedBySourceCooldown:
                summary.crosspostsSkippedBySourceCooldown,
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
          crosspostPersistencePartial: summary.crosspostPersistencePartial,
          crosspostPersistenceFailedAfterCreate:
            summary.crosspostPersistenceFailedAfterCreate,
          crosspostsSkippedBySourceCooldown:
            summary.crosspostsSkippedBySourceCooldown,
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
            crosspostPersistencePartial: summary.crosspostPersistencePartial,
            crosspostPersistenceFailedAfterCreate:
              summary.crosspostPersistenceFailedAfterCreate,
            crosspostsSkippedBySourceCooldown:
              summary.crosspostsSkippedBySourceCooldown,
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
          crosspostPersistencePartial: summary.crosspostPersistencePartial,
          crosspostPersistenceFailedAfterCreate:
            summary.crosspostPersistenceFailedAfterCreate,
          crosspostsSkippedBySourceCooldown:
            summary.crosspostsSkippedBySourceCooldown,
          ...withErrorMessage(summary.errorMessage),
          ...logContext,
        },
        'error'
      );

      return summary;
    }
  } finally {
    await releaseCrosspostIngestionLock(
      redis.global,
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
