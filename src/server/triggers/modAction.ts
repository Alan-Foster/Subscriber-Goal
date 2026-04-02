import { reddit, redis, context } from '@devvit/web/server';
import type { AppSettings } from '../../shared/types/api';
import { getAppSettings } from '../settings';
import {
  crosspostWikiPages,
  dispatchPostAction,
  getCorrespondingPost,
  hasCrosspost,
  isProcessedRevision,
  modToPostActionMap,
  parseNewPostDispatchReason,
  parsePostActionDispatchReason,
  storeCorrespondingPost,
  storeProcessedRevision,
} from '../data/crosspostData';
import { safeGetWikiPageRevisions } from '../utils/redditUtils';
import { logCrosspostEvent, toErrorMessage } from '../utils/crosspostLogs';
import { isLinkId, isThingId, type LinkId } from '../types';

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
          nsfw:
            post.nsfw ??
            (await reddit.getSubredditInfoById(post.subredditId)).isNsfw,
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
      switch (postAction.action) {
        case 'remove':
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
            terminal = true;
            break;
          }
          await reddit.remove(crosspostId, false);
          break;
        case 'approve':
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
            terminal = true;
            break;
          }
          await reddit.approve(crosspostId);
          break;
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
            terminal = true;
            break;
          }
          const crosspost = await reddit.getPostById(crosspostId);
          await crosspost.delete();
          break;
        }
      }
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
    } catch (e) {
      const errorText = e instanceof Error ? e.message : String(e);
      const missingCrosspost =
        /not[\s-]?found|does not exist|deleted|no longer exists/i.test(errorText);
      if (missingCrosspost) {
        terminal = true;
        summary.crosspostsSkipped += 1;
        logCrosspostEvent(
          {
            event: 'crosspost_attempt_skipped',
            sourcePostId: postAction.postId,
            targetSubreddit: appSettings.promoSubreddit,
            reason: `action_${postAction.action}_target_missing`,
            revisionId: postAction.revisionId,
            errorMessage: errorText,
          },
          'warn'
        );
        console.warn(
          `[crosspost] missing target while mirroring action; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} error=${errorText}`
        );
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

  if (event.action === 'approvelink') {
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
