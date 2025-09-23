/**
 * @file Contains the tests for the BaseWikiEvent and BaseWikiEventData type guards.
 */
import {
  BaseWikiEventData,
  isBaseWikiEvent,
  isBaseWikiEventData,
  WikiEventType,
} from '../../../../src/services/wikiEventService/types/baseWikiEvent.js';

/**
 * Helper to create a BaseWikiEvent with given data for testing.
 * @param data - This will be set as the `data` property of the event.
 * @returns A BaseWikiEvent object with the provided data and mock revisionId and timestamp.
 */
export function makeTestBaseWikiEvent<T> (data: T): {revisionId: string; timestamp: number; data: T} {
  return {
    revisionId: 'event-id',
    timestamp: Date.now(),
    data,
  };
}

describe('isBaseWikiEventData', () => {
  it('returns true for valid BaseWikiEventData objects', () => {
    Object.values(WikiEventType).forEach(type => {
      expect(isBaseWikiEventData({type})).toBe(true);
    });
  });

  it('returns false for objects with invalid type', () => {
    expect(isBaseWikiEventData({type: 'InvalidType'})).toBe(false);
    expect(isBaseWikiEventData({type: 123})).toBe(false);
    expect(isBaseWikiEventData({})).toBe(false);
  });

  it('returns false for non-object values', () => {
    expect(isBaseWikiEventData(null)).toBe(false);
    expect(isBaseWikiEventData(undefined)).toBe(false);
    expect(isBaseWikiEventData(42)).toBe(false);
    expect(isBaseWikiEventData('string')).toBe(false);
    expect(isBaseWikiEventData([])).toBe(false);
  });
});

describe('isBaseWikiEvent', () => {
  const validData: BaseWikiEventData = {type: Object.values(WikiEventType)[0]};

  it('returns true for valid BaseWikiEvent objects', () => {
    expect(isBaseWikiEvent(makeTestBaseWikiEvent(validData))).toBe(true);
  });

  it('returns false if revisionId is missing or not a string', () => {
    expect(isBaseWikiEvent({
      ...makeTestBaseWikiEvent(validData),
      revisionId: undefined,
    })).toBe(false);

    expect(isBaseWikiEvent({
      ...makeTestBaseWikiEvent(validData),
      revisionId: 42,
    })).toBe(false);
  });

  it('returns false if timestamp is missing or not a number', () => {
    expect(isBaseWikiEvent({
      ...makeTestBaseWikiEvent(validData),
      timestamp: undefined,
    })).toBe(false);

    expect(isBaseWikiEvent({
      ...makeTestBaseWikiEvent(validData),
      timestamp: 'text',
    })).toBe(false);
  });

  it('returns false if data is missing or not an object', () => {
    expect(isBaseWikiEvent(makeTestBaseWikiEvent(undefined))).toBe(false);
    expect(isBaseWikiEvent(makeTestBaseWikiEvent(42))).toBe(false);
  });

  it('returns false if data.type is invalid or missing', () => {
    expect(isBaseWikiEvent(makeTestBaseWikiEvent({}))).toBe(false);
    expect(isBaseWikiEvent(makeTestBaseWikiEvent({type: 'invalid'}))).toBe(false);
  });

  it('returns false for non-object values', () => {
    expect(isBaseWikiEvent(null)).toBe(false);
    expect(isBaseWikiEvent(undefined)).toBe(false);
    expect(isBaseWikiEvent(42)).toBe(false);
    expect(isBaseWikiEvent('string')).toBe(false);
    expect(isBaseWikiEvent([])).toBe(false);
  });
});
