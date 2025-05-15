import {Context, Devvit, Form, FormKey, FormOnSubmitEvent, FormOnSubmitEventHandler} from '@devvit/public-api';

import {eraseFromRecentSubscribers} from '../data/subGoalData.js';
import {untrackSubscriberById, untrackSubscriberByUsername} from '../data/subscriberStats.js';

const form: Form = {
  title: "SubGoal - Erase a User's Data",
  description: 'This will erase all data stored by Sub Goal associated with the specified user, such as when they subscribed and any other related data.',
  fields: [
    {
      name: 'username',
      label: 'Username',
      type: 'string',
      helpText: 'Erase all data associated with this username. Please note that in some cases this may be case sensitive, so it should be entered exactly as it appears in their Reddit profile link.',
      required: false,
    },
    {
      name: 'userId',
      label: 'User ID',
      type: 'string',
      helpText: 'Erase all data associated with this user ID. If left blank, this field will be fetched based on the specified username.',
      required: false,
    },
    {
      name: 'confirm',
      label: 'Are you sure?',
      type: 'boolean',
      defaultValue: false,
      helpText: 'This action is irreversible.',
    },
  ],
  acceptLabel: 'Erase',
  cancelLabel: 'Cancel',
};

export type DeleteFormSubmitData = {
  username?: string;
  userId?: string;
  confirm?: boolean;
}

const formHandler: FormOnSubmitEventHandler<DeleteFormSubmitData> = async (event: FormOnSubmitEvent<DeleteFormSubmitData>, {reddit, redis, ui}: Context) => {
  if (!event.values.confirm) {
    ui.showToast('You did not confirm the erasure. Please enable the confirmation toggle before proceeding.');
    return;
  }

  if (!event.values.username && !event.values.userId) {
    ui.showToast('User details were not provided. Please enter a username, user ID, or both.');
    return;
  }

  let userId = event.values.userId;
  let username = event.values.username;

  if (userId && !userId.startsWith('t2_')) {
    userId = `t2_${userId}`;
  }

  try {
    if (userId) {
      const user = await reddit.getUserById(userId);
      if (user) {
        username = user.username;
      }
    } else if (username) {
      const user = await reddit.getUserByUsername(username);
      if (user) {
        userId = user.id;
        username = user.username;
      }
    }
  } catch (error) {
    console.log('Error fetching user details: ', error);
    ui.showToast('Could not fetch all user details. Deletion will proceed, but may not catch all data. Please try again with the user ID if possible.');
  }

  if (userId) {
    await untrackSubscriberById(redis, userId);
  }

  if (username) {
    await untrackSubscriberByUsername(redis, username);
    await eraseFromRecentSubscribers(redis, username);
  }

  ui.showToast('User data has been erased successfully.');
};

export const eraseDataForm: FormKey = Devvit.createForm(form, formHandler);
