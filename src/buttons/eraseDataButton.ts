import {Context, Devvit, MenuItemOnPressEvent} from '@devvit/public-api';

import {eraseDataForm} from '../main.js';

async function onPress (event: MenuItemOnPressEvent, context: Context) {
  context.ui.showForm(eraseDataForm);
}

export const eraseDataButton = Devvit.addMenuItem({
  label: "Sub Goal - Erase a User's Data",
  location: 'subreddit',
  forUserType: 'moderator',
  onPress,
});
