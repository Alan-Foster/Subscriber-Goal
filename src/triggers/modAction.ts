import {ModAction} from '@devvit/protos';
import {Devvit, TriggerContext} from '@devvit/public-api';

/**
 * The "ModAction" trigger fires for every new entry in the subreddit's moderation log.
 * Some of the normal limitations of the modlog apply here (such as some automod actions not being logged).
 * Actions taken by the app itself will also be logged here, you may want to ignore those to avoid infinite loops.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function onModAction (event: ModAction, context: TriggerContext) {
  console.log('ModAction');
  // TODO: Monitor new posts and post deletions if on r/SubGoal
}

export const modActionTrigger = Devvit.addTrigger({
  event: 'ModAction',
  onEvent: onModAction,
});
