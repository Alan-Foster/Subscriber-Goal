import { Devvit } from '@devvit/public-api';
import { formatNumberUnlessExact } from './utils.js';

// Creates the form to generate the Subscriber Goal
export const createSubGoalForm = Devvit.createForm(
  (data) => {
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
          required: true 
        },
        {
          name: 'header',
          label: 'Enter your Goal Header:',
          defaultValue: `Help r/${data.subredditName} reach ${formatNumberUnlessExact(data.defaultGoal)} members!`,
          type: 'string',
          helpText: 'The large header inside the post itself.', 
          required: true 
        },
        {
          name: 'subscriberGoal',
          label: 'Enter your Subscriber Goal',
          type: 'number',
          defaultValue: data.defaultGoal, 
          helpText: 'Default goal is based on your current subscriber count', 
          required: true 
        },
      ],
    } as const;
  },
  async (event, context) => {
    const title = event.values.title;
	const header = event.values.header;
    const subscriberGoal = event.values.subscriberGoal;
    const { reddit, redis } = context;

    try {
      const subreddit = await reddit.getCurrentSubreddit();
	  // Using the form data, generate a Custom Post containing the Subscriber Goal
      const post = await reddit.submitPost({
        subredditName: subreddit.name,
        title: title,
		textFallback: { text: 'This content is only available on New Reddit. Please visit r/SubGoal to learn more!' },
        preview: (
          <vstack alignment="middle center" height="100%" width="100%">
            <text>Loading Subscriber Goal...</text>
          </vstack>
        ),
      });

	// Store the new Subscriber Goal and custom Header in Redis using the Post ID
	await redis.hSet('subscriber_goals', { 
	  [`${post.id}_goal`]: subscriberGoal.toString(), 
	  [`${post.id}_header`]: header
	});
	console.log(`Storing subscriber goal in Redis. Post ID: ${post.id}, Goal: ${subscriberGoal}, Header: ${header}`);

  // Sticky, show confirmation Toast message and navigate to newly generated subscriber goal
  await post.sticky();
  context.ui.showToast('Subscriber Goal post created!');
  context.ui.navigateTo(post);
	  
	} catch (error: any) {
	  console.error(`Error creating button post: ${error.message}`);
	  context.ui.showToast('An error occurred while creating the post.');
	}
  }
);