import {Devvit} from '@devvit/public-api';

import {formatNumberUnlessExact} from '../../../utils/formatNumbers.js';
import {LoadingElement} from '../../components/loadingElement.js';
import {ProgressBar} from '../../components/progressBar.js';
import {SubredditIcon} from '../../components/subredditIcon.js';
import {PageElement} from '../../router.js';

export const SubGoalPage: PageElement = router => {
  const state = router.PageStates.subGoal;
  return (
    <vstack alignment="center middle" gap="medium" height="100%" padding="medium" width="100%">
      <spacer size='xsmall' />
      <SubredditIcon iconUrl={state.subreddit.icon} imageHeight={100} imageWidth={100} onPress={state.subscribePressed} />
      <hstack alignment="center middle" gap='none' padding='none'>
        <text alignment="center middle" onPress={state.subscribePressed} size="xlarge" weight="bold" wrap>
          Welcome to r/
        </text>
        <LoadingElement name="load-fill" size="large">
          {state.subreddit.name && <text alignment="center middle" onPress={state.subscribePressed} selectable={false} size="xlarge" weight="bold" wrap>{state.subreddit.name}</text>}
        </LoadingElement>
      </hstack>
      <zstack alignment="center middle" width={'70%'}>
        <ProgressBar current={state.subscribers} end={state.goal ?? 100} start={0} width={'100%'} />
        <LoadingElement name="load-fill" size="medium">
          {state.goalRemaining !== null && state.goal !== null && <text alignment="center middle" selectable={false} size="medium" weight="bold" wrap>{state.subscribers} / {formatNumberUnlessExact(state.goal)}</text>}
        </LoadingElement>
      </zstack>
      <button appearance="success" disabled={state.subscribed} onPress={state.subscribePressed} size="large">
         Subscribe{state.subscribed ? 'd' : ''} to r/{state.subreddit.name}
      </button>
      {state.recentSubscriber ? (
        <text alignment="top center" selectable={false} size="medium" weight="regular" wrap>
          {`u/${state.recentSubscriber} just subscribed!`}
        </text>
      ) : <text size="medium"/>}
      <spacer size='small' />
    </vstack>
  );
};
