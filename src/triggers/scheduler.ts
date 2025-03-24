import {Devvit, ScheduledJobEvent, TriggerContext} from '@devvit/public-api';

import {getAppSettings} from '../settings.js';

export async function onPostUpdateJob (event: ScheduledJobEvent<undefined>, context: TriggerContext) {
  console.log(`postsUpdaterJob job ran at ${new Date().toISOString()}\nevent:\n${JSON.stringify(event)}\ncontext:\n${JSON.stringify(context)}`);

  const appSettings = await getAppSettings(context.settings);
  const currentSubredditName = await context.reddit.getCurrentSubredditName();
  if (currentSubredditName.toLowerCase() === appSettings.promoSubreddit.toLowerCase()) {
    // TODO: Implement r/SubGoal post creation here
  }

  // TODO: Implement preview and text fallback updater here
}

export const postUpdaterJob = Devvit.addSchedulerJob({
  name: 'postsUpdaterJob',
  onRun: onPostUpdateJob,
});
