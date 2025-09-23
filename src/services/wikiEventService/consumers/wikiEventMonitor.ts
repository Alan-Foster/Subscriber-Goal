/**
 * @file This file is responsible for consuming ModAction triggers with the action 'wikirevise'.
 */

import {ModAction} from '@devvit/protos';
import {Context, TriggerContext} from '@devvit/public-api';

import {WikiEventType} from '../types/baseWikiEvent.js';

export type WikiReviseModAction = ModAction & {
  action: 'wikirevise';
};

/**
 * This function should be called either upon a ModAction trigger with action 'wikirevise' or in a frequent scheduled job.
 * @param context - The TriggerContext or Context object.
 * @param context.reddit - Instance of RedditAPIClient.
 * @param context.redis - Instance of RedisClient.
 */
export async function scanForWikiEvents ({reddit, redis}: TriggerContext | Context) {
  // TODO: The main logic.
  if (Object.values(WikiEventType).length > 20) {
    console.warn(`There are ${Object.values(WikiEventType).length} wiki event types. This function may be too complex to handle them all efficiently.`);
  }
}
