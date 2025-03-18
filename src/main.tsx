import { addMenuItem } from './addMenuItem.js';
import { createSubGoalForm } from './createSubGoalForm.js';
import { getDefaultSubscriberGoal } from './defaultSubscriberGoal.js';
import { formatNumberAlwaysRound, formatNumberUnlessExact } from './utils.js';


import { Devvit, useState, useAsync, useChannel } from '@devvit/public-api';
Devvit.configure({ redditAPI: true, redis: true, media: true, realtime: true });

// Define our realtime message type
interface SubscriberMessage {
  newSubscriberCount: number;
  recentSubscriber: string;
}

// Main App Component
Devvit.addCustomPostType({
  name: 'SubscriberGoal',
  height: 'tall',
  render: (context) => {
    const [refreshTrigger, setRefreshTrigger] = useState(0);
    const [recentSubscriberMessage, setRecentSubscriberMessage] = useState('');
    const [realtimeConnected, setRealtimeConnected] = useState(false);
    const [pendingRealtimeMessage, setPendingRealtimeMessage] = useState<SubscriberMessage | null>(null);
  
    const { data: subredditData, loading: subredditLoading, error: subredditError } = useAsync(
      async () => {
        const subreddit = await context.reddit.getCurrentSubreddit();
        return {
          numberOfSubscribers: subreddit.numberOfSubscribers,
          name: subreddit.name
        };
      }, 
      { depends: [refreshTrigger] }
    );

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
        recentSubscriber: recentSubscriber ?? "No recent subscribers"
      } as const;
    }, { depends: context.postId ? [context.postId] : [] });

    const subscriberCount = subredditData?.numberOfSubscribers || 0;
    const { goal = 2000, header = null, recentSubscriber = "No recent subscribers" } = redisData ?? { 
      goal: 2000, 
      header: null, 
      recentSubscriber: "No recent subscribers"
    };
    
    // Must be placed here because cannot access 'subredditData' before initialization
    const progress = Math.min(((subredditData?.numberOfSubscribers || 0) / (goal || 2000)) * 100, 100);
    // Constant for subscriber goal math
    const remainingSubscribers = Math.max((goal || 2000) - (subredditData?.numberOfSubscribers || 0), 0);

    // Realtime function to update the subscriber count as users click the button
    const channel = useChannel({
      name: 'subscriber_updates',
      onMessage: (data) => {
        if (
          typeof data === 'object' &&
          data !== null &&
          'newSubscriberCount' in data &&
          typeof data.newSubscriberCount === 'number'
        ) {
          setRefreshTrigger(prev => prev + 1);
          if ('recentSubscriber' in data && typeof data.recentSubscriber === 'string') {
            setRecentSubscriberMessage(`${data.recentSubscriber} just subscribed!`);
          }
        } else {
          console.warn('Unexpected realtime message:', data);
        }
      },
      onSubscribed: async () => {
        console.log("Realtime channel connected");
        setRealtimeConnected(true);
        
        // If we have a pending message, send it now that we're connected
        if (pendingRealtimeMessage) {
          try {
            await channel.send(pendingRealtimeMessage);
            console.log("Sent pending realtime message after reconnection");
            setPendingRealtimeMessage(null);
          } catch (error) {
            console.error("Failed to send pending message:", error);
          }
        }
      },
      onUnsubscribed: () => {
        console.log("Realtime channel disconnected");
        setRealtimeConnected(false);
      }
    });

    channel.subscribe();    
  
    const handleSubscribe = async () => {
      try {
        await context.reddit.subscribeToCurrentSubreddit();
        context.ui.showToast('Thank you for subscribing!');
        
        const currentUsername = await context.reddit.getCurrentUsername();
        
        // Immediately increment subscriber count optimistically
        setRefreshTrigger(prev => prev + 1);
        setRecentSubscriberMessage(`${currentUsername} just subscribed!`);
        
        // Update Redis with recent subscriber
        await context.redis.hSet('subscriber_goals', { 
          [`${context.postId}_recent_subscriber`]: currentUsername!
        });
        
        // Create the message object
        const message: SubscriberMessage = {
          newSubscriberCount: subscriberCount + 1,  // Optimistic increment
          recentSubscriber: currentUsername!
        };
        
        // Send message if connected, otherwise store as pending
        if (realtimeConnected) {
          await channel.send(message);
          console.log("Sent realtime subscription update");
        } else {
          console.log("Realtime not connected, storing message as pending");
          setPendingRealtimeMessage(message);
          context.ui.showToast('Your subscription was recorded! Updates will sync when connection is restored.');
        }
      } catch (error) {
        console.error('Subscription failed:', error);
        context.ui.showToast('Subscription failed. Try again.');
      }
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
		    Goal: {formatNumberAlwaysRound(subscriberCount || 1)} / {formatNumberUnlessExact(goal)} subscribers
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

// Imported from the file addMenuItem.tsx
addMenuItem();

export default Devvit;
