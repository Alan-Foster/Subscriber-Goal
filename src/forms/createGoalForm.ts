/**
 * @file Defines the form and its submit handler for creating a new subscriber goal post.
 */

import {Context, Devvit, FormFunction, FormKey, FormOnSubmitEvent, FormOnSubmitEventHandler} from '@devvit/public-api';

import {previewMaker, PreviewProps, textFallbackMaker} from '../customPost/components/preview.js';
import {registerNewSubGoalPost} from '../data/subGoalData.js';
import {getAppSettings} from '../settings.js';
import {clearUserStickies, getSubredditIcon} from '../utils/redditUtils.js';

export type CreateFormData = {
  defaultGoal?: number;
  subredditName?: string;
  promoSubreddit?: string;
}

/**
 * This is a form function for generating the create post form.
 * @param data - Data used to generate the form.
 * @returns Form object as specified by Devvit.
 */
const form: FormFunction<CreateFormData> = (data: CreateFormData) => {
  if (!data.subredditName) {
    throw new Error('subredditName is required');
  }
  if (!data.defaultGoal) {
    throw new Error('defaultGoal is required');
  }
  if (!data.promoSubreddit) {
    throw new Error('promoSubreddit is required');
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
      {
        name: 'postTitle',
        label: 'Post Title',
        type: 'string',
        defaultValue: `Welcome to r/${data.subredditName}!`,
        helpText: 'This will be used as the title of the post, you can customize it as you see fit.',
        required: true,
      },
      {
        name: 'crosspost',
        label: `Auto-Crosspost to r/${data.promoSubreddit} (Recommended)`,
        type: 'boolean',
        helpText: `Keep this enabled to announce your goal in the r/${data.promoSubreddit} index subreddit.`,
        defaultValue: data.subredditName.toLowerCase() === data.promoSubreddit.toLowerCase() ? false : true,
        disabled: data.subredditName.toLowerCase() === data.promoSubreddit.toLowerCase(),
        required: true,
      },
    ],
  };
};

// All fields must be optional (regardless of the required attribute) due to limitations on Devvit and TypeScript's part for type inference.
export type CreateFormSubmitData = {
  subscriberGoal?: number;
  crosspost?: boolean;
  postTitle?: string;
}

/**
 * This is what happens when the form is submitted.
 * It does basic validation and then creates a new subscriber goal post and then calls {@linkcode registerNewSubGoalPost} to perform the necessary post-submission actions.
 * @param event - An object containing the event data associated with the form submission, specifically the form values.
 * @param context - The full context object provided by Devvit.
 * @param context.settings - Instance of SettingsClient.
 * @param context.reddit - Instance of RedditAPIClient.
 * @param context.redis - Instance of RedisClient.
 * @param context.ui - Instance of UIClient.
 * @param context.appName - The name of the Devvit app, which also serves as the app account username.
 */
const formHandler: FormOnSubmitEventHandler<CreateFormSubmitData> = async (event: FormOnSubmitEvent<CreateFormSubmitData>, {settings, reddit, redis, ui, appName}: Context) => {
  const subscriberGoal = event.values.subscriberGoal;
  const crosspost = event.values.crosspost;
  const title = event.values.postTitle;

  try {
    const subreddit = await reddit.getCurrentSubreddit();

    if (!subscriberGoal || subreddit.numberOfSubscribers >= subscriberGoal) {
      ui.showToast('Please select a valid subscriber goal!');
      return;
    }

    if (crosspost === undefined) {
      ui.showToast('Please specify if you want to crosspost!');
      return;
    }

    if (!title || title.trim().length === 0) {
      ui.showToast('Please provide a post title!');
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
      textFallback: {text: textFallbackMaker(previewProps)},
      preview: previewMaker(previewProps),
      title,
    });

    // Approve the post explicitly to resolve potential AutoMod bug
    console.log(`Approved post: ${post.id}`);

    // Store the new Subscriber Goal and custom Header in Redis using the Post ID
    console.log(`Storing subscriber goal in Redis. Post ID: ${post.id}, Goal: ${subscriberGoal}`);
    await registerNewSubGoalPost(reddit, redis, await getAppSettings(settings), post, subscriberGoal, crosspost);

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

/**
 * @description Creates the createGoalForm. This is exported via main.js, which tells Devvit about the form.
 */
export const createGoalForm: FormKey = Devvit.createForm(form, formHandler);
