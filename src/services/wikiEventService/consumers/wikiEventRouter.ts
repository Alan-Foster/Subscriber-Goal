/**
 * @file This where we route wiki events to their appropriate consumers.
 */

import {Context, TriggerContext} from '@devvit/public-api';

import {WikiEventType} from '../types/baseWikiEvent.js';
import {WikiEvent, WikiEventConsumer} from '../types/wikiEvent.js';

/**
 * A placeholder consumer that just logs the event to the console.
 * @param context - Context or TriggerContext from Devvit.
 * @param event - The wiki event to consume.
 */
export async function logWikiEvent<Event extends WikiEvent> (
  context: Context | TriggerContext,
  event: Event,
): Promise<void> {
  console.log(`Received wiki event of type ${event.data.type}`);
}

// We could make this an array of these records if we wanted to support multiple consumers for a single event type, but we don't need that yet so I won't bother.
export const WikiEventConsumers: Record<WikiEventType, WikiEventConsumer<WikiEvent>> = {
  // TODO: Replace the placeholder consumer with real consumers as we implement them.
  [WikiEventType.PostCreateEvent]: logWikiEvent,
  [WikiEventType.PostActionEvent]: logWikiEvent,
};

export const LegacyPages = ['remove', 'approve', 'delete', 'post'];

/**
 * This function will take a wiki event and route it to the appropriate consumer based on its type.
 * @param context - Context or TriggerContext from Devvit.
 * @param wikiEvent - The wiki event to route to the appropriate consumer.
 */
export async function consumeWikiEvent (context: Context | TriggerContext, wikiEvent: WikiEvent): Promise<void> {
  const consumer = WikiEventConsumers[wikiEvent.data.type];
  if (!consumer) {
    console.warn(`No consumer found for wiki event type ${wikiEvent.data.type}`);
    return;
  }
  await consumer(context, wikiEvent);
}
