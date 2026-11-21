import { reddit, redis, context, scheduler } from '@devvit/web/server';
import { getAppSettings } from '../settings';
import { dispatchPostAction, modToPostActionMap } from '../data/crosspostData';
import { isLinkId } from '../types';
import { logDiagnostic } from '../../shared/diagnostics';
import {
  appAccountHealthStateKey,
  subscriberGoalAppUsername,
} from '../core/appAccountHealth';
import { handleAppAccountModeratorAction } from '../core/appAccountRecovery';
import { recordScheduledPostDisplacementCheck } from '../core/scheduledPostDisplacement';
import { getPostUpdateRecheckKey } from '../utils/postStatus';
import {
  toNormalizedSubredditName,
  getCrosspostAuthoritySubreddit,
} from '../crosspost/bookkeeping';
import { processCrosspostDispatchQueue } from '../crosspost/dispatch';

export type ModActionEvent = {
  action?: string;
  actionedAt?: string;
  targetUser?: {
    name?: string;
  };
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

export async function onModAction(event: ModActionEvent): Promise<void> {
  const appSettings = getAppSettings();
  const currentSubreddit = context.subredditName
    ? undefined
    : await reddit.getCurrentSubreddit();
  const subredditName = context.subredditName ?? currentSubreddit!.name;
  const authoritySubreddit = getCrosspostAuthoritySubreddit(appSettings);

  const moderatorHealthActions = new Set([
    'removemoderator',
    'uninvitemoderator',
    'setpermissions',
    'addmoderator',
    'invitemoderator',
    'acceptmoderatorinvite',
  ]);
  const targetUsername = event.targetUser?.name
    ?.trim()
    .replace(/^u\//i, '')
    .toLowerCase();
  const isModeratorHealthAction = moderatorHealthActions.has(
    event.action ?? ''
  );
  const storedAppUsername = isModeratorHealthAction
    ? (await redis.hGet(appAccountHealthStateKey, 'appUsername'))
        ?.trim()
        .toLowerCase()
    : undefined;
  if (
    isModeratorHealthAction &&
    targetUsername === (storedAppUsername || subscriberGoalAppUsername)
  ) {
    const healthSubreddit =
      currentSubreddit ??
      (!context.subredditId ? await reddit.getCurrentSubreddit() : undefined);
    await handleAppAccountModeratorAction({
      reddit,
      redis,
      scheduler,
      action: event.action!,
      ...(event.moderator?.name ? { moderatorName: event.moderator.name } : {}),
      ...(event.actionedAt ? { actionedAt: event.actionedAt } : {}),
      subredditName,
      ...((context.subredditId ?? healthSubreddit?.id)
        ? { subredditId: context.subredditId ?? healthSubreddit!.id }
        : {}),
      ...(healthSubreddit?.language
        ? { language: healthSubreddit.language }
        : {}),
    });
  }

  const isAuthority =
    toNormalizedSubredditName(subredditName) === authoritySubreddit;
  if (isAuthority) {
    if (event.action === 'wikirevise') {
      await processCrosspostDispatchQueue(appSettings, 'mod_action_wikirevise');
    }
    if (event.action !== 'approvelink') return;
  }

  if (event.action === 'unsticky') {
    logDiagnostic('info', 'scheduled_post_displacement_unpin_received', {
      workflow: 'scheduled_post_displacement',
      postId: event.targetPost?.id,
      hasActionedAt: Boolean(event.actionedAt),
    });
  }

  if (
    event.action !== 'unsticky' &&
    event.action !== 'removelink' &&
    event.action !== 'approvelink' &&
    event.action !== 'spamlink'
  ) {
    return;
  }

  if (!event.targetPost) {
    logDiagnostic('warn', 'mod_action_validation_failed', {
      workflow: 'mod_action',
      phase: 'missing_target_post',
      category: typeof event.action === 'string' ? event.action : 'unknown',
    });
    return;
  }

  const appAccount = await reddit.getAppUser();
  if (!appAccount) {
    logDiagnostic('warn', 'mod_action_context_missing', {
      workflow: 'mod_action',
      phase: 'app_account_lookup',
      postId: event.targetPost.id,
    });
    return;
  }
  if (event.moderator?.name === appAccount.username) {
    return;
  }

  if (event.targetPost.authorId !== appAccount.id) {
    return;
  }

  if (event.action === 'approvelink' && isLinkId(event.targetPost.id)) {
    try {
      await redis.del(getPostUpdateRecheckKey(event.targetPost.id));
    } catch (error) {
      logDiagnostic(
        'warn',
        'subscriber_goal_update_recheck_clear_failed',
        {
          workflow: 'mod_action',
          postId: event.targetPost.id,
        },
        error
      );
    }
  }
  if (isAuthority) return;

  if (event.action === 'unsticky') {
    const moderator = event.moderator?.name?.trim().toLowerCase();
    if (
      moderator &&
      moderator !== appAccount.username.toLowerCase() &&
      isLinkId(event.targetPost.id)
    ) {
      await recordScheduledPostDisplacementCheck(
        redis,
        event.targetPost.id,
        event.actionedAt
      );
    }
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

// Keep the previous exports available while crosspost callers move to their own modules.
export {
  cleanupCrosspostBookkeeping,
  crosspostBookkeepingCleanupLastRunKey,
  getCrosspostAuthoritySubreddit,
  isCrosspostAuthorityInstall,
  toNormalizedSubredditName,
} from '../crosspost/bookkeeping';
export { processCrosspostDispatchQueue } from '../crosspost/dispatch';
export { isMissingSourcePostError } from '../crosspost/pending';
export type {
  CrosspostIngestionStatus,
  CrosspostIngestionSummary,
} from '../crosspost/summary';
