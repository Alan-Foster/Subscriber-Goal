/**
 * @file Defines the confirmation form and on submit actions for the deletion of a Sub Goal post, this is necessary to allow deletion of posts made by the app account.
 */

import {Context, Devvit, Form, FormKey, FormOnSubmitEvent, FormOnSubmitEventHandler} from '@devvit/public-api';

import {cancelUpdates, untrackPost} from '../data/updaterData.js';
import {sendPostActionEvent} from '../services/wikiEventService/producers/postActionSender.js';
import {getAppSettings} from '../settings.js';

const form: Form = {
  title: 'Sub Goal - Delete This Post',
  description: 'This will permanently delete the Sub Goal post. If you wish to temporarily hide the post, you can remove it as a moderator and re-approve it later.',
  fields: [
    {
      name: 'confirm',
      label: 'Are you sure?',
      type: 'boolean',
      defaultValue: false,
      helpText: 'This action is irreversible.',
    },
  ],
  acceptLabel: 'Delete',
  cancelLabel: 'Cancel',
};

// All fields must be optional (regardless of the required attribute) due to limitations on Devvit and TypeScript's part for type inference.
export type DeleteFormSubmitData = {
  confirm?: boolean;
}

/**
 * The handler checks that the user has confirmed the deletion, after which it deletes the post, removes it from Redis, and dispatches a delete action to the central promo subreddit.
 * @param event - An object containing the submitted form data.
 * @param context - The full context object provided by Devvit.
 * @param context.settings - Instance of SettingsClient.
 * @param context.reddit - Instance of RedditAPIClient.
 * @param context.redis - Instance of RedisClient.
 * @param context.ui - Instance of UIClient.
 * @param context.postId - The ID of the current post, provided by the Context of where the form was triggered.
 * @param context.subredditName - The current subreddit name.
 */
const formHandler: FormOnSubmitEventHandler<DeleteFormSubmitData> = async (event: FormOnSubmitEvent<DeleteFormSubmitData>, {settings, reddit, redis, ui, postId, subredditName}: Context) => {
  const confirm = event.values.confirm;

  if (!confirm) {
    ui.showToast('You did not confirm the deletion. If that was a mistake, please try again and enable the confirmation toggle before hitting delete.');
    return;
  }

  if (!postId || !subredditName) {
    ui.showToast('Deletion metadata was somehow lost. Please try again.');
    return;
  }

  try {
    const post = await reddit.getPostById(postId);

    const appSettings = await getAppSettings(settings);
    if (subredditName.toLowerCase() !== appSettings.promoSubreddit.toLowerCase()) {
      await sendPostActionEvent({
        reddit,
        targetSubredditName: appSettings.promoSubreddit,
        action: 'delete',
        postId,
      });
    }
    await post.delete();
    await cancelUpdates(redis, postId);
    await untrackPost(redis, postId);
    ui.showToast('Post deleted successfully!');
  } catch (e) {
    ui.showToast('Error deleting post. Pleae refresh the page and try again if the post is still there.');
    console.error('Error deleting post:', e);
    return;
  }
};

/**
 * @description Creates the deleteGoalForm. This is exported via main.js, which tells Devvit about the form.
 */
export const deleteGoalForm: FormKey = Devvit.createForm(form, formHandler);
