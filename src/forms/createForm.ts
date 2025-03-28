import {Context, Devvit, FormFunction, FormKey, FormOnSubmitEvent, FormOnSubmitEventHandler} from '@devvit/public-api';

import {previewMaker, PreviewProps, textFallbackMaker} from '../customPost/components/preview.js';
import {setSubGoalData} from '../data/subGoalData.js';
import {queueUpdate, trackPost} from '../data/updaterData.js';
import {getSubredditIcon} from '../utils/subredditUtils.js';

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
    title: 'Create a New Sub Goal Post',
    description: '',
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

const formHandler: FormOnSubmitEventHandler<CreateFormSubmitData> = async (event: FormOnSubmitEvent<CreateFormSubmitData>, {reddit, redis, ui}: Context) => {
  const subscriberGoal = event.values.subscriberGoal;

  try {
    const subreddit = await reddit.getCurrentSubreddit();

    if (!subscriberGoal || subreddit.numberOfSubscribers >= subscriberGoal) {
      ui.showToast('Please select a valid subscriber goal!');
      return;
    }

    // Get all existing posts from u/subscriber-goal in the current subreddit
    const userPosts = await reddit.getPostsByUser({
      username: 'subscriber-goal',
      limit: 100,
    }).all();
    const subredditPosts = userPosts.filter(post => post.subredditName === subreddit.name);

    // Unsticky any existing goal posts before generating a new one
    for (const existingPost of subredditPosts) {
      if (existingPost.stickied) {
        await existingPost.unsticky();
        console.log(`Unstickied previous goal post: ${existingPost.id}`);
      }
    }

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
    await post.approve();
    console.log(`Approved post: ${post.id}`);

    // TODO: Dispatch new post event to r/SubGoal

    // Store the new Subscriber Goal and custom Header in Redis using the Post ID
    console.log(`Storing subscriber goal in Redis. Post ID: ${post.id}, Goal: ${subscriberGoal}`);
    await setSubGoalData(redis, post.id, {
      goal: subscriberGoal,
      recentSubscriber: '',
      completedTime: 0,
    });
    await trackPost(redis, post.id, post.createdAt);
    await queueUpdate(redis, post.id, post.createdAt);

    // Sticky, show confirmation Toast message and navigate to newly generated subscriber goal
    await post.sticky();
    ui.showToast('Subscriber Goal post created!');
    ui.navigateTo(post);
  } catch (error: unknown) {
    console.error(`Error creating button post: ${error instanceof Error ? error.message : String(error)}`);
    ui.showToast('An error occurred while creating the post.');
  }
};

export const createForm: FormKey = Devvit.createForm(form, formHandler);
