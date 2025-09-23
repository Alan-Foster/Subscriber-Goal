/**
 * @file Tests for src/services/wikiEventService/types/postCreateEvent.ts.
 */

import {isPostCreateEvent} from '../../../../src/services/wikiEventService/types/postCreateEvent.js';
import {makeTestBaseWikiEvent} from './baseWikiEvent.test.js';
import {makeTestPostActionEvent} from './postActionEvent.test.js';

/**
 * Helper to create a BaseWikiEvent with given data for testing.
 * @param overrides - This will override good values on the `data` property of the event with test values.
 * @returns A BaseWikiEvent object with the provided data and mock revisionId and timestamp.
 */
export function makeTestPostCreateEvent (overrides: object = {}) {
  return makeTestBaseWikiEvent({
    type: 'PostCreateEvent',
    postId: 'abc123',
    subGoal: 1000,
    ...overrides,
  });
}

describe('isPostCreateEvent', () => {
  it('returns true for the valid test data', () => {
    expect(isPostCreateEvent(makeTestPostCreateEvent())).toBe(true);
  });

  it('returns false if not a BaseWikiEvent', () => {
    expect(isPostCreateEvent({
      ...makeTestPostCreateEvent(),
      revisionId: undefined, // Required by BaseWikiEvent
    })).toBe(false);
    expect(isPostCreateEvent({})).toBe(false);
    expect(isPostCreateEvent([])).toBe(false);
  });

  it('returns false if postId is not a string', () => {
    expect(isPostCreateEvent(makeTestPostCreateEvent({postId: 42}))).toBe(false);
  });

  it('returns false if subGoal is not a number', () => {
    expect(isPostCreateEvent(makeTestPostCreateEvent({subGoal: '42'}))).toBe(false);
  });

  it('returns false if subredditDisplayName is not a string or undefined', () => {
    expect(isPostCreateEvent(makeTestPostCreateEvent({subredditDisplayName: 42}))).toBe(false);
    expect(isPostCreateEvent(makeTestPostCreateEvent({subredditDisplayName: {}}))).toBe(false);
  });

  it('returns false if given a PostActionEvent', () => {
    expect(isPostCreateEvent(makeTestPostActionEvent())).toBe(false);
  });
});
