/**
 * @file This will take a WikiPageRevision from the wikiEventMonitor and parse it into a WikiEvent to be consumed by the appropriate consumer.
 */

import {Context, TriggerContext, WikiPageRevision} from '@devvit/public-api';

import {WikiEvent} from '../types/wikiEvent.js';
import {isLegacyWikiRevision, parseLegacyWikiRevision} from './legacyRevisionParser.js';

/**
 * This function will take a wiki revision and parse it into a WikiEvent if possible.
 * @param context - Context or TriggerContext from Devvit.
 * @param revision - The wiki revision to parse.
 * @returns A WikiEvent if the revision could be parsed into one, otherwise undefined.
 */
export async function parseWikiRevision (context: Context | TriggerContext, revision: WikiPageRevision): Promise<WikiEvent | undefined> {
  if (isLegacyWikiRevision(revision)) {
    return parseLegacyWikiRevision(revision);
  }

  return; // Placeholder until we implement the new format.
  // TODO: Parse the new WikiPageRevision format.
}
