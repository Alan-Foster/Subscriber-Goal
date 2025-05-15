import {Context, Devvit, Form, FormKey, FormOnSubmitEvent, FormOnSubmitEventHandler} from '@devvit/public-api';

import {dispatchPostAction} from '../data/crosspostData.js';
import {cancelUpdates, untrackPost} from '../data/updaterData.js';
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

export type DeleteFormSubmitData = {
  confirm?: boolean;
}

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
      await dispatchPostAction(reddit, appSettings, postId, 'delete');
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

export const deleteGoalForm: FormKey = Devvit.createForm(form, formHandler);
