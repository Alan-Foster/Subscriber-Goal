/**
 * @file This file defines the wiki event for actions taken on posts.
 */

import {BaseWikiEvent, isBaseWikiEvent, WikiEventType} from './baseWikiEvent.js';

export const POST_ACTION_TYPES = ['remove', 'approve', 'delete'] as const;
export type PostActionType = typeof POST_ACTION_TYPES[number];
export type PostActionEventData = {
  type: WikiEventType.PostActionEvent;
  postId: string;
  action: PostActionType;
  actionTimestamp: number;
}
export type PostActionEvent = BaseWikiEvent<PostActionEventData>;

/**
 * Type guard to check if an object is a valid PostActionEvent.
 * @param object - The object to check.
 * @returns Whether the given object is a valid PostActionEvent.
 */
export function isPostActionEvent (object: unknown): object is PostActionEvent {
  if (!isBaseWikiEvent(object)) {
    return false;
  }
  const maybeEvent = object as PostActionEvent;
  return (
    maybeEvent.data.type === WikiEventType.PostActionEvent &&
    typeof maybeEvent.data.postId === 'string' &&
    ['remove', 'approve', 'delete'].includes(maybeEvent.data.action) &&
    typeof maybeEvent.data.actionTimestamp === 'number'
  );
}
