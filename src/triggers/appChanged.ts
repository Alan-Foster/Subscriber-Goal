import {AppInstall, AppUpgrade, Devvit, TriggerContext, TriggerEventType} from '@devvit/public-api';
import {startSingletonJob} from 'devvit-helpers';

export async function onAppChanged (event: TriggerEventType[AppInstall] | TriggerEventType[AppUpgrade], context: TriggerContext) {
  try {
    // This function from devvit-helpers will start a job, but it terminates any other jobs with the same name first.
    await startSingletonJob(context.scheduler, 'postUpdaterJob', '* * * * *', {});
  } catch (e) {
    console.error('Failed to schedule postUpdaterJob job', e);
    throw e;
  }
}

export const appChangedTrigger = Devvit.addTrigger({
  events: ['AppInstall', 'AppUpgrade'],
  onEvent: onAppChanged,
});
