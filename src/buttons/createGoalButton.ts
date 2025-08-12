/**
 * @file Defines the create sub goal button in the subreddit menu and handles its press event.
 */

import {Context, Devvit, MenuItemOnPressEvent} from '@devvit/public-api';

import {createGoalForm} from '../main.js';
import {getDefaultSubscriberGoal} from '../utils/numberUtils.js';

/**
 * Handles the press event for create new goal button in the subreddit menu.
 * It mainly just fetches some subreddit data and then uses it to show {@linkcode createGoalForm}.
 * @param event - Event data associated with the menu item press, not useful in this case.
 * @param context - The full Context object provided by Devvit.
 */
async function onPress (event: MenuItemOnPressEvent, context: Context) {
  try {
    const subreddit = await context.reddit.getCurrentSubreddit();
    const subscriberCount = subreddit.numberOfSubscribers;
    const subredditName = subreddit.name;
    const defaultGoal = getDefaultSubscriberGoal(subscriberCount);

    context.ui.showForm(createGoalForm, {
      subredditName,
      defaultGoal,
    });
  } catch (error: unknown) {
    console.error(`Error fetching subscriber count: ${error instanceof Error ? error.message : String(error)}`);
    context.ui.showToast('Error fetching subreddit data.');
  }
}

/**
 * @description Adds the createGoalButton as a menu item. This is exported via main.js, which tells Devvit about the button.
 * It's set to only appear in the subreddit dropdown menu for moderators.
 */
export const createGoalButton = Devvit.addMenuItem({
  label: 'Sub Goal - Create a New Goal',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress,
});
