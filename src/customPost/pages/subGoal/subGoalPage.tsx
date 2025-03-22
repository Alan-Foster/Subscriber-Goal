import {Devvit} from '@devvit/public-api';

import {formatNumberAlwaysRound, formatNumberUnlessExact} from '../../../utils/formatNumbers.js';
import {ProgressBar} from '../../components/progressBar.js';
import {PageElement} from '../../router.js';
import {SubGoalState} from './subGoalState.js';

export const SubGoalPage: PageElement = (context, router) => {
  const state = new SubGoalState(context, router);
  return (
    <vstack alignment="middle center" gap="small" height="100%" padding="medium" width="100%">
      <text alignment="middle center" onPress={state.subscribePressed} size="xxlarge" weight="bold" width="100%" wrap>
        {state.header}
      </text>
      <spacer size="small" />
      <text size="xlarge" weight="regular">
           Goal: {formatNumberAlwaysRound(state.subreddit.subscribers || 1)} / {formatNumberUnlessExact(state.goal)} subscribers
      </text>
      <ProgressBar current={state.subreddit.subscribers} end={state.goal} start={0} width={'70%'} />
      <text size="xlarge" weight="regular">
        {state.goalRemaining <= 0 ? 'Subscriber goal reached!'
          : `Only ${state.goalRemaining} more to reach the goal`}
      </text>
      {state.recentSubscriber && (
        <text size="xlarge" weight="regular">
          {`${state.recentSubscriber} just subscribed!`}
        </text>
      )}
      <spacer size="small" />
      <button appearance="success" onPress={state.subscribePressed} size="large">
         Subscribe to r/{state.subreddit.name}
      </button>
      <spacer size="small" />
      <button appearance="bordered" onPress={state.seeMorePressed} size="medium">
         See other goals at r/SubGoal
      </button>
    </vstack>
  );
};
