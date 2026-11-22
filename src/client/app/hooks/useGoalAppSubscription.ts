import { showLoginPrompt, showToast } from "@devvit/web/client";
import { useEffect, useRef, useState } from "react";
import type { SubGoalState } from "../../../shared/types/api";
import type { getSubGoalPostMessages } from "../../../shared/subGoalPostI18n";
import type { useSubGoal } from "../../hooks/useSubGoal";
import {
  getGoalJourneyContext,
  goalJourneyAnalytics,
} from "../../analytics/goalJourneyAnalytics";
import { logDiagnostic } from "../../../shared/diagnostics";
import { recordStatisticsEvent } from "../../analytics/statisticsAnalytics";
import { confettiPresets } from "../confettiPresets";
import type { useCelebration } from "./useCelebration";
import type { PageName } from "../viewSelection";

export function useGoalAppSubscription({
  state,
  subscribe,
  messages,
  shareUsername,
  setPage,
  page,
  showNotice,
  triggerCelebration,
}: {
  state: SubGoalState | null;
  subscribe: ReturnType<typeof useSubGoal>["subscribe"];
  messages: ReturnType<typeof getSubGoalPostMessages>;
  shareUsername: boolean;
  setPage: (page: PageName) => void;
  page: PageName;
  showNotice: (notice: string) => void;
  triggerCelebration: ReturnType<typeof useCelebration>["triggerCelebration"];
}) {
  const subscribeAttemptRef = useRef(false);
  const [showModeratorInstallPromo, setShowModeratorInstallPromo] =
    useState(false);
  const moderatorPromoViewedRef = useRef(false);
  const performSubscribe = async () => {
    if (!state || state.postHeight === "cta" || subscribeAttemptRef.current) {
      return;
    }
    subscribeAttemptRef.current = true;
    const activationId = recordStatisticsEvent("join_click");
    const authenticated =
      state.postHeight === "tiny" ? state.authenticated : Boolean(state.user);
    const analyticsContext = getGoalJourneyContext(state);
    goalJourneyAnalytics.subscribeActivated(analyticsContext);
    if (!authenticated) {
      goalJourneyAnalytics.subscribeFailed(analyticsContext, "login_required");
      showLoginPrompt();
      subscribeAttemptRef.current = false;
      return;
    }
    const payload =
      state.postHeight === "tiny"
        ? { attemptId: activationId }
        : {
            shareUsername: state.subreddit.isNsfw ? false : shareUsername,
            attemptId: activationId,
          };
    const {
      state: updatedState,
      error: subscribeError,
      journeyTelemetryHandled,
    } = await subscribe(payload);
    if (subscribeError) {
      goalJourneyAnalytics.subscribeFailed(analyticsContext, "api_error");
      showToast(subscribeError);
      subscribeAttemptRef.current = false;
      return;
    }
    if (!updatedState) {
      goalJourneyAnalytics.subscribeFailed(analyticsContext, "missing_result");
      subscribeAttemptRef.current = false;
      return;
    }
    goalJourneyAnalytics.subscribeSucceeded(
      analyticsContext,
      journeyTelemetryHandled === true,
    );
    if (updatedState.postHeight === "cta") {
      subscribeAttemptRef.current = false;
      return;
    }
    const shouldShowModeratorInstallPromo =
      updatedState.postHeight !== "tiny" &&
      updatedState.moderatorInstallPromoEligible;
    setShowModeratorInstallPromo(shouldShowModeratorInstallPromo);
    if (updatedState.postHeight !== "tiny" && updatedState.completedTime) {
      setPage("completed");
    } else if (updatedState.postHeight === "tiny") {
      setPage("tinyConfirmation");
    } else {
      setPage("thanks");
    }
    triggerCelebration(confettiPresets.subscribe);
    if (updatedState.postHeight !== "tiny") {
      const noticeMessage = messages.subscriberNotice({
        username: updatedState.recentSubscriber,
      });
      showNotice(noticeMessage);
    }
    showToast({ text: messages.subscribeSuccessToast, appearance: "success" });
  };

  useEffect(() => {
    if (
      moderatorPromoViewedRef.current ||
      page !== "thanks" ||
      !showModeratorInstallPromo ||
      !state ||
      state.postHeight === "tiny" ||
      state.postHeight === "cta"
    ) {
      return;
    }
    moderatorPromoViewedRef.current = true;
    goalJourneyAnalytics.moderatorInstallPromoViewed(
      getGoalJourneyContext(state),
    );
    logDiagnostic("info", "moderator_install_promo_viewed", {
      workflow: "moderator_install_promo",
      phase: "render",
      postHeight: state.postHeight,
    });
  }, [page, showModeratorInstallPromo, state]);

  const handleSubscribe = () => {
    void performSubscribe().catch((error: unknown) => {
      subscribeAttemptRef.current = false;
      logDiagnostic(
        "error",
        "client_async_handler_failed",
        { workflow: "subscribe", phase: "app_handler" },
        error,
      );
      showToast(messages.subscribeErrorToast);
    });
  };
  return { handleSubscribe, showModeratorInstallPromo };
}
