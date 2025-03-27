import {Context, Devvit, FormFunction, FormKey, FormOnSubmitEvent, FormOnSubmitEventHandler} from '@devvit/public-api';

import {previewMaker} from '../customPost/components/preview.js';
import {setSubGoalData} from '../data/subGoalData.js';
import {queueUpdate, trackPost} from '../data/updaterData.js';
import {formatNumberUnlessExact} from '../utils/formatNumbers.js';
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
        name: 'title',
        label: 'Enter your Post Title:',
        defaultValue: `Welcome to r/${data.subredditName}!`,
        type: 'string',
        helpText: 'The actual title of the generated post',
        required: true,
      },
      {
        name: 'header',
        label: 'Enter your Goal Header:',
        defaultValue: `Help r/${data.subredditName} celebrate ${formatNumberUnlessExact(data.defaultGoal)} members!`,
        type: 'string',
        helpText: 'The large header inside the post itself.',
        required: true,
      },
      {
        name: 'subscriberGoal',
        label: 'Enter your Subscriber Goal',
        type: 'number',
        defaultValue: data.defaultGoal,
        helpText: 'Default goal is based on your current subscriber count',
        required: true,
      },
    ],
  };
};

export type CreateFormSubmitData = {
  title?: string;
  header?: string;
  subscriberGoal?: number;
}

const formHandler: FormOnSubmitEventHandler<CreateFormSubmitData> = async (event: FormOnSubmitEvent<CreateFormSubmitData>, {reddit, redis, ui}: Context) => {
  const title = event.values.title;
  const header = event.values.header;
  const subscriberGoal = event.values.subscriberGoal;

  if (!title || !header || !subscriberGoal) {
    ui.showToast('Please fill out all fields.');
    return;
  }

  try {
    const subreddit = await reddit.getCurrentSubreddit();

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

    // Using the form data, generate a Custom Post containing the Subscriber Goal
    const post = await reddit.submitPost({
      subredditName: subreddit.name,
      title,
      textFallback: {text: 'This content is only available on New Reddit. Please visit r/SubGoal to learn more!'},
      preview: previewMaker({
        goal: subscriberGoal,
        subscribers: subreddit.numberOfSubscribers,
        subredditName: subreddit.name,
        subredditIcon: await getSubredditIcon(reddit, subreddit.id),
        recentSubscriber: null,
        completedTime: null,
      }),
    });

    // Approve the post explicitly to resolve potential AutoMod bug
    await post.approve();
    console.log(`Approved post: ${post.id}`);

    // TODO: Dispatch new post event to r/SubGoal

    // Store the new Subscriber Goal and custom Header in Redis using the Post ID
    console.log(`Storing subscriber goal in Redis. Post ID: ${post.id}, Goal: ${subscriberGoal}, Header: ${header}`);
    await setSubGoalData(redis, post.id, {
      goal: subscriberGoal,
      header,
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
