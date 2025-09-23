/**
 * @file This file combines the various wiki event types into a single union type.
 */

import {PostActionEvent} from './postActionEvent.js';
import {PostCreateEvent} from './postCreateEvent.js';

export type WikiEvent = PostCreateEvent | PostActionEvent;
export type WikiEventData = WikiEvent['data'];
