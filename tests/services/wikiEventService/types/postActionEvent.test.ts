/**
 * @file Tests for src/services/wikiEventService/types/postActionEvent.ts.
 */

import {WikiEventType} from '../../../../src/services/wikiEventService/types/baseWikiEvent.js';
import {isPostActionEvent, POST_ACTION_TYPES} from '../../../../src/services/wikiEventService/types/postActionEvent.js';
import {makeTestBaseWikiEvent} from './baseWikiEvent.test.js';
import {makeTestPostCreateEvent} from './postCreateEvent.test.js';

/**
 * Helper to create a BaseWikiEvent with given data for testing.
 * @param overrides - This will override good values on the `data` property of the event with test values.
 * @returns A BaseWikiEvent object with the provided data and mock revisionId and timestamp.
 */
export function makeTestPostActionEvent (overrides: object = {}) {
  return makeTestBaseWikiEvent({
    type: WikiEventType.PostActionEvent,
    postId: 'abc123',
    action: POST_ACTION_TYPES[0],
    actionTimestamp: 1234567890,
    ...overrides,
  });
}

describe('isPostActionEvent', () => {
  it('returns true for the valid test data', () => {
    expect(isPostActionEvent(makeTestPostActionEvent())).toBe(true);
  });

  it('returns true for a valid PostActionEvent with each action type', () => {
    POST_ACTION_TYPES.forEach(action => {
      expect(isPostActionEvent(makeTestPostActionEvent({action}))).toBe(true);
    });
  });

  it('returns false if not a BaseWikiEvent', () => {
    expect(isPostActionEvent({
      ...makeTestPostActionEvent(),
      revisionId: undefined, // Required by BaseWikiEvent
    })).toBe(false);
    expect(isPostActionEvent({})).toBe(false);
    expect(isPostActionEvent([])).toBe(false);
  });

  it('returns false if postId is not a string', () => {
    expect(isPostActionEvent(makeTestPostActionEvent({postId: 42}))).toBe(false);
  });

  it('returns false if action is not a valid PostActionType', () => {
    expect(isPostActionEvent(makeTestPostActionEvent({action: '42'}))).toBe(false);
  });

  it('returns false if actionTimestamp is not a number', () => {
    expect(isPostActionEvent(makeTestPostActionEvent({actionTimestamp: '42'}))).toBe(false);
  });

  it('returns false if given a PostCreateEvent', () => {
    expect(isPostActionEvent(makeTestPostCreateEvent())).toBe(false);
  });
});
