import { getAutomaticAfterSubscribeAction } from "../../../shared/afterSubscribeAction";
import type { CtaOnlyState, SubGoalState } from "../../../shared/types/api";
import { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";

import type { SubscriptionButtonMode } from "../components/SubscriptionButton";

type GoalPageState = Exclude<SubGoalState, CtaOnlyState>;

export const getSubscriptionAction = (
  state: GoalPageState,
  isSubmitting: boolean,
) => {
  const messages = getSubGoalPostMessages(state.language);
  const afterSubscribeAction =
    state.subscribed && state.afterSubscribeAction.type !== "disabled"
      ? state.afterSubscribeAction
      : null;
  const buttonMode: SubscriptionButtonMode = isSubmitting
    ? "submitting"
    : afterSubscribeAction
      ? "link"
      : state.subscribed
        ? "subscribed"
        : "subscribe";
  const authenticated =
    state.postHeight === "tiny" ? state.authenticated : Boolean(state.user);
  const showAuthenticationButtons =
    !authenticated && !state.subscribed && !isSubmitting;
  const buttonLabel = afterSubscribeAction
    ? afterSubscribeAction.buttonText
    : state.subscribed
      ? messages.subscribedButton({ subredditName: state.subreddit.name })
      : messages.subscribeButton({ subredditName: state.subreddit.name });
  return {
    afterSubscribeAction,
    buttonMode,
    showAuthenticationButtons,
    buttonLabel,
    authenticated,
  };
};

export const getSecondaryActions = (
  state: Exclude<GoalPageState, { postHeight: "tiny" }>,
  authenticated: boolean,
  isSubmitting: boolean,
) => {
  const automaticAction =
    state.subscribed &&
    authenticated &&
    !isSubmitting &&
    state.completedTime === null
      ? state.automaticAfterSubscribeAction === undefined
        ? getAutomaticAfterSubscribeAction(
            state.afterSubscribeAction,
            state.language,
          )
        : state.automaticAfterSubscribeAction
      : null;
  const secondaryAction =
    (!state.subscribed || automaticAction) &&
    state.afterSubscribeAction.type !== "disabled"
      ? state.afterSubscribeAction
      : null;
  return { automaticAction, secondaryAction };
};
