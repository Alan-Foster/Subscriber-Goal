/**
 * @file Defines the erase data button in the subreddit menu and handles its press event.
 */

import {Context, Devvit, MenuItemOnPressEvent} from '@devvit/public-api';

import {eraseDataForm} from '../main.js';

/**
 * Shows the {@linkcode eraseDataForm} and that's it.
 * @param event - Event data associated with the menu item press, not useful in this case.
 * @param context - The full Context object provided by Devvit.
 */
async function onPress (event: MenuItemOnPressEvent, context: Context) {
  context.ui.showForm(eraseDataForm);
}

/**
 * @description Adds the eraseDataButton as a menu item. This is exported via main.js, which tells Devvit about the button.
 * It's set to only appear in the subreddit dropdown menu for moderators.
 */
export const eraseDataButton = Devvit.addMenuItem({
  label: "Sub Goal - Erase a User's Data",
  location: 'subreddit',
  forUserType: 'moderator',
  onPress,
});
