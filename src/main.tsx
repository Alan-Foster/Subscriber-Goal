import { getDefaultSubscriberGoal } from './subscriber-defaults';
import { Devvit, useState, useAsync, useChannel } from '@devvit/public-api';

Devvit.configure({ redditAPI: true, redis: true, media: true, realtime: true });

// Round the number to nearest 1k or 1m regardless of exact value eg 12,456 to 12.4k
// Used for number of actual subscribers to render (912 K / 1 million) instead of (912345 / 1000000)
// Ideal for international communities because Europe vs USA use different thousands denominators
function formatNumberAlwaysRound(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + ' M';
  } else if (num >= 10000) {
    return (num / 1000).toFixed(1) + ' K';
  }
  return num.toString();
}

// Round the number to the nearest 1k or 1m unless it's an exact goal eg 12,345,678
// Used for subscriber goal which is usually a round number (300k) but may be specific (1,234,567)
function formatNumberUnlessExact(num) {
  if (num >= 1000000 && num % 100000 === 0) {
    return (num / 1000000).toFixed(1) + ' million';
  } else if (num >= 10000 && num % 1000 === 0) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toLocaleString(); // Use toLocaleString to add commas for readability
}

Devvit.addCustomPostType({
  name: 'SubscriberGoal',
  height: 'tall',
  render: (context) => {
    const [refreshTrigger, setRefreshTrigger] = useState(0);
	const { data: subredditData, loading: subredditLoading, error: subredditError } = useAsync(() => fetchSubredditData(context), { depends: [refreshTrigger] });

	// Fetch all Redis data with hMGet
	const { data: redisData, loading: redisLoading, error: redisError } = useAsync(async () => {
	  const postId = context.postId;
	  const [goalValue, header, recentSubscriber] = await context.redis.hMGet('subscriber_goals', [
	    `${postId}_goal`, 
		`${postId}_header`,
		`${postId}_recent_subscriber`
	  ]) as [string | null, string | null, string | null];
	  return {
		goal: goalValue ? parseInt(goalValue, 10) : 2000,
		header: header ?? null,
		recentSubscriber: recentSubscriber ?? null
	  } as const;
	}, { depends: [context.postId] });
	// Establish all variables as constants to call throughout the rendered post
	const { goal = 2000, header = null, recentSubscriber = null } = redisData ?? { 
	  goal: 2000, 
	  header: null, 
	  recentSubscriber: null
	};
	
	// Loading screen after a user triggers a subscribe event or during Realtime post update
    if (subredditLoading || redisLoading) return (
      <blocks height="regular">
        <vstack height="100%" width="100%" gap="medium" alignment="center middle">

        </vstack>
      </blocks>
    );
    
	// Error screen if data load fails
    if (subredditError || redisError) return (
      <blocks height="regular">
        <vstack height="100%" width="100%" gap="medium" alignment="center middle">
          <text>Error: {(subredditError?.message || redisError?.message || 'Unknown error')}</text>
        </vstack>
      </blocks>
    );
	
	// Must be placed here because cannot access 'subredditData' before initialization
	const progress = Math.min(((subredditData?.numberOfSubscribers || 0) / (goal || 2000)) * 100, 100);
	// Constant for subscriber goal math
	const remainingSubscribers = Math.max((goal || 2000) - (subredditData?.numberOfSubscribers || 0), 0);
	// Define the custom Recent Subscriber message
	const [recentSubscriberMessage, setRecentSubscriberMessage] = useState('');
	
	// Realtime function to update the subscriber count as users click the button
	const channel = useChannel({
	  name: 'subscriber_updates',
	  onMessage: (data) => {
		if (data.newSubscriberCount || data.recentSubscriber) {
		  setRefreshTrigger(prev => prev + 1);
		  if (data.recentSubscriber) {
			setRecentSubscriberMessage(`${data.recentSubscriber} just subscribed!`);
		  }
		}
	  },
	});
	channel.subscribe();
	
	// The event handler function to subscribe users to the subreddit and update via Realtime
	const handleSubscribe = () => {
	  context.reddit.subscribeToCurrentSubreddit().then(async () => {
		context.ui.showToast('Thank you for subscribing!');
		
		const [currentUsername, updatedSubredditData] = await Promise.all([
		  context.reddit.getCurrentUsername(),
		  fetchSubredditData(context)
		]);
		
		await context.redis.hSet('subscriber_goals', { 
		  [`${context.postId}_recent_subscriber`]: currentUsername
		});
		
		setRecentSubscriberMessage(`${currentUsername} just subscribed!`);

		await channel.send({ 
		  newSubscriberCount: updatedSubredditData.numberOfSubscribers,
		  recentSubscriber: currentUsername
		});

	  }).catch(error => {
		console.error('Error in handleSubscribe:', error);
		context.ui.showToast('An error occurred while subscribing.');
	  });
	};

	// The returned block code that builds the actual Subscriber Goal post content
	return (
	  <blocks>
		<vstack height="100%" width="100%" gap="small" padding="medium" alignment="middle center" 
		lightBackgroundColor="" darkBackgroundColor="" >
		
		  // Goal Header text rendered as defined within the addMenuItem Form
          <text wrap size="xxlarge" weight="bold" width="100%" alignment="middle center" onPress={handleSubscribe}>
            {header || `Help r/${subredditData?.name || 'Subreddit'} reach ${formatNumberUnlessExact(goal)} members!`}
          </text>
		  
		  <spacer size="small" />
		  
		  // The subscriber goal rendered as a ratio between the true subscriber count / the Redis goal value
		  <text size="xlarge" weight="regular">
		    Goal: {formatNumberAlwaysRound(subredditData?.numberOfSubscribers || 0)} / {formatNumberUnlessExact(goal)} subscribers
		  </text>
		
		  // Progress Bar as colored vstack backgrounds with width as derived by Progress constant above
		  <vstack backgroundColor='global-white' cornerRadius='medium' borderWidth='thin' borderColor='black' width='70%'>
			<hstack backgroundColor='#D93A00' width={`${progress}%`}>
			  <spacer size='large' shape='square' />
			</hstack>
		  </vstack>
		  
		  // Subscribers required to reach the goal as derived by remainingSubscribers constant above
          <text size="xlarge" weight="regular">
            {remainingSubscribers === 0 
              ? "Subscriber goal reached!" 
              : `Only ${remainingSubscribers} more to reach the goal`}
          </text>
		  
		  // Most recent subscriber username rendered by Realtime as defined by constant above
		  {recentSubscriberMessage && (
		    <text size="xlarge" weight="regular">
			  {recentSubscriberMessage}
		    </text>
		  )}
		  
		  <spacer size="small" />
		  
		  // The actual large green subscriber button 
		  <button size="large" appearance="success" onPress={handleSubscribe}>
			Subscribe to r/{subredditData?.name || 'Subreddit'}
		  </button>
		  
		  // <spacer size="small" />
		  
		  // Link back to home subreddit r/SubGoal to qualify for Reddit Developer Funds
		  <button size="medium" appearance="bordered" 
            onPress={() => context.ui.navigateTo('https://www.reddit.com/r/SubGoal/')}>
			See other goals at r/SubGoal
		  </button>
		  
		</vstack>
	  </blocks>
	);
  },
});


