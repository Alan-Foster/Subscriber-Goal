/**
 * @file This file contains the type definitions for the base of the wiki events.
 * It also contains type guards to validate the structure of wiki events and their data.
 * It's set up to be easily extensible for future event types.
 */

export enum WikiEventType {
  PostCreateEvent = 'PostCreateEvent',
  PostActionEvent = 'PostActionEvent',
}

export type BaseWikiEventData = {
  timestamp?: number; // Timestamp associated with the received data, as opposed to the parent event's timestamp, which is the wiki revision time.
  type: WikiEventType;
}

export type BaseWikiEvent<WikiEventData extends BaseWikiEventData> = {
  revisionId: string; // This is the revision ID, which effectively doubles as the unique ID of the event.
  timestamp: number; // When the wiki revision was made.
  data: WikiEventData;
}

/**
 * Type guard to check if an object is a valid BaseWikiEvent.
 * @param object - The object to check.
 * @returns Whether the given object is a valid BaseWikiEvent with any kind of data.
 */
export function isBaseWikiEventData (object: unknown): object is BaseWikiEventData {
  if (!object || typeof object !== 'object') {
    return false;
  }
  const maybeData = object as BaseWikiEventData;
  return typeof maybeData.type === 'string' && Object.values(WikiEventType).includes(maybeData.type);
}

/**
 * Type guard to check if an object is a valid BaseWikiEvent.
 * @param object - The object to check.
 * @returns Whether the given object is a valid BaseWikiEvent with any kind of data.
 */
export function isBaseWikiEvent (object: unknown): object is BaseWikiEvent<BaseWikiEventData> {
  if (!object || typeof object !== 'object') {
    return false;
  }

  const maybeEvent = object as BaseWikiEvent<BaseWikiEventData>;
  return (
    maybeEvent.data !== undefined &&
    typeof maybeEvent.data === 'object' &&
    typeof maybeEvent.revisionId === 'string' &&
    typeof maybeEvent.timestamp === 'number' &&
    Object.values(WikiEventType).includes(maybeEvent.data.type)
  );
}
