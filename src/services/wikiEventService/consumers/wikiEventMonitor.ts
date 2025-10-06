/**
 * @file This file is responsible for consuming ModAction triggers with the action 'wikirevise'.
 */

import {Context, TriggerContext} from '@devvit/public-api';
import {isValidDate} from 'devvit-helpers';

import {getProcessedRevisions, getRevisionCutoff, setProcessedRevision, setRevisionCutoff} from './revisionTracker.js';
import {consumeWikiEvent} from './wikiEventRouter.js';
import {parseWikiRevision} from './wikiRevisionParser.js';

/**
 * This function should be called either upon a ModAction trigger with action 'wikirevise' or in a frequent scheduled job.
 * @param context - The TriggerContext or Context object.
 */
export async function scanForWikiEvents (context: TriggerContext | Context) {
  const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName(); // Fallback because subredditName is optional for some stupid reason
  const appUsername = context.appName; // appName should be the same as the Reddit username of the app 🤞

  const revisionCutoff = await getRevisionCutoff(context.redis); // Like the only sane part of this whole function.

  // We're getting all possibly releveant wiki revisions here. We're using the async iterator to page through them all.
  const wikiRevisions = [];
  const wikiRevisionsListing = context.reddit.getWikiPageRevisions({
    subredditName,
    limit: 100,
    page: '', // This is a hacky workaround to get revisions for all wiki pages, pending a proper getWikiRevisions() method as requested here: https://github.com/reddit/devvit/issues/206
  });
  for await (const revision of wikiRevisionsListing) {
    // I don't see how these could ever be missing, but out of an abundance of caution...
    if (!revision.page || !revision.id || isValidDate(revision.date)) {
      console.warn(`Skipping wiki revision with missing data: ${JSON.stringify(revision)}`);
      continue;
    }

    if (revision.date < revisionCutoff) {
      // Theoretically the listing should have newest revisions first and oldest last, so once we get to a revision older than the cutoff we can stop.
      break;
    }

    // This app only wants messages from other instances of itself, so ignore the rest.
    if (revision.author.username.toLowerCase() === appUsername.toLowerCase()) {
      wikiRevisions.push(revision);
    }
  }

  // Sort the revisions from oldest to newest so we process them as first in, first out. This is important for ordering of events.
  wikiRevisions.sort((a, b) => a.date.getTime() - b.date.getTime());

  // Filter out revisions that have already been processed.
  // TODO: See if this works as intended. While this reduces the number of Redis calls, it might cause double-processing if this function is ran concurrently.
  const processedRevisions = await getProcessedRevisions(context.redis, wikiRevisions.map(revision => revision.id));
  const revisionsQueue = wikiRevisions.filter(revision => processedRevisions[revision.id] !== null);

  for (const revision of revisionsQueue) {
    console.log(`Processing wiki revision ${revision.id} on page ${revision.page} made at ${revision.date.toISOString()} with reason: ${revision.reason}`);

    const wikiEvent = await parseWikiRevision(context, revision);
    if (!wikiEvent) {
      await setProcessedRevision(context.redis, revision.id, revision.date);
      continue;
    }

    // Consume the event. Allow for failure, just log it and mark the revision as processed so we don't keep retrying it forever.
    try {
      await consumeWikiEvent(context, wikiEvent);
    } catch (error) {
      console.error(`Error consuming wiki event for revision ${revision.id}:`, revision, error);
      // Don't mark this revision as processed so we can try again later.
      continue;
    }

    // Add the revision to the list of processed revisions and update the cutoff.
    await setProcessedRevision(context.redis, revision.id, revision.date);
    await setRevisionCutoff(context.redis, revision.date);
  }
}
