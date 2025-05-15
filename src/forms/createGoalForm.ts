import {Context, Devvit, FormFunction, FormKey, FormOnSubmitEvent, FormOnSubmitEventHandler} from '@devvit/public-api';

import {previewMaker, PreviewProps, textFallbackMaker} from '../customPost/components/preview.js';
import {registerNewSubGoalPost} from '../data/subGoalData.js';
import {getAppSettings} from '../settings.js';
import {clearUserStickies, getSubredditIcon} from '../utils/subredditUtils.js';

export type CreateFormData = {
  defaultGoal?: number;
  subredditName?: string;
}

const form: FormFunction<CreateFormData> = (data: CreateFormData) => {
  if (!data.subredditName) {
    throw new Error('subredditName is required');
  }
  if (!data.defaultGoal) {
    throw new Error('defaultGoal is required');
  }

  return {
    title: 'Sub Goal - Create a New Goal',
    description: 'This will create a new subscriber goal post in the subreddit.',
    fields: [
      {
        name: 'subscriberGoal',
        label: 'Enter your Subscriber Goal',
        type: 'number',
        defaultValue: data.defaultGoal,
        helpText: 'The default goal is a suggestion on your current subscriber count, you may set it to any number greater than your current subscriber count.',
        required: true,
      },
    ],
  };
};

export type CreateFormSubmitData = {
  subscriberGoal?: number;
}

const formHandler: FormOnSubmitEventHandler<CreateFormSubmitData> = async (event: FormOnSubmitEvent<CreateFormSubmitData>, {settings, reddit, redis, ui, appName}: Context) => {
  const subscriberGoal = event.values.subscriberGoal;

  try {
    const subreddit = await reddit.getCurrentSubreddit();

    if (!subscriberGoal || subreddit.numberOfSubscribers >= subscriberGoal) {
      ui.showToast('Please select a valid subscriber goal!');
      return;
    }

    await clearUserStickies(reddit, appName);

    const previewProps: PreviewProps = {
      goal: subscriberGoal,
      subscribers: subreddit.numberOfSubscribers,
      subredditName: subreddit.name,
      recentSubscriber: '',
      completedTime: null,
      subredditIcon: await getSubredditIcon(reddit, subreddit.id),
    };

    // Using the form data, generate a Custom Post containing the Subscriber Goal
    const post = await reddit.submitPost({
      subredditName: subreddit.name,
      title: `Welcome to r/${subreddit.name}!`,
      textFallback: {text: textFallbackMaker(previewProps)},
      preview: previewMaker(previewProps),
    });

    // Approve the post explicitly to resolve potential AutoMod bug
    console.log(`Approved post: ${post.id}`);

    // Store the new Subscriber Goal and custom Header in Redis using the Post ID
    console.log(`Storing subscriber goal in Redis. Post ID: ${post.id}, Goal: ${subscriberGoal}`);
    await registerNewSubGoalPost(reddit, redis, await getAppSettings(settings), post, subscriberGoal);

    // Sticky, show confirmation Toast message and navigate to newly generated subscriber goal
    ui.showToast('Subscriber Goal post created!');
    ui.navigateTo(post);
    await post.approve();
    await post.sticky();
  } catch (error: unknown) {
    console.error(`Error creating button post: ${error instanceof Error ? error.message : String(error)}`);
    ui.showToast('An error occurred while creating the post.');
  }
};

export const createGoalForm: FormKey = Devvit.createForm(form, formHandler);
