import {ModAction} from '@devvit/protos';
import {Devvit, TriggerContext} from '@devvit/public-api';

import {dispatchPostAction, modToPostActionMap} from '../data/crosspostData.js';
import {getAppSettings} from '../settings.js';

/**
 * The "ModAction" trigger fires for every new entry in the subreddit's moderation log.
 * Some of the normal limitations of the modlog apply here (such as some automod actions not being logged).
 * Actions taken by the app itself will also be logged here, you may want to ignore those to avoid infinite loops.
 */

export async function onModAction (event: ModAction, context: TriggerContext) {
  if (event.action !== 'removelink' && event.action !== 'approvelink' && event.action !== 'spamlink') {
    return;
  }

  const appSettings = await getAppSettings(context.settings);
  const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
  if (subredditName.toLowerCase() === appSettings.promoSubreddit.toLowerCase()) {
    return; // We don't want to dispatch events in the promo subreddit
  }

  if (!event.targetPost) {
    console.warn('ModAction missing targetPost', event);
    return;
  }

  const appAccount = await context.reddit.getAppUser();
  if (event.moderator?.name === appAccount.username) {
    return; // Ignore actions taken by the app itself, like approving immediately after posting
  }

  if (event.targetPost.authorId !== appAccount.id) {
    return; // Ignore actions taken by the app itself, like approving immediately after posting
  }

  if (!appSettings.crosspost && event.action === 'approvelink') {
    return; // Ignore approvals if crossposting is disabled, we still want to respect removals though (in case the setting was changed after the post was already crossposted)
  }
  await dispatchPostAction(context.reddit, appSettings, event.targetPost.id, modToPostActionMap['event.action']);
}

export const modActionTrigger = Devvit.addTrigger({
  event: 'ModAction',
  onEvent: onModAction,
});
