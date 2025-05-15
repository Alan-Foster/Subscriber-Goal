import {Context, Devvit, MenuItemOnPressEvent} from '@devvit/public-api';

import {deleteGoalForm} from '../main.js';

async function onPress (event: MenuItemOnPressEvent, context: Context) {
  context.ui.showForm(deleteGoalForm);
}

export const deleteGoalButton = Devvit.addMenuItem({
  label: 'Sub Goal - Delete This Goal',
  location: 'post',
  forUserType: 'moderator',
  postFilter: 'currentApp',
  onPress,
});