// Creates the form to generate the Subscriber Goal
const createSubGoalForm = (defaultGoal, subredditName) => Devvit.createForm(
  {
    title: 'Create a New Sub Goal Post',
    description: '', 
    fields: [
      {
        name: 'title',
        label: 'Enter your Post Title:',
        defaultValue: `Welcome to r/${subredditName}!`,
        type: 'string',
        helpText: 'The actual title of the generated post', 
        required: true 
      },
      {
        name: 'header',
        label: 'Enter your Goal Header:',
        defaultValue: `Help r/${subredditName} reach ${formatNumberUnlessExact(defaultGoal)} members!`,
        type: 'string',
        helpText: 'The large header inside the post itself.', 
        required: true 
      },
      {
        name: 'subscriberGoal',
        label: 'Enter your Subscriber Goal',
        type: 'number',
        defaultValue: defaultGoal, 
        helpText: 'Default goal is based on your current subscriber count', 
        required: true 
      },
    ],
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
		  
	  // Schedule the job to announce the new subscriber goal in r/SubGoal
      await context.scheduler.runJob({
        name: 'announceSubscriberGoal',
        data: {
          postUrl: post.url, // Pass the URL of the newly created post
          subredditName: subreddit.name,
          goal: subscriberGoal,
        },
        runAt: new Date(), // Run immediately
      });
	  
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

// The scheduled job to announce a new goal in home subreddit r/SubGoal
Devvit.addSchedulerJob({
  name: 'announceSubscriberGoal',
  onRun: async (event, context) => {
    const { postUrl, subredditName, goal } = event.data!;
    const title = `Help r/${subredditName} reach ${formatNumberUnlessExact(goal)} members!`;

    try {
      await context.reddit.submitPost({
        subredditName: 'SubGoal',
        title: title,
        url: postUrl as string, // Use the URL of the newly created post
      });
      console.log(`Announced new subscriber goal for r/${subredditName}`);
    } catch (error: any) {
      console.error(`Error announcing subscriber goal: ${error.message}`);
    }
  },
});

// Commonly used Async function (might be the cause of form.0 errors?)
async function fetchSubredditData(context) {
  const subreddit = await context.reddit.getCurrentSubreddit();
  return {
    numberOfSubscribers: subreddit.numberOfSubscribers,
    name: subreddit.name
  };
}

// The menu item for moderators used to launch the form and generate a new Subscriber Goal
Devvit.addMenuItem({
  label: 'Create a New Sub Goal Post',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (event, context) => {
    try {
	  const subreddit = await context.reddit.getCurrentSubreddit();
      const subscriberCount = subreddit.numberOfSubscribers;
      const subredditName = subreddit.name;
      const defaultGoal = getDefaultSubscriberGoal(subscriberCount);
      const subGoalForm = createSubGoalForm(defaultGoal, subreddit.name);

      await context.ui.showForm(subGoalForm);
    } catch (error: any) {
      console.error(`Error fetching subscriber count: ${error.message}`);
      context.ui.showToast('Error fetching subreddit data.');
    }
  },
});

export default Devvit;
