import { useState } from "react";
import { prohibitedContentMessage } from "../../shared/contentPolicy";
import { getSubGoalPostMessages } from "../../shared/subGoalPostI18n";
import type { SubGoalState } from "../../shared/types/api";
import { useSubGoalLoading } from "./subGoal/useSubGoalLoading";
import { useSubGoalNotices } from "./subGoal/useSubGoalNotices";
import { useSubGoalRealtime } from "./subGoal/useSubGoalRealtime";
import { useSubGoalRefresh } from "./subGoal/useSubGoalRefresh";
import { useSubGoalSubscription } from "./subGoal/useSubGoalSubscription";

export { isSubGoalState } from "./subGoal/stateValidation";
export {
  reconcileSubscriptionStatus,
  requestSubscribeJson,
} from "./subGoal/subscriptionRequests";

export const useSubGoal = () => {
  const [state, setState] = useState<SubGoalState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prohibited = error === prohibitedContentMessage;
  const messages = getSubGoalPostMessages(state?.language);
  const { notice, showNotice, announceSubscriber } = useSubGoalNotices(
    state,
    messages,
  );
  const { submitting, subscribe } = useSubGoalSubscription({
    language: state?.language,
    uncertainToast: messages.subscribeUncertainToast,
    setState,
    setError,
  });
  const loading = useSubGoalLoading({
    state,
    setState,
    setError,
    prohibited,
    loadError: messages.loadError,
  });
  useSubGoalRealtime(state?.postHeight, announceSubscriber, setState);
  const refresh = useSubGoalRefresh({
    postHeight: state?.postHeight,
    language: state?.language,
    loadError: messages.loadError,
    setState,
    setError,
  });

  return {
    state,
    loading,
    submitting,
    error,
    refresh,
    subscribe,
    setError,
    notice,
    showNotice,
    prohibited,
  } as const;
};
