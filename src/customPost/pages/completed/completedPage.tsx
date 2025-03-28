import {Devvit} from '@devvit/public-api';

import {formatNumberUnlessExact} from '../../../utils/formatNumbers.js';
import {LoadingElement} from '../../components/loadingElement.js';
import {TopButton} from '../../components/topButtons.js';
import {PageElement} from '../../router.js';

export const CompletedPage: PageElement = router => {
  const state = router.PageStates.subGoal; // Piggybacking off of subGoal state, so we don't need to refetch data
  const locale = state.context.uiEnvironment?.locale ?? 'en';
  const timeZone = state.context.uiEnvironment?.timezone ?? 'UTC';
  return (
    <zstack alignment="center middle" height="100%" width="100%">
      {state.appSettings && <TopButton hideNotify={true} onNotifyPressed={state.notifyPressed} onVisitPromoSubPressed={state.visitPromoSubPressed}/>}
      <vstack alignment="middle center" gap="medium" height="100%" padding="medium" width="100%">
        <hstack alignment="center middle" backgroundColor="" cornerRadius="full" height="100px" width="100px">
          <LoadingElement name="load-fill" size="large">
            {state.subreddit.icon && <image imageHeight={100} imageWidth={100} onPress={state.subscribePressed} url={state.subreddit.icon} />}
          </LoadingElement>
        </hstack>
        <LoadingElement name="load-fill" size="large">
          {state.subreddit.name && state.goal !== null && <text alignment="middle center" onPress={state.subscribePressed} selectable={false} size="xxlarge" weight="bold" width="100%" wrap>r/{state.subreddit.name} reached {formatNumberUnlessExact(state.goal)} subscribers!</text>}
        </LoadingElement>
        <text alignment="middle center" size="xlarge" weight="bold" width="100%" wrap>
          {state.completedTime ? `Goal reached at ${state.completedTime.toLocaleTimeString(locale, {timeZone})} on ${state.completedTime.toLocaleDateString(locale, {timeZone})}` : 'Goal reached just now!'}
        </text>
        <button appearance="success" onPress={() => router.context.ui.showToast('🎆🎉🎉🎊🎉🎊🎉🎆')} size="large">
        Celebrate
        </button>
      </vstack>
    </zstack>
  );
};
