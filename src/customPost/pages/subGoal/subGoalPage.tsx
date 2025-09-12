/**
 * @file This is the primary view for Subscriber Goal posts.
 * It displays the goal, progress bar, and a call to action to subscribe.
 */

import {Devvit} from '@devvit/public-api';

import {LoadingElement} from '../../components/loadingElement.js';
import {ProgressBar} from '../../components/progressBar.js';
import {SubredditIcon} from '../../components/subredditIcon.js';
import {TopButton} from '../../components/topButtons.js';
import {PageElement} from '../../router.js';

export const SubGoalPage: PageElement = router => {
  const state = router.PageStates.subGoal; // This is where basically everything to do with the custom post happens.
  return (
    <zstack alignment="center middle" height="100%" width="100%">
      {state.appSettings && <TopButton onNotifyPressed={state.notifyPressed} onVisitPromoSubPressed={state.visitPromoSubPressed}/>}
      <vstack alignment="center middle" gap="medium" height="100%" padding="medium" width="100%">
        <spacer size='xsmall' />
        <SubredditIcon iconUrl={state.subreddit.icon} imageHeight={100} imageWidth={100} onPress={state.subscribePressed} />
        <hstack alignment="center middle" gap='none' padding='none'>
          <text alignment="center middle" onPress={state.subscribePressed} size="xlarge" weight="bold" wrap>
          &nbsp;Welcome to r/
          </text>
          <LoadingElement name="load-fill" size="large">
            {state.subreddit.name && <text alignment="center middle" onPress={state.subscribePressed} selectable={false} size="xlarge" weight="bold" wrap>{state.subreddit.name}&nbsp;</text>}
          </LoadingElement>
        </hstack>
        <ProgressBar current={state.subscribers} end={state.goal ?? undefined} showText={true} start={0} width={'70%'} />
        <button appearance="success" disabled={state.subscribed} onPress={state.subscribePressed} size="large">
        &nbsp;Subscribe{state.subscribed ? 'd' : ''} to r/{state.subreddit.name}&nbsp;
        </button>
        {state.recentSubscriber ? (
          <text alignment="top center" selectable={false} size="medium" weight="regular" wrap>
            {`u/${state.recentSubscriber} just subscribed!`}
          </text>
        ) : <text size="medium"/>}
        <spacer size='small' />
      </vstack>
    </zstack>
  );
};
