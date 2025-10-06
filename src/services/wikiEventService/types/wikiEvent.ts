/**
 * @file This file combines the various wiki event types into a single union type.
 */

import {Context, TriggerContext} from '@devvit/public-api';

import {PostActionEvent} from './postActionEvent.js';
import {PostCreateEvent} from './postCreateEvent.js';

export type WikiEvent = PostCreateEvent | PostActionEvent;
export type WikiEventData = WikiEvent['data'];
export type WikiEventConsumer<Event extends WikiEvent> = (context: Context | TriggerContext, event: Event) => void | Promise<void>;
