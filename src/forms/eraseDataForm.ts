/**
 * @file This form allows moderators to erase all stored data associated with a specific username or user ID.
 */
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

// All fields must be optional (regardless of the required attribute) due to limitations on Devvit and TypeScript's part for type inference.
export type EraseFormSubmitData = {
  username?: string;
  userId?: string;
  confirm?: boolean;
}

/**
 * The form submit handler first validates the submitted form data, after which it attempts to resolve the user ID and canonical username as best it can.
 * After that it calls {@linkcode untrackSubscriberById}, {@linkcode untrackSubscriberByUsername}, and {@linkcode eraseFromRecentSubscribers} to perform the erasures.
 * This may have issues if the user has already been deleted and the inputs are not perfect (e.g., the username is not exactly as it appears in their profile link).
 * @param event - An object containing the event data, specifically the submitted form values.
 * @param context - The full context object provided by Devvit.
 * @param context.reddit - Instance of RedditAPIClient.
 * @param context.redis - Instance of RedisClient.
 * @param context.ui - Instance of UIClient.
 */
const formHandler: FormOnSubmitEventHandler<EraseFormSubmitData> = async (event: FormOnSubmitEvent<EraseFormSubmitData>, {reddit, redis, ui}: Context) => {
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

/**
 * @description Creates the eraseDataForm. This is exported via main.js, which tells Devvit about the form.
 */
export const eraseDataForm: FormKey = Devvit.createForm(form, formHandler);
