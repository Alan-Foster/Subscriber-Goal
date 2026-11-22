import { useEffect, useRef, useState } from "react";
import { getSubGoalPostMessages } from "../../shared/subGoalPostI18n";
import { goalJourneyAnalytics } from "../analytics/goalJourneyAnalytics";
import { useSubGoal } from "../hooks/useSubGoal";
import { usePrimaryCtaPaintTiming } from "../utils/startupPerformance";
import { GoalAppFrame } from "./GoalAppFrame";
import { GoalAppView } from "./GoalAppView";
import { SkeletonPage } from "./components/SkeletonPage";
import { tinySubscriptionConfirmationPhaseDurationMs } from "./components/TinySubscriptionConfirmation";
import { useCelebration } from "./hooks/useCelebration";
import { useGoalAppSubscription } from "./hooks/useGoalAppSubscription";
import {
  getGoalLinkActions,
  useGoalPageActions,
} from "./hooks/useGoalPageActions";
import { useNotificationSettings } from "./hooks/useNotificationSettings";
import { selectGoalView, type PageName } from "./viewSelection";

export const App = () => {
  const {
    state,
    loading,
    submitting,
    subscribe,
    notice,
    showNotice,
    prohibited,
  } = useSubGoal();
  const [page, setPage] = useState<PageName>("subGoal");
  const celebration = useCelebration();
  const [shareUsername, setShareUsername] = useState(true);
  const messages = getSubGoalPostMessages(state?.language);
  const notificationSettings = useNotificationSettings(
    page === "notifications",
    state?.language,
  );
  const readyReportedRef = useRef(false);
  usePrimaryCtaPaintTiming(
    !loading && !prohibited && state !== null,
    `${page}:${state?.postHeight ?? "loading"}`,
  );

  useEffect(() => {
    if (readyReportedRef.current || loading || prohibited || state === null) {
      return;
    }
    readyReportedRef.current = true;
    goalJourneyAnalytics.appReady();
  }, [loading, prohibited, state]);

  useEffect(() => {
    if (
      state &&
      state.postHeight !== "tiny" &&
      state.postHeight !== "cta" &&
      state.subreddit.isNsfw
    ) {
      setShareUsername(false);
    }
  }, [state]);

  useEffect(() => {
    if (
      state &&
      state.postHeight !== "tiny" &&
      state.postHeight !== "cta" &&
      state.completedTime
    ) {
      setPage("completed");
    }
  }, [state]);

  useEffect(() => {
    if (page !== "tinyConfirmation") {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setPage("subGoal");
    }, tinySubscriptionConfirmationPhaseDurationMs);
    return () => window.clearTimeout(timeoutId);
  }, [page]);
  const subscription = useGoalAppSubscription({
    state,
    subscribe,
    messages,
    shareUsername,
    setPage,
    page,
    showNotice,
    triggerCelebration: celebration.triggerCelebration,
  });
  const actions = useGoalPageActions({
    page,
    setPage,
    state,
    shareUsername,
    showNotice,
    notificationSettings,
  });
  const links = getGoalLinkActions(state);

  if (loading)
    return (
      <SkeletonPage
        postHeight={state?.postHeight}
        colorTheme={state?.colorTheme}
      />
    );
  const view = selectGoalView(page, state);
  return (
    <GoalAppFrame
      state={state}
      page={page}
      prohibited={prohibited}
      loadError={messages.loadError}
      celebration={celebration}
      onOpenNotifications={actions.handleOpenNotifications}
      content={
        view ? (
          <GoalAppView
            view={view}
            notificationSettings={notificationSettings}
            showModeratorInstallPromo={subscription.showModeratorInstallPromo}
            submitting={submitting}
            shareUsername={shareUsername}
            notice={notice}
            onSubscribe={subscription.handleSubscribe}
            onShareUsernameChange={setShareUsername}
            onReturnToSubGoal={actions.handleReturnToSubGoal}
            onOpenNotifications={actions.handleOpenNotifications}
            onReturnFromNotifications={actions.handleReturnFromNotifications}
            onToggleNotifications={actions.handleToggleNotifications}
            onNotificationOptIn={actions.handleNotificationOptIn}
            onOpenStatistics={actions.handleOpenStatistics}
            onReturnFromStatistics={actions.handleReturnFromStatistics}
            onVisitPromo={links.handleVisitPromo}
            onAfterSubscribeNavigate={links.handleAfterSubscribeNavigate}
            onModeratorInstall={links.handleModeratorInstall}
          />
        ) : null
      }
    />
  );
};
