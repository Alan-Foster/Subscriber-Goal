/**
 * @file Helper functions to send PostActionEvents to the promo subreddit wiki.
 */

import {RedditAPIClient} from '@devvit/public-api';

import {WikiEventType} from '../types/baseWikiEvent.js';
import {PostActionEventData, PostActionType} from '../types/postActionEvent.js';
import {sendWikiEvent} from './wikiEventSender.js';

export type SupportedModAction = 'removelink' | 'approvelink' | 'spamlink';

/**
 * Using a type guard like this makes it easier to work with the action string in the ModAction trigger.
 * @param action - A mod action string.
 * @returns True if the action is one of 'removelink', 'approvelink', or 'spamlink'.
 */
export function isSupportedModAction (action: string): action is SupportedModAction {
  return ['removelink', 'approvelink', 'spamlink'].includes(action);
}

/**
 * Maps a mod action string to a PostActionEvent action type.
 * @param action - One of the three supported mod actions from the ModAction trigger.
 * @returns The corresponding PostActionEvent action type.
 */
export function mapModActionToPostActionType (action: SupportedModAction): PostActionType {
  switch (action) {
  case 'removelink':
  case 'spamlink':
    return 'remove';
  case 'approvelink':
    return 'approve';
  default:
    throw new Error(`Unsupported mod action: ${String(action)}`);
  }
}

export type SendPostActionEventProps = {
  reddit: RedditAPIClient;
  targetSubredditName: string;
  action: PostActionType;
  postId: string;
  actionedAt?: Date;
}

/**
 * Sends a PostActionEvent to the specified subreddit wiki.
 * @param props - SendPostActionEventProps object.
 * @param props.reddit - Instance of RedditAPIClient.
 * @param props.targetSubredditName - This is the name of the subreddit where the wiki event will be sent.
 * @param props.action - Either `remove`, `approve`, or `delete`. Use {@linkcode mapModActionToPostActionType} to convert from mod action strings.
 * @param props.postId - The ID of the post the action was taken on.
 * @param props.actionedAt - Optional timestamp of when the action was taken. If not provided, the current time will be used.
 */
export async function sendPostActionEvent ({reddit, targetSubredditName, action, postId, actionedAt}: SendPostActionEventProps) {
  const eventData: PostActionEventData = {
    type: WikiEventType.PostActionEvent,
    action,
    postId,
    timestamp: actionedAt?.getTime() ?? Date.now(),
  };

  await sendWikiEvent({
    reddit,
    targetSubredditName,
    eventData,
  });
};
