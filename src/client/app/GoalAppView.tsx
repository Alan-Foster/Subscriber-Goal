import type { NavigationTarget } from "../../shared/types/api";
import { getGoalJourneyContext } from "../analytics/goalJourneyAnalytics";
import { AfterSubscribeButton } from "./components/AfterSubscribeButton";
import { TinyActionLayout } from "./components/TinyActionLayout";
import { TinySubscriptionConfirmation } from "./components/TinySubscriptionConfirmation";
import type { useNotificationSettings } from "./hooks/useNotificationSettings";
import { NOTIFICATION_SETTINGS_ENTRY_ENABLED } from "./notificationFeatureFlags";
import { CompletedPage } from "./pages/CompletedPage";
import { NotificationConfirmationPage } from "./pages/NotificationConfirmationPage";
import { LoadedNotificationSettingsPage } from "./pages/NotificationSettingsPage";
import { StatisticsPage } from "./pages/StatisticsPage";
import { SubGoalPage } from "./pages/SubGoalPage";
import { ThanksPage } from "./pages/ThanksPage";
import type { selectGoalView } from "./viewSelection";

type Props = {
  view: NonNullable<ReturnType<typeof selectGoalView>>;
  notificationSettings: ReturnType<typeof useNotificationSettings>;
  showModeratorInstallPromo: boolean;
  submitting: boolean;
  shareUsername: boolean;
  notice: string | null;
  onSubscribe: () => void;
  onShareUsernameChange: (enabled: boolean) => void;
  onReturnToSubGoal: () => void;
  onVisitPromo: () => void;
  onAfterSubscribeNavigate: (target: string | NavigationTarget) => void;
  onOpenNotifications: () => void;
  onReturnFromNotifications: () => void;
  onToggleNotifications: (enabled: boolean) => void;
  onNotificationOptIn: () => Promise<boolean>;
  onOpenStatistics: () => void;
  onReturnFromStatistics: () => void;
  onModeratorInstall: () => void;
};

export function GoalAppView({ view, ...props }: Props) {
  const { page, state } = view;
  const statisticsAction =
    (state.postHeight === "regular" || state.postHeight === "short") &&
    state.canViewStatistics
      ? { onStatistics: props.onOpenStatistics }
      : {};
  switch (page) {
    case "statistics":
      return (
        <StatisticsPage
          onReturn={props.onReturnFromStatistics}
          language={state.language}
        />
      );
    case "notifications":
      return (
        <LoadedNotificationSettingsPage
          state={state}
          notificationSettings={props.notificationSettings}
          onToggle={props.onToggleNotifications}
          onReturn={props.onReturnFromNotifications}
          onVisitPromoSub={props.onVisitPromo}
        />
      );
    case "cta":
      return (
        <div className="relative flex h-full w-full items-center justify-center px-4 py-3 text-center">
          <TinyActionLayout state={state} showCtaActivity>
            <AfterSubscribeButton
              action={view.action}
              analyticsContext={getGoalJourneyContext(state)}
              language={state.language}
              onNavigate={props.onAfterSubscribeNavigate}
              trackClicks={state.trackCtaClicks === true}
            />
          </TinyActionLayout>
        </div>
      );
    case "tinyConfirmation":
      return (
        <TinySubscriptionConfirmation
          language={state.language}
          subredditName={state.subreddit.name}
        />
      );
    case "thanks":
      return (
        <ThanksPage
          state={state}
          onReturn={props.onReturnToSubGoal}
          onVisitPromoSub={props.onVisitPromo}
          onAfterSubscribeNavigate={props.onAfterSubscribeNavigate}
          notificationOptInEnabled={NOTIFICATION_SETTINGS_ENTRY_ENABLED}
          notificationSubmitting={props.notificationSettings.submitting}
          notificationError={props.notificationSettings.error}
          onNotificationOptIn={props.onNotificationOptIn}
          showModeratorInstallPromo={props.showModeratorInstallPromo}
          onModeratorInstall={props.onModeratorInstall}
          {...statisticsAction}
        />
      );
    case "notificationConfirmation":
      return (
        <NotificationConfirmationPage
          state={state}
          onVisitPromoSub={props.onVisitPromo}
        />
      );
    case "completed":
      return (
        <CompletedPage
          state={state}
          onVisitPromoSub={props.onVisitPromo}
          onNotifications={props.onOpenNotifications}
        />
      );
    case "subGoal":
      return (
        <SubGoalPage
          state={state}
          onSubscribe={props.onSubscribe}
          onVisitPromoSub={props.onVisitPromo}
          isSubmitting={props.submitting}
          shareUsername={props.shareUsername}
          onShareUsernameChange={props.onShareUsernameChange}
          notice={props.notice}
          onAfterSubscribeNavigate={props.onAfterSubscribeNavigate}
          onNotifications={props.onOpenNotifications}
          {...statisticsAction}
        />
      );
  }
}
