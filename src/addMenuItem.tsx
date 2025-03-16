import {Devvit} from '@devvit/public-api';

import {createSubGoalForm} from './createSubGoalForm.js';
import {getDefaultSubscriberGoal} from './defaultSubscriberGoal.js';

// The menu item for moderators used to launch the form and generate a new Subscriber Goal
function addMenuItem () {
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

        context.ui.showForm(createSubGoalForm, {
          subredditName,
          defaultGoal,
        });
      } catch (error: unknown) {
        console.error(`Error fetching subscriber count: ${error instanceof Error ? error.message : String(error)}`);
        context.ui.showToast('Error fetching subreddit data.');
      }
    },
  });
}

export {addMenuItem};
