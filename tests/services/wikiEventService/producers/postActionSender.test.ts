/**
 * @file Tests for functions in src/services/wikiEventService/producers/postActionSender.ts.
 */

import {isSupportedModAction, mapModActionToPostActionType} from '../../../../src/services/wikiEventService/producers/postActionSender.js';

describe('isSupportedModAction', () => {
  test.each(['removelink', 'approvelink', 'spamlink'])('returns true for "%s"', action => {
    expect(isSupportedModAction(action)).toBe(true);
  });

  it('returns false for unsupported actions', () => {
    expect(isSupportedModAction('other')).toBe(false);
  });
});

describe('mapModActionToPostActionType', () => {
  it('returns "remove" for "removelink"', () => {
    expect(mapModActionToPostActionType('removelink')).toBe('remove');
  });

  it('returns "remove" for "spamlink"', () => {
    expect(mapModActionToPostActionType('spamlink')).toBe('remove');
  });

  it('returns "approve" for "approvelink"', () => {
    expect(mapModActionToPostActionType('approvelink')).toBe('approve');
  });

  it('throws for unsupported action', () => {
    // @ts-expect-error Testing unsupported action
    expect(() => mapModActionToPostActionType('other')).toThrow();
  });
});
