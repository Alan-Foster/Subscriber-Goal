import { showLoginPrompt, showToast } from "@devvit/web/client";
import { useRef } from "react";
import type { SubscribeOnlyState } from "../../shared/types/api";
import type { getSubGoalPostMessages } from "../../shared/subGoalPostI18n";
import {
  getGoalJourneyContext,
  goalJourneyAnalytics,
} from "../analytics/goalJourneyAnalytics";
import { recordStatisticsEvent } from "../analytics/statisticsAnalytics";
import { confettiPresets } from "../app/confettiPresets";
import type { useCelebration } from "../app/hooks/useCelebration";
import type { TinySubscribeViewPhase } from "../app/viewSelection";
import type { useSubGoal } from "../hooks/useSubGoal";
import { logDiagnostic } from "../../shared/diagnostics";

export function useTinySubscription({
  state,
  subscribe,
  setViewPhase,
  triggerCelebration,
  messages,
}: {
  state: SubscribeOnlyState | undefined;
  subscribe: ReturnType<typeof useSubGoal>["subscribe"];
  setViewPhase: (phase: TinySubscribeViewPhase) => void;
  triggerCelebration: ReturnType<typeof useCelebration>["triggerCelebration"];
  messages: ReturnType<typeof getSubGoalPostMessages>;
}) {
  const interactionStartedRef = useRef(false);
  const subscribeAttemptRef = useRef(false);
  const performSubscribe = async () => {
    if (!state || subscribeAttemptRef.current) return;
    subscribeAttemptRef.current = true;
    const activationId = recordStatisticsEvent("join_click");
    const analyticsContext = getGoalJourneyContext(state);
    goalJourneyAnalytics.subscribeActivated(analyticsContext);
    if (!state.authenticated) {
      goalJourneyAnalytics.subscribeFailed(analyticsContext, "login_required");
      showLoginPrompt();
      subscribeAttemptRef.current = false;
      return;
    }
    interactionStartedRef.current = true;
    const result = await subscribe({ attemptId: activationId });
    if (result.error) {
      goalJourneyAnalytics.subscribeFailed(analyticsContext, "api_error");
      interactionStartedRef.current = false;
      showToast(result.error);
      subscribeAttemptRef.current = false;
      return;
    }
    if (!result.state) {
      goalJourneyAnalytics.subscribeFailed(analyticsContext, "missing_result");
      interactionStartedRef.current = false;
      subscribeAttemptRef.current = false;
      return;
    }
    goalJourneyAnalytics.subscribeSucceeded(
      analyticsContext,
      result.journeyTelemetryHandled === true,
    );
    setViewPhase("confirmation");
    triggerCelebration(confettiPresets.subscribe);
    showToast({ text: messages.subscribeSuccessToast, appearance: "success" });
  };

  const handleSubscribe = () => {
    void performSubscribe().catch((error: unknown) => {
      subscribeAttemptRef.current = false;
      interactionStartedRef.current = false;
      logDiagnostic(
        "error",
        "client_async_handler_failed",
        { workflow: "subscribe", phase: "tiny_handler" },
        error,
      );
      showToast(messages.subscribeErrorToast);
    });
  };
  return { handleSubscribe, interactionStarted: interactionStartedRef.current };
}
