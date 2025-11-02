/**
 * @file Tests for src/services/wikiEventService/types/wikiEvent.ts.
 */

import {isWikiEvent} from '../../../../src/services/wikiEventService/types/wikiEvent.js';
import {makeTestPostActionEvent} from './postActionEvent.test.js';
import {makeTestPostCreateEvent} from './postCreateEvent.test.js';

describe('isWikiEvent', () => {
  it('returns true for valid PostCreateEvent data', () => {
    expect(isWikiEvent(makeTestPostCreateEvent())).toBe(true);
  });

  it('returns true for valid PostActionEvent data', () => {
    expect(isWikiEvent(makeTestPostActionEvent())).toBe(true);
  });

  it('returns false if not an object', () => {
    expect(isWikiEvent(null)).toBe(false);
    expect(isWikiEvent(42)).toBe(false);
    expect(isWikiEvent('string')).toBe(false);
    expect(isWikiEvent([])).toBe(false);
  });

  it('returns false if missing required fields', () => {
    const invalidEvent = {
      revisionId: 'rev1',
      // timestamp is missing
      data: {
        type: 'PostCreateEvent',
        postId: 'post1',
        subredditDisplayName: 'testsub',
        subGoal: 1000,
      },
    };
    expect(isWikiEvent(invalidEvent)).toBe(false);
  });

  it('returns false if data field is invalid', () => {
    const invalidEvent = {
      revisionId: 'rev1',
      timestamp: Date.now(),
      data: {
        // type field is missing
        postId: 'post1',
        subredditDisplayName: 'testsub',
        subGoal: 1000,
      },
    };
    expect(isWikiEvent(invalidEvent)).toBe(false);
  });
});
