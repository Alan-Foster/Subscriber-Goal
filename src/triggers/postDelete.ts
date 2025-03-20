import {PostDelete} from '@devvit/protos';
import {Devvit, TriggerContext} from '@devvit/public-api';

/**
 * The "PostDelete" trigger fires after a post has been deleted or removed.
 * You will want to check the event.source and event.reason properties to determine if the post was deleted or removed and why.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function onPostDelete (event: PostDelete, context: TriggerContext) {
  console.log('PostDelete');
  // TODO: Dispatch post deletions to r/SubGoal
}

export const postDeleteTrigger = Devvit.addTrigger({
  event: 'PostDelete',
  onEvent: onPostDelete,
});
