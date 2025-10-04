/**
 * @file This file sets up the trigger for monitoring actions in the subreddit mod log.
 * Depending on the current subreddit, it will monitor for actions taken on this app's posts, or for data sent via wiki revisions.
 */

import {ModAction} from '@devvit/protos';
import {Devvit, TriggerContext} from '@devvit/public-api';

import {scanForWikiEvents} from '../services/wikiEventService/consumers/wikiEventMonitor.js';
import {isSupportedModAction, mapModActionToPostActionType, sendPostActionEvent} from '../services/wikiEventService/producers/postActionSender.js';
import {getAppSettings} from '../settings.js';

/**
 * The "ModAction" trigger fires for every new entry in the subreddit's moderation log.
 * Some of the normal limitations of the modlog apply here (such as some automod actions not being logged).
 *
 * This function has two execution paths depending on whether the app is currently running in the central promo subreddit or not:
 *
 * - If this app instance is running in the promo subreddit, it will only handle `wikirevise` actions, which are used to recieve events from other subreddits. Assuming this is the case, it will call {@linkcode scanForWikiEvents} to check the wikis.
 *
 * - If this is a regular installation of the app, this function only monitor for `removelink`, `approvelink`, and `spamlink` actions. These actions are sent to the central promo subreddit, so the app there can mirror the actions on the crossposted post there. Removal actions are always sent, while approval actions are only sent if crossposting is enabled. The reasoning here is that crossposting may have been disabled after a post was already crossposted, meaning we'd still want to process removal for it. Assuming all the conditions are met, it will call {@linkcode dispatchPostAction}.
 * @param event - This is the event data about the mod action that caused the trigger to fire.
 * @param context - This is the TriggerContext provided by Devvit, which contains all the stuff for interacting with Reddit, Redis, etc.
 */
export async function onModAction (event: ModAction, context: TriggerContext) {
  if (!event.action) {
    console.warn(`ModAction event.action missing in onModAction, skipping: ${JSON.stringify(event)}`);
    return;
  }

  const currentSubredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
  const promoSubredditName = (await getAppSettings(context.settings)).promoSubreddit;

  if (promoSubredditName.toLowerCase() === currentSubredditName.toLowerCase()) {
    if (event.action === 'wikirevise') {
      console.log(`Detected wikirevise action in promo subreddit ${currentSubredditName}, scanning for wiki events...`);
      await scanForWikiEvents(context);
      return;
    }
  } else {
    if (isSupportedModAction(event.action)) {
      if (!event.targetPost || !event.targetPost.id) {
        console.warn(`ModAction event.targetPost missing in onModAction for action ${event.action}, skipping: ${JSON.stringify(event)}`);
        return;
      }

      // TODO: Probably implement a flag for whether events are being sent for a post, then check that flag here by importing a function from postDataService. Or maybe do that in the sendPostActionEvent function.
      await sendPostActionEvent({
        reddit: context.reddit,
        targetSubredditName: promoSubredditName,
        action: mapModActionToPostActionType(event.action),
        postId: event.targetPost.id,
        actionedAt: event.actionedAt, // Convert from seconds to milliseconds
      });
    }
  }
}

/**
 * @description This registers `onModAction` as the handler for `ModAction` trigger. It is exported via main.js to tell Devvit about the trigger.
 */
export const modActionTrigger = Devvit.addTrigger({
  event: 'ModAction',
  onEvent: onModAction,
});
