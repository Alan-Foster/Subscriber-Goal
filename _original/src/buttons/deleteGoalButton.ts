/**
 * @file Defines the delete button for Sub Goal posts and opens the confirmation form when pressed.
 */
import {Context, Devvit, MenuItemOnPressEvent} from '@devvit/public-api';

import {deleteGoalForm} from '../main.js';

/**
 * Shows the {@linkcode deleteGoalForm} and that's it.
 * @param event - Event data associated with the menu item press, not useful in this case.
 * @param context - The full Context object provided by Devvit.
 */
async function onPress (event: MenuItemOnPressEvent, context: Context) {
  context.ui.showForm(deleteGoalForm);
}

/**
 * @description Adds the eraseDataButton as a menu item. This is exported via main.js, which tells Devvit about the button.
 * Unlike the other buttons, this one is set to only appear in the dropdown menu for posts created by the current app (i.e. Subscriber Goal custom posts).
 */
export const deleteGoalButton = Devvit.addMenuItem({
  label: 'Sub Goal - Delete This Goal',
  location: 'post',
  forUserType: 'moderator',
  postFilter: 'currentApp',
  onPress,
});
