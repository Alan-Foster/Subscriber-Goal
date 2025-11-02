/**
 * @file This file is responsible for actually sending WikiEvents in the correct manner.
 */

import {RedditAPIClient} from '@devvit/public-api';

import {WikiEventData} from '../types/wikiEvent.js';
import {isValidRevisionReason, normalizeWikiPath} from '../wikiUtils.js';

export type SendWikiEventProps = {
  reddit: RedditAPIClient;
  eventData: WikiEventData;
  targetSubredditName: string;
}

/**
 * Sends a WikiEventData object to the central promo subreddit wiki.
 * @param props - SendWikiEventProps object.
 * @param props.reddit - Instance of RedditAPIClient.
 * @param props.eventData - This is the event data you want to send to the central promo subreddit.
 * @param props.targetSubredditName - This is the name of the subreddit where the wiki event will be sent.
 */
export async function sendWikiEvent ({reddit, eventData, targetSubredditName}: SendWikiEventProps) {
  if (!targetSubredditName) {
    console.error('Target subreddit is not set, cannot send wiki event!');
    return;
  }

  const currentSubredditName = await reddit.getCurrentSubredditName();
  if (currentSubredditName.toLowerCase() === targetSubredditName.toLowerCase()) {
    // Do not send wiki events if already in the promo subreddit to avoid infinite loops.
    return;
  }

  // TODO: Implement a centralized way to get the wiki paths, so the formatting here parsing logic in parseWikiRevision are in one place.
  const wikiPath = normalizeWikiPath(`${(await reddit.getAppUser()).username}/${eventData.type}`);
  const payload = JSON.stringify(eventData);

  // 2 ** 19 = 524,288 bytes = 512 KiB
  // Reddit's wiki page size limit is 512 KB, although sometimes it seems to allow a bit more than that.
  const payloadSize = new TextEncoder().encode(payload).length;
  if (payloadSize > 2 ** 19) {
    throw new Error(`Wiki event payload is too large (${payloadSize} bytes, max is ${2 ** 19})`);
  }

  try {
    await reddit.updateWikiPage({
      subredditName: targetSubredditName,
      page: `${wikiPath}`,
      content: payload,
      // Check length and character content. It's likely we can store short payloads in the revision reason and skip an extra API call on the other side.
      reason: isValidRevisionReason(payload) ? payload : eventData.type,
    });
  } catch (error) {
    console.error(`Failed to send ${eventData.type} to subreddit ${targetSubredditName} at path ${wikiPath}:`, error);
  }
}

