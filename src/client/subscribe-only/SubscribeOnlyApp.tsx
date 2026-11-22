import { useEffect, useRef, useState } from "react";
import { prohibitedContentMessage } from "../../shared/contentPolicy";
import { getSubGoalPostMessages } from "../../shared/subGoalPostI18n";
import { goalJourneyAnalytics } from "../analytics/goalJourneyAnalytics";
import { SkeletonPage } from "../app/components/SkeletonPage";
import { tinySubscriptionConfirmationPhaseDurationMs } from "../app/components/TinySubscriptionConfirmation";
import { useCelebration } from "../app/hooks/useCelebration";
import { useNotificationSettings } from "../app/hooks/useNotificationSettings";
import { LoadedNotificationSettingsPage } from "../app/pages/NotificationSettingsPage";
import {
  selectSubscribeOnlyPhase,
  type TinySubscribeViewPhase,
} from "../app/viewSelection";
import { useSubGoal } from "../hooks/useSubGoal";
import { usePrimaryCtaPaintTiming } from "../utils/startupPerformance";
import { SubscribeOnlyFrame } from "./SubscribeOnlyFrame";
import { CompactCtaView, TinySubscribeView } from "./SubscribeOnlyView";
import { useTinyNotificationActions } from "./useTinyNotificationActions";
import { useTinySubscription } from "./useTinySubscription";

export const SubscribeOnlyApp = () => {
  const { state, loading, submitting, subscribe, prohibited } = useSubGoal();
  const [viewPhase, setViewPhase] =
    useState<TinySubscribeViewPhase>("subscribe");
  const readyReportedRef = useRef(false);
  const messages = getSubGoalPostMessages(state?.language);
  const notificationSettings = useNotificationSettings(
    viewPhase === "notifications",
    state?.language,
  );
  const celebration = useCelebration();
  usePrimaryCtaPaintTiming(
    !loading && !prohibited && state !== null,
    `${viewPhase}:${state?.postHeight ?? "loading"}`,
  );

  useEffect(() => {
    if (
      readyReportedRef.current ||
      loading ||
      prohibited ||
      state === null ||
      (state.postHeight !== "tiny" && state.postHeight !== "cta")
    ) {
      return;
    }
    readyReportedRef.current = true;
    goalJourneyAnalytics.appReady();
  }, [loading, prohibited, state]);

  useEffect(() => {
    if (viewPhase !== "confirmation") {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setViewPhase("subscribed");
    }, tinySubscriptionConfirmationPhaseDurationMs);
    return () => window.clearTimeout(timeoutId);
  }, [viewPhase]);
  const subscription = useTinySubscription({
    state: state?.postHeight === "tiny" ? state : undefined,
    subscribe,
    setViewPhase,
    triggerCelebration: celebration.triggerCelebration,
    messages,
  });
  const { openNotifications, returnFromNotifications, toggleNotifications } =
    useTinyNotificationActions(
      viewPhase,
      setViewPhase,
      state?.language,
      notificationSettings,
    );

  if (prohibited) {
    return (
      <div
        className="sg-goal-frame relative flex h-[100px] w-full items-center justify-center text-center text-sm"
        data-sg-theme={state?.colorTheme}
      >
        {prohibitedContentMessage}
      </div>
    );
  }

  if (loading || !state) {
    return <SkeletonPage postHeight="tiny" colorTheme={state?.colorTheme} />;
  }

  if (state.postHeight !== "tiny" && state.postHeight !== "cta") {
    return <SkeletonPage postHeight="tiny" colorTheme={state.colorTheme} />;
  }

  const notificationsPage = (
    <LoadedNotificationSettingsPage
      state={state}
      notificationSettings={notificationSettings}
      onToggle={toggleNotifications}
      onReturn={returnFromNotifications}
      onVisitPromoSub={() => undefined}
    />
  );
  if (state.postHeight === "cta") {
    const colorTheme =
      viewPhase === "notifications" ||
      state.afterSubscribeAction.type === "disabled"
        ? state.colorTheme
        : state.afterSubscribeAction.colorTheme;
    return (
      <SubscribeOnlyFrame
        state={state}
        colorTheme={colorTheme}
        viewPhase={viewPhase}
        celebration={celebration}
        onOpenNotifications={openNotifications}
        content={
          viewPhase === "notifications" ? (
            notificationsPage
          ) : (
            <CompactCtaView state={state} />
          )
        }
      />
    );
  }

  const effectiveViewPhase = selectSubscribeOnlyPhase(
    viewPhase,
    state.subscribed,
    subscription.interactionStarted,
  );
  const frameColorTheme =
    effectiveViewPhase === "subscribed" &&
    state.afterSubscribeAction.type !== "disabled"
      ? state.afterSubscribeAction.colorTheme
      : state.colorTheme;
  return (
    <SubscribeOnlyFrame
      state={state}
      colorTheme={frameColorTheme}
      viewPhase={viewPhase}
      celebration={celebration}
      onOpenNotifications={openNotifications}
      content={
        <TinySubscribeView
          state={state}
          effectiveViewPhase={effectiveViewPhase}
          notificationsPage={notificationsPage}
          onSubscribe={subscription.handleSubscribe}
          onOpenNotifications={openNotifications}
          submitting={submitting}
        />
      }
    />
  );
};
