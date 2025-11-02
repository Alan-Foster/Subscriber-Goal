/**
 * @file This will take a WikiPageRevision from the wikiEventMonitor and parse it into a WikiEvent to be consumed by the appropriate consumer.
 */

import {Context, TriggerContext, WikiPageRevision} from '@devvit/public-api';

import {isBaseWikiEventData, WikiEventType} from '../types/baseWikiEvent.js';
import {isWikiEvent, WikiEvent} from '../types/wikiEvent.js';
import {normalizeWikiPathWithRevision} from '../wikiUtils.js';
import {isLegacyWikiRevision, parseLegacyWikiRevision} from './legacyRevisionParser.js';

/**
 * This function will take a wiki revision and parse it into a WikiEvent if possible.
 * @param context - Context or TriggerContext from Devvit.
 * @param revision - The wiki revision to parse.
 * @returns A WikiEvent if the revision could be parsed into one, otherwise undefined.
 */
export async function parseWikiRevision (context: Context | TriggerContext, revision: WikiPageRevision): Promise<WikiEvent | undefined> {
  if (isLegacyWikiRevision(revision)) {
    console.debug('Parsing legacy wiki revision format:', revision);
    return parseLegacyWikiRevision(revision);
  }

  const appUsername = context.appName;

  // TODO: Implement a centralized way to get the wiki paths, so this parsing logic and formatting in sendWikiEvent is in one place.
  // sendWikiEvent uses the format: pageNamespace/eventType for the wiki page names, where pageNamespace is the app's username.
  const [pageNamespace, eventType] = revision.page.split('/'); // revision.page *shouldn't* have a leading slash.
  if (!pageNamespace || !eventType || pageNamespace.toLowerCase() !== appUsername.toLowerCase()) {
    console.debug(`Ignoring wiki revision at page ${revision.page} as it does not match expected format:`, revision);
    return undefined;
  }

  // Due to case insensitivity in wiki page names, we need to do a case-insensitive check for valid event types.
  const lowerCasedEventTypes = Object.values(WikiEventType).map(v => v.toLowerCase());
  if (!lowerCasedEventTypes.includes(eventType.toLowerCase())) {
    console.debug(`Ignoring wiki revision at page ${revision.page} as event type ${eventType} is not recognized:`, revision);
    return undefined;
  }

  // If the revision reason is not just the event type, try to parse it as JSON first.
  if (revision.reason.toLowerCase() !== eventType.toLowerCase()) {
    try {
      const parsedReason: unknown = JSON.parse(revision.reason);
      if (isBaseWikiEventData(parsedReason)) {
        console.debug('Parsed WikiEventData from revision reason.');
        const wikiEvent = {
          revisionId: revision.id,
          timestamp: revision.date.getTime(),
          data: parsedReason,
        };
        if (isWikiEvent(wikiEvent)) {
          return wikiEvent;
        }
      }
    } catch (e) {
      console.debug('Failed to parse revision reason as JSON, will fetch wiki page content instead:', e);
    }
  }

  // Otherwise, fetch the wiki page content and parse that.
  try {
    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    const wikiPage = await context.reddit.getWikiPage(subredditName, normalizeWikiPathWithRevision(revision.page, revision.id));

    const parsedContent: unknown = JSON.parse(wikiPage.content);
    if (isBaseWikiEventData(parsedContent)) {
      console.debug('Wiki page content parsed as WikiEventData:', parsedContent);
      const wikiEvent = {
        revisionId: revision.id,
        timestamp: revision.date.getTime(),
        data: parsedContent,
      };
      if (isWikiEvent(wikiEvent)) {
        return wikiEvent;
      }
      console.warn('Wiki page content isBaseWikiEventData but failed on isWikiEvent:', revision, parsedContent);
      return;
    } else {
      console.warn('Wiki page content is not valid WikiEventData:', revision, parsedContent);
      return;
    }
  } catch (e) {
    console.warn('Failed to fetch or parse wiki page content for revision:', revision, e);
    return;
  }
}
