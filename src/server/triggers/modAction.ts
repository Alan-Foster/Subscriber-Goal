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
import { isLinkId, isThingId, type LinkId, type RedisClient } from '../types';

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
  errorMessage?: string;
};

const crosspostRetryDegradedCountKey = 'crosspostRetryDegradedCount';
const crosspostRetryDegradedThreshold = 3;
export const crosspostBookkeepingCleanupLastRunKey =
  'crosspostBookkeepingCleanupLastRun';
const processedRevisionRetentionMs = 30 * 24 * 60 * 60 * 1000;
const processedRevisionMaxEntries = 10_000;
const crosspostCleanupMinIntervalMs = 6 * 60 * 60 * 1000;

type CrosspostBookkeepingCleanupOptions = {
  retentionMs?: number;
  maxEntries?: number;
  minIntervalMs?: number;
  nowMs?: number;
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
  };
}

const withErrorMessage = (errorMessage?: string): { errorMessage?: string } =>
  errorMessage ? { errorMessage } : {};

const isPermanentCrosspostError = (errorMessage: string): boolean =>
  /(OVER18_SUBREDDIT_CROSSPOST|SUBREDDIT_NOEXIST|INVALID_SUBREDDIT|FORBIDDEN|NOT_ALLOWED|is private|must be a moderator|doesn't allow crossposts|does not allow crossposts)/i.test(
    errorMessage
  );

const isPermanentMirrorError = (errorMessage: string): boolean =>
  /only allowed inside (the )?current subreddit/i.test(errorMessage);

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
    if (await isProcessedRevision(redis, revision.id)) {
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

    newPosts.add({
      postId,
      revisionId: revision.id,
      goal,
    });
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
  appSettings: AppSettings
): Promise<CrosspostIngestionSummary> {
  const summary = emptySummary();
  const fetchErrors: string[] = [];
  let fetchFailureCount = 0;
  let fetchSuccessCount = 0;

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
      await storeCorrespondingPost(redis, newPost.postId, crosspostId);
      await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
      summary.crosspostsCreated += 1;
      console.info(
        `[crosspost] created crosspost and marked processed: revisionId=${newPost.revisionId} sourcePostId=${newPost.postId} crosspostId=${crosspostId}`
      );
    } catch (e) {
      const errorMessage = toErrorMessage(e);
      const permanentFailure = isPermanentCrosspostError(errorMessage);
      if (permanentFailure || sourceSubredditIsNsfw) {
        summary.crosspostsSkipped += 1;
        logCrosspostEvent(
          {
            event: 'crosspost_attempt_skipped',
            sourcePostId: newPost.postId,
            targetSubreddit: appSettings.promoSubreddit,
            reason: sourceSubredditIsNsfw
              ? 'source_subreddit_nsfw'
              : 'target_policy_reject_or_denied',
            revisionId: newPost.revisionId,
            errorMessage,
          },
          'warn'
        );
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
      const getCrosspostOrSkip = async () => {
        const crosspost = await reddit.getPostById(crosspostId);
        if (!crosspost) {
          summary.crosspostsSkipped += 1;
          logCrosspostEvent(
            {
              event: 'crosspost_attempt_skipped',
              sourcePostId: postAction.postId,
              targetSubreddit: appSettings.promoSubreddit,
              crosspostId,
              reason: `action_${postAction.action}_target_missing`,
              revisionId: postAction.revisionId,
            },
            'warn'
          );
          console.warn(
            `[crosspost] missing target while mirroring action; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} crosspostId=${crosspostId}`
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
              crosspostId,
              reason: `action_${postAction.action}_wrong_subreddit`,
              revisionId: postAction.revisionId,
            },
            'warn'
          );
          console.warn(
            `[crosspost] mapped target subreddit mismatch; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} crosspostId=${crosspostId} expectedSubreddit=${appSettings.promoSubreddit} actualSubreddit=${crosspost.subredditName}`
          );
          await removeCorrespondingPost(redis, postAction.postId);
          terminal = true;
          return null;
        }

        return crosspost;
      };

      switch (postAction.action) {
        case 'remove': {
          if (!isThingId(crosspostId)) {
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
              `[crosspost] mapped id is not a valid thing id; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} mappedId=${crosspostId}`
            );
            await removeCorrespondingPost(redis, postAction.postId);
            terminal = true;
            break;
          }
          const crosspost = await getCrosspostOrSkip();
          if (!crosspost) {
            break;
          }
          await crosspost.remove(false);
          mirrored = true;
          break;
        }
        case 'approve': {
          if (!isThingId(crosspostId)) {
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
              `[crosspost] mapped id is not a valid thing id; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} mappedId=${crosspostId}`
            );
            await removeCorrespondingPost(redis, postAction.postId);
            terminal = true;
            break;
          }
          const crosspost = await getCrosspostOrSkip();
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
          const crosspost = await getCrosspostOrSkip();
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
  logCrosspostEvent({
    event: 'crosspost_retry_started',
    targetSubreddit: appSettings.promoSubreddit,
    reason,
  });

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

    const summary = await updateFromWikis(appSettings);
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
            ...withErrorMessage(summary.errorMessage),
            consecutiveFailures,
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
        ...withErrorMessage(summary.errorMessage),
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
          ...withErrorMessage(summary.errorMessage),
          consecutiveFailures,
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
        ...withErrorMessage(summary.errorMessage),
      },
      'error'
    );

    return summary;
  }
}

export async function onModAction(event: ModActionEvent): Promise<void> {
  const appSettings = await getAppSettings(
    (context as { settings?: { getAll<T>(): Promise<Partial<T>> } }).settings
  );
  const subredditName =
    context.subredditName ?? (await reddit.getCurrentSubreddit()).name;

  if (
    subredditName.toLowerCase() === appSettings.promoSubreddit.toLowerCase()
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
