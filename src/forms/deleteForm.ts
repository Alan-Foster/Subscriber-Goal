import {Context, Devvit, Form, FormKey, FormOnSubmitEvent, FormOnSubmitEventHandler} from '@devvit/public-api';

import {dispatchPostAction} from '../data/crosspostData.js';
import {getAppSettings} from '../settings.js';

const form: Form = {
  title: 'Delete Sub Goal Post',
  description: 'This action is irreversible.',
  fields: [
    {
      name: 'confirm',
      label: 'Are you sure?',
      type: 'boolean',
      defaultValue: false,
      helpText: 'This will permanently delete the Sub Goal post. If you wish to temporarily hide the post, you can remove it as a moderator and re-approve it later.',
    },
  ],
  acceptLabel: 'Delete',
  cancelLabel: 'Cancel',
};

export type DeleteFormSubmitData = {
  confirm?: boolean;
}

const formHandler: FormOnSubmitEventHandler<DeleteFormSubmitData> = async (event: FormOnSubmitEvent<DeleteFormSubmitData>, {settings, reddit, ui, postId}: Context) => {
  const confirm = event.values.confirm;

  if (!confirm) {
    ui.showToast('You did not confirm the deletion. If that was a mistake, please try again and enable the confirmation toggle before hitting delete.');
    return;
  }

  if (!postId) {
    ui.showToast('Post ID was somehow lost. Please try again.');
    return;
  }

  try {
    const post = await reddit.getPostById(postId);

    const appSettings = await getAppSettings(settings);
    await dispatchPostAction(reddit, appSettings, postId, 'delete');
    await post.delete();
    ui.showToast('Post deleted successfully!');
  } catch (e) {
    ui.showToast('Error deleting post. Pleae refresh the page and try again if the post is still there.');
    console.error('Error deleting post:', e);
    return;
  }
};

export const deleteForm: FormKey = Devvit.createForm(form, formHandler);
