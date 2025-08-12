/**
 * @file This file contains the handler for both the AppInstall and AppUpgrade triggers.
 */

import {AppInstall, AppUpgrade, Devvit, TriggerContext, TriggerEventType} from '@devvit/public-api';
import {startSingletonJob} from 'devvit-helpers';

import {getTrackedPosts, queueUpdates} from '../data/updaterData.js';

/**
 * This function runs whenever the app is first installed or when it's updated.
 * It starts the job that updates all queued posts and also adds all existing tracked posts to the update queue (to update their previews in case of a change between versions).
 * @param event - The event data for the AppInstall or AppUpgrade trigger. Sometimes this data is not hydrated, although it's not used in this function anyway.
 * @param context - The TriggerContext object provided by Devvit.
 */
export async function onAppChanged (event: TriggerEventType[AppInstall] | TriggerEventType[AppUpgrade], context: TriggerContext) {
  try {
    // This function from devvit-helpers will start a job, but it terminates any other jobs with the same name first.
    await startSingletonJob(context.scheduler, 'postsUpdaterJob', '* * * * *', {});
  } catch (e) {
    console.error('Failed to schedule postsUpdaterJob job', e);
    throw e;
  }

  // App changed, so update all previews
  const trackedPosts = await getTrackedPosts(context.redis);
  if (!trackedPosts.length) {
    return;
  }
  console.log(`Scheduling preview updates for: ${trackedPosts.join(',')}`);
  await queueUpdates(context.redis, trackedPosts);
}

/**
 * @description This registers `onAppChanged` as the handler for `AppInstall` and `AppUpgrade` triggers. It is exported via main.js to tell Devvit about this.
 */
export const appChangedTrigger = Devvit.addTrigger({
  events: ['AppInstall', 'AppUpgrade'],
  onEvent: onAppChanged,
});
