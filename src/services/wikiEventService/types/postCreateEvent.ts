/**
 * @file This file defines the wiki event for newly crated posts.
 */

import {BaseWikiEvent, isBaseWikiEvent, WikiEventType} from './baseWikiEvent.js';

export type PostCreateEventData = {
  type: WikiEventType.PostCreateEvent;
  postId: string;
  subGoal: number;
  subredditDisplayName?: string;
}
export type PostCreateEvent = BaseWikiEvent<PostCreateEventData>;

/**
 * Type guard to check if an object is a valid PostCreateEvent.
 * @param object - The object to check.
 * @returns Whether the given object is a valid PostCreateEvent.
 */
export function isPostCreateEvent (object: unknown): object is PostCreateEvent {
  if (!isBaseWikiEvent(object)) {
    return false;
  }
  const maybeEvent = object as PostCreateEvent;
  return (
    maybeEvent.data.type === WikiEventType.PostCreateEvent &&
    typeof maybeEvent.data.postId === 'string' &&
    typeof maybeEvent.data.subGoal === 'number' &&
    (maybeEvent.data.subredditDisplayName === undefined || typeof maybeEvent.data.subredditDisplayName === 'string')
  );
}
