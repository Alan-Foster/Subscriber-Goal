/**
 * @file This file combines the various wiki event types into a single union type.
 */

import {Context, TriggerContext} from '@devvit/public-api';

import {isBaseWikiEvent, WikiEventType} from './baseWikiEvent.js';
import {isPostActionEvent, PostActionEvent} from './postActionEvent.js';
import {isPostCreateEvent, PostCreateEvent} from './postCreateEvent.js';

export type WikiEvent = PostCreateEvent | PostActionEvent;
export type WikiEventData = WikiEvent['data'];
export type WikiEventConsumer<Event extends WikiEvent> = (context: Context | TriggerContext, event: Event) => void | Promise<void>;

/**
 * Type guard to check if an object is a valid WikiEvent, this includes all defined event types.
 * @param object - The object to check.
 * @returns Whether the given object is a valid WikiEvent.
 */
export function isWikiEvent (object: unknown): object is WikiEvent {
  if (!object || typeof object !== 'object' || !isBaseWikiEvent(object)) {
    return false;
  }
  const maybeData = object as WikiEvent;
  switch (maybeData.data.type) {
  case WikiEventType.PostCreateEvent:
    return isPostCreateEvent(maybeData);
  case WikiEventType.PostActionEvent:
    return isPostActionEvent(maybeData);
  default:
    console.log('isWikiEventData: Object is not valid - invalid type property.', object);
    return false;
  }
}
