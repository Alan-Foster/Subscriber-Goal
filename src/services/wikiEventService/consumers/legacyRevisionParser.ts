/**
 * @file This is where we'll parse the older wiki event format, ideally we'll upgrade all versions and drop this eventually.
 */

// Legacy pages: remove, approve, delete, post
// post
// const match = revision.reason.match(/Post (t3_[\w\d]+) with goal (\d+)/);
// remove, approve, delete
// const match = revision.reason.match(new RegExp(`Dispatch ${actionType} for (t3_[\\w\\d]+)`));
import {WikiPageRevision} from '@devvit/public-api';
import {isLinkId} from '@devvit/public-api/types/tid.js';

import {WikiEventType} from '../types/baseWikiEvent.js';
import {PostActionEvent, PostActionType} from '../types/postActionEvent.js';
import {PostCreateEvent} from '../types/postCreateEvent.js';
import {WikiEvent} from '../types/wikiEvent.js';
import {normalizeWikiPath} from '../wikiUtils.js';

export const LEGACY_PAGES = ['/remove', '/approve', '/delete', '/post'];

// TODO: Write some tests for these.

/**
 * This checks whether a given revision should be parsed as a legacy wiki revision.
 * @param revision - The wiki revision to check.
 * @returns Whether the given revision should be processed as a legacy wiki revision.
 */
export function isLegacyWikiRevision (revision: WikiPageRevision): boolean {
  return LEGACY_PAGES.includes(normalizeWikiPath(revision.page));
}

/**
 * A function to parse legacy wiki revisions into WikiEvents.
 * @param revision - The wiki revision to parse.
 * @returns A WikiEvent if the revision could be parsed into one, otherwise undefined.
 */
export function parseLegacyWikiRevision (revision: WikiPageRevision): WikiEvent | undefined {
  const page = normalizeWikiPath(revision.page);
  if (page === '/post') {
    const match = revision.reason.match(/Post (t3_[\w\d]+) with goal (\d+)/);
    if (!match) {
      console.warn('Invalid revision reason format', revision.reason);
      return;
    }
    const [text, postId, goalString] = match;
    if (!text || !postId || !goalString) {
      console.warn('Unmatched revision reason data', revision.reason);
      return;
    }

    const goal = parseInt(goalString);
    if (isNaN(goal)) {
      console.warn('Invalid goal value', goalString);
      return;
    }

    if (!isLinkId(postId)) {
      console.warn('Invalid postId format', postId);
      return;
    }

    const event: PostCreateEvent = {
      revisionId: revision.id,
      timestamp: revision.date.getTime(),
      data: {
        type: WikiEventType.PostCreateEvent,
        postId,
        subGoal: goal,
      },
    };
    return event;
  }

  if (page === '/remove' || page === '/approve' || page === '/delete') {
    const actionType = page.slice(1);
    const match = revision.reason.match(new RegExp(`Dispatch ${actionType} for (t3_[\\w\\d]+)`));
    if (!match) {
      console.warn(`Invalid legacy revision reason format for ${page} revision`, revision);
      return;
    }
    const [text, postId] = match;
    if (!text || !postId) {
      console.warn(`Missing legacy revision data for ${page} revision`, revision);
      return;
    }

    if (!isLinkId(postId)) {
      console.warn(`Invalid postId in legacy ${actionType} revision`, postId);
      return;
    }

    const event: PostActionEvent = {
      revisionId: revision.id,
      timestamp: revision.date.getTime(),
      data: {
        type: WikiEventType.PostActionEvent,
        postId,
        action: actionType as PostActionType,
        actionTimestamp: revision.date.getTime(),
      },
    };
    return event;
  }

  console.warn('parseLegacyWikiRevision was called with an unexpected revision: ', revision.page);
  return;
}
