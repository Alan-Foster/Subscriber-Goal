/**
 * @file Functions for tracking which wiki revisions have been processed by the central promo subreddit.
 */

import {RedisClient} from '@devvit/public-api';

export const wikiRevisionCutoffKey = 'revisionCutoff';
export const processedRevisionsKey = 'processedRevisions';

/**
 * Stores the timestamp of latest wiki revision that was processed by the central promo subreddit.
 *
 * This should only be used by an instance of the app running on the central promo subreddit.
 * @param redis - Instance of RedisClient.
 * @param cutoff - The cutoff date for wiki revisions, it should be a Date object representing the creation timestamp of the latest processed revision.
 */
export async function setRevisionCutoff (redis: RedisClient, cutoff: Date): Promise<void> {
  await redis.set(wikiRevisionCutoffKey, cutoff.getTime().toString());
}

/**
 * Get the timestamp of the latest wiki revision that was processed by the central promo subreddit.
 *
 * This should only be used by an instance of the app running on the central promo subreddit.
 * @param redis - Instance of RedisClient.
 * @returns A Date object representing the cutoff time, where times after it have been processed and times before it have not.
 */
export async function getRevisionCutoff (redis: RedisClient): Promise<Date> {
  const cutoff = await redis.get(wikiRevisionCutoffKey);
  if (!cutoff) {
    return new Date(0);
  }
  return new Date(parseInt(cutoff));
}

/**
 * Stores a processed wiki revision ID and the corresponding post ID.
 *
 * This should only be used by an instance of the app running on the central promo subreddit.
 * @param redis - Instance of RedisClient.
 * @param wikiRevisionId - The ID of the wiki revision that was processed.
 * @param revisedAt - The date when the revision was made.
 */
export async function setProcessedRevision (redis: RedisClient, wikiRevisionId: string, revisedAt: Date): Promise<void> {
  await redis.hSet(processedRevisionsKey, {
    [wikiRevisionId]: revisedAt.getTime().toString(),
  });
}

/**
 * Checks if a wiki revision has already been processed.
 *
 * This should only be used by an instance of the app running on the central promo subreddit.
 * @param redis - Instance of RedisClient.
 * @param wikiRevisionId - The ID of the wiki revision to check.
 * @returns A boolean indicating whether the revision has been processed.
 */
export async function isProcessedRevision (redis: RedisClient, wikiRevisionId: string): Promise<boolean> {
  const revision = await redis.hGet(processedRevisionsKey, wikiRevisionId);
  return !!revision;
}

/**
 * Retrieves all processed wiki revision IDs.
 *
 * This should only be used by an instance of the app running on the central promo subreddit.
 * @param redis - Instance of RedisClient.
 * @returns A list of all processed wiki revision IDs.
 */
export async function getAllProcessedRevisions (redis: RedisClient): Promise<string[]> {
  const revisions = await redis.hGetAll(processedRevisionsKey);
  return Object.keys(revisions);
}

/**
 * Retrieves the processed revision status for a list of wiki revision IDs.
 * @param redis - Instance of RedisClient.
 * @param wikiRevisionIds - List of Wiki Revision IDs to check.
 * @returns A mapping of wiki revision IDs to their corresponding processed timestamps, invalid Date is not present, or null if not processed.
 */
export async function getProcessedRevisions (redis: RedisClient, wikiRevisionIds: string[]): Promise<Record<string, Date | null>> {
  const revisions = await redis.hMGet(processedRevisionsKey, wikiRevisionIds);
  if (wikiRevisionIds.length !== revisions.length) {
    throw new Error('Mismatch between requested and returned revision counts!'); // This better never happen or I'll go mad.
  }

  const result: Record<string, Date | null> = {};
  wikiRevisionIds.forEach((id, index) => {
    const timestamp = revisions[index];
    result[id] = timestamp ? new Date(parseInt(timestamp)) : null; // The Date constructor will return an invalid date for legacy data, which is acceptable here.
  });

  return result;
}
