import {Context, Devvit, MenuItemOnPressEvent} from '@devvit/public-api';

import {createSubGoalForm} from '../main.js';
import {getDefaultSubscriberGoal} from '../utils/defaultSubscriberGoal.js';

async function onPress (event: MenuItemOnPressEvent, context: Context) {
  try {
    const subreddit = await context.reddit.getCurrentSubreddit();
    const subscriberCount = subreddit.numberOfSubscribers;
    const subredditName = subreddit.name;
    const defaultGoal = getDefaultSubscriberGoal(subscriberCount);

    context.ui.showForm(createSubGoalForm, {
      subredditName,
      defaultGoal,
    });
  } catch (error: unknown) {
    console.error(`Error fetching subscriber count: ${error instanceof Error ? error.message : String(error)}`);
    context.ui.showToast('Error fetching subreddit data.');
  }
}

export const createSubGoalButton = Devvit.addMenuItem({
  label: 'Create a New Sub Goal Post',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress,
});
