/**
 * @file The ThanksPage is shown after a user clicks the subscribe button on the sub goal post. It does not have its own state, instead it grabs data from the main SubGoalPage state.
 */

import {Devvit} from '@devvit/public-api';

import {formatNumberUnlessExact} from '../../../utils/numberUtils.js';
import {LoadingElement} from '../../components/loadingElement.js';
import {TopButtons} from '../../components/topButtons.js';
import {PageElement} from '../../router.js';

export const ThanksPage: PageElement = router => {
  const state = router.PageStates.subGoal; // Piggybacking off of subGoal state, so we don't need to refetch data
  return (
    <zstack alignment="center middle" height="100%" width="100%">
      {state.appSettings && <TopButtons onNotifyPressed={state.notifyPressed} onVisitPromoSubPressed={state.visitPromoSubPressed}/>}
      <vstack alignment="middle center" gap="medium" height="100%" padding="medium" width="100%">
        <hstack alignment="center middle" backgroundColor="" cornerRadius="full" height="100px" width="100px">
          <LoadingElement name="load-fill" size="large">
            {state.subreddit.icon && <image imageHeight={100} imageWidth={100} onPress={state.subscribePressed} url={state.subreddit.icon} />}
          </LoadingElement>
        </hstack>
        <text alignment="middle center" size="xxlarge" weight="bold" wrap>
        Thanks for Subscribing!
        </text>
        <text alignment="middle center" size="xlarge" weight="bold" width="100%" wrap>
        There are now {formatNumberUnlessExact(state.subscribers)} subscribers in the community!
        </text>
        <button appearance="plain" onPress={() => router.changePage('subGoal')} size="large">
        Return to Previous Page
        </button>
      </vstack>
    </zstack>
  );
};
