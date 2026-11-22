import { navigateTo, showToast } from "@devvit/web/client";
import { useCallback, useEffect, useRef } from "react";
import type { NavigationTarget, SubGoalState } from "../../../shared/types/api";
import { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";
import { getNotificationMessages } from "../../../shared/notificationI18n";
import {
  getGoalJourneyContext,
  goalJourneyAnalytics,
} from "../../analytics/goalJourneyAnalytics";
import { logDiagnostic } from "../../../shared/diagnostics";
import { tinySubscriptionConfirmationPhaseDurationMs } from "../components/TinySubscriptionConfirmation";
import { NOTIFICATION_SETTINGS_ENTRY_ENABLED } from "../notificationFeatureFlags";
import type { PageName } from "../viewSelection";
import type { useNotificationSettings } from "./useNotificationSettings";

const subscriberGoalInstallUrl =
  "https://developers.reddit.com/apps/subscriber-goal";

export function getGoalLinkActions(state: SubGoalState | null) {
  const promoSubreddit =
    state?.postHeight !== "tiny" && state?.postHeight !== "cta"
      ? state?.appSettings.promoSubreddit
      : undefined;
  const handleVisitPromo = () => {
    if (!promoSubreddit || !state) {
      return;
    }
    goalJourneyAnalytics.promoSubgoalActivated(getGoalJourneyContext(state));
    navigateTo(`https://www.reddit.com/r/${promoSubreddit}/`);
  };
  const handleModeratorInstall = () => {
    if (!state || state.postHeight === "tiny" || state.postHeight === "cta") {
      return;
    }
    const analyticsContext = getGoalJourneyContext(state);
    goalJourneyAnalytics.moderatorInstallPromoActivated(analyticsContext);
    logDiagnostic("info", "moderator_install_promo_activated", {
      workflow: "moderator_install_promo",
      phase: "navigation",
      postHeight: state.postHeight,
    });
    navigateTo(subscriberGoalInstallUrl);
  };
  const handleAfterSubscribeNavigate = (target: string | NavigationTarget) => {
    navigateTo(target);
  };
  return {
    handleVisitPromo,
    handleModeratorInstall,
    handleAfterSubscribeNavigate,
  };
}

export function useGoalPageActions({
  page,
  setPage,
  state,
  shareUsername,
  showNotice,
  notificationSettings,
}: {
  page: PageName;
  setPage: (page: PageName) => void;
  state: SubGoalState | null;
  shareUsername: boolean;
  showNotice: (notice: string) => void;
  notificationSettings: ReturnType<typeof useNotificationSettings>;
}) {
  const previousPageRef = useRef<Exclude<PageName, "notifications">>("subGoal");
  const returnNoticeTimeoutRef = useRef<number | null>(null);
  const notificationMessages = getNotificationMessages(state?.language);
  useEffect(
    () => () => {
      if (returnNoticeTimeoutRef.current) {
        window.clearTimeout(returnNoticeTimeoutRef.current);
      }
    },
    [],
  );
  const handleOpenNotifications = () => {
    if (!NOTIFICATION_SETTINGS_ENTRY_ENABLED) {
      return;
    }
    if (page !== "notifications") {
      previousPageRef.current = page;
      setPage("notifications");
    }
  };
  const handleOpenStatistics = () => {
    if (
      state?.postHeight !== "tiny" &&
      state?.postHeight !== "cta" &&
      state?.canViewStatistics
    ) {
      setPage("statistics");
    }
  };
  const handleReturnFromStatistics = () => setPage("subGoal");
  const handleReturnFromNotifications = () => {
    setPage(previousPageRef.current);
  };
  const updateNotifications = async (
    enabled: boolean,
    showSuccessToast = true,
  ): Promise<boolean> => {
    const updated = await notificationSettings.update(enabled);
    if (!updated) {
      showToast(notificationMessages.updateError);
      return false;
    }
    if (showSuccessToast) {
      showToast({
        text: enabled
          ? notificationMessages.enabledToast
          : notificationMessages.disabledToast,
        appearance: "success",
      });
    }
    return true;
  };
  const handleToggleNotifications = (enabled: boolean) => {
    void updateNotifications(enabled);
  };
  const handleNotificationOptIn = async (): Promise<boolean> => {
    if (!NOTIFICATION_SETTINGS_ENTRY_ENABLED) {
      return false;
    }
    const updated = await updateNotifications(true, false);
    if (updated) {
      setPage("notificationConfirmation");
    }
    return updated;
  };
  const handleReturnToSubGoal = useCallback(() => {
    if (!state || state.postHeight === "tiny" || state.postHeight === "cta") {
      return;
    }
    setPage("subGoal");
    if (returnNoticeTimeoutRef.current) {
      window.clearTimeout(returnNoticeTimeoutRef.current);
    }
    const effectiveShareUsername = state.subreddit.isNsfw
      ? false
      : shareUsername;
    const username = effectiveShareUsername
      ? (state.user?.username ?? null)
      : null;
    const message = getSubGoalPostMessages(state.language).subscriberNotice({
      username,
    });
    returnNoticeTimeoutRef.current = window.setTimeout(() => {
      showNotice(message);
    }, 80);
  }, [setPage, shareUsername, showNotice, state]);

  useEffect(() => {
    if (page !== "notificationConfirmation") {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      handleReturnToSubGoal();
    }, tinySubscriptionConfirmationPhaseDurationMs);
    return () => window.clearTimeout(timeoutId);
  }, [handleReturnToSubGoal, page]);
  return {
    handleOpenNotifications,
    handleReturnFromNotifications,
    handleOpenStatistics,
    handleReturnFromStatistics,
    handleToggleNotifications,
    handleNotificationOptIn,
    handleReturnToSubGoal,
  };
}
