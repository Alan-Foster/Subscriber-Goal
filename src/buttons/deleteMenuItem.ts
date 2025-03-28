import {Context, Devvit, MenuItemOnPressEvent} from '@devvit/public-api';

import {deleteForm} from '../main.js';

async function onPress (event: MenuItemOnPressEvent, context: Context) {
  context.ui.showForm(deleteForm);
}

export const deleteMenuItem = Devvit.addMenuItem({
  label: 'Delete Sub Goal Post',
  location: 'post',
  forUserType: 'moderator',
  postFilter: 'currentApp',
  onPress,
});
