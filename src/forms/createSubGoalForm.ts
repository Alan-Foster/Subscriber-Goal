import {Context, Devvit, FormFunction, FormKey, FormOnSubmitEvent, FormOnSubmitEventHandler} from '@devvit/public-api';

import {basicPreview} from '../customPost/components/basicPreview.js';
import {formatNumberUnlessExact} from '../utils/formatNumbers.js';

export type CreateSubGoalFormData = {
  defaultGoal?: number;
  subredditName?: string;
}

const form: FormFunction<CreateSubGoalFormData> = (data: CreateSubGoalFormData) => {
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

export type CreateSubGoalSubmitData = {
  title?: string;
  header?: string;
  subscriberGoal?: number;
}

const formHandler: FormOnSubmitEventHandler<CreateSubGoalSubmitData> = async (event: FormOnSubmitEvent<CreateSubGoalSubmitData>, context: Context) => {
  const title = event.values.title;
  const header = event.values.header;
  const subscriberGoal = event.values.subscriberGoal;
  const {reddit, redis} = context;

  if (!title || !header || !subscriberGoal) {
    context.ui.showToast('Please fill out all fields.');
    return;
  }

  try {
    const subreddit = await reddit.getCurrentSubreddit();
  
    // Get all existing posts from u/subscriber-goal in the current subreddit
    const userPosts = await reddit.getPostsByUser({
      username: "subscriber-goal",
      limit: 100
    });
    const posts = await userPosts.all();
    const subredditPosts = posts.filter(post => post.subredditName === subreddit.name);
    
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
      preview: basicPreview,
    });

    // Approve the post explicitly to resolve potential AutoMod bug
    await post.approve();
    console.log(`Approved post: ${post.id}`);


    // TODO: Dispatch new post event to r/SubGoal

    // Store the new Subscriber Goal and custom Header in Redis using the Post ID
    await redis.hSet('subscriber_goals', {
      [`${post.id}_goal`]: subscriberGoal.toString(),
      [`${post.id}_header`]: header,
    });
    console.log(`Storing subscriber goal in Redis. Post ID: ${post.id}, Goal: ${subscriberGoal}, Header: ${header}`);

    // Sticky, show confirmation Toast message and navigate to newly generated subscriber goal
    await post.sticky();
    context.ui.showToast('Subscriber Goal post created!');
    context.ui.navigateTo(post);
  } catch (error: unknown) {
    console.error(`Error creating button post: ${error instanceof Error ? error.message : String(error)}`);
    context.ui.showToast('An error occurred while creating the post.');
  }
};

export const createSubGoalForm: FormKey = Devvit.createForm(form, formHandler);
