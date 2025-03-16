import { Devvit } from '@devvit/public-api';
import { getDefaultSubscriberGoal } from './defaultSubscriberGoal.js';
import { createSubGoalForm } from './createSubGoalForm.js';

// The menu item for moderators used to launch the form and generate a new Subscriber Goal
function addMenuItem() {
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

        await context.ui.showForm(createSubGoalForm, {
          subredditName,
          defaultGoal,
        });
      } catch (error: any) {
        console.error(`Error fetching subscriber count: ${error.message}`);
        context.ui.showToast('Error fetching subreddit data.');
      }
    },
  });
}

export { addMenuItem };