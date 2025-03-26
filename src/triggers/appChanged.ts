import {AppInstall, AppUpgrade, Devvit, TriggerContext, TriggerEventType} from '@devvit/public-api';
import {startSingletonJob} from 'devvit-helpers';

import {getTrackedPosts, queueUpdates} from '../data/updaterData.js';

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

export const appChangedTrigger = Devvit.addTrigger({
  events: ['AppInstall', 'AppUpgrade'],
  onEvent: onAppChanged,
});
