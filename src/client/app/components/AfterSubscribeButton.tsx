import { showToast } from "@devvit/web/client";
import { useRef, useState } from "react";
import type {
  AfterSubscribeAction,
  DynamicAfterSubscribeActionType,
} from "../../../shared/afterSubscribeAction";
import { getAfterSubscribePresetMessages } from "../../../shared/subGoalPostI18n";
import type { SubGoalLanguage } from "../../../shared/subGoalPostI18n";
import type {
  AfterSubscribeTargetResponse,
  NavigationTarget,
} from "../../../shared/types/api";
import { apiRoutes } from "../../../shared/routes";
import { isAfterSubscribeTargetResponse } from "./afterSubscribeTargetValidation";
import { SubscriptionButton } from "./SubscriptionButton";
import {
  getAfterSubscribeAnalyticsActionType,
  goalJourneyAnalytics,
} from "../../analytics/goalJourneyAnalytics";
import type { GoalJourneyContext } from "../../../shared/goalJourneyAnalytics";
import { logDiagnostic } from "../../../shared/diagnostics";
import { requestJsonWithRetry } from "../../utils/fetchWithRetry";
import { localizeError } from "../../../shared/i18n/errors";
import {
  recordStatisticsEvent,
  statisticsRequestHeaders,
} from "../../analytics/statisticsAnalytics";

type ActionableAfterSubscribeAction = Exclude<
  AfterSubscribeAction,
  { type: "disabled" }
>;

type AfterSubscribeButtonProps = {
  action: ActionableAfterSubscribeAction;
  language: SubGoalLanguage;
  onNavigate: (target: string | NavigationTarget) => void;
  analyticsContext?: GoalJourneyContext;
  trackClicks?: boolean;
  automaticAction?: DynamicAfterSubscribeActionType | "link";
};

type AutomaticAction = AfterSubscribeButtonProps["automaticAction"];

function recordCtaActivation(
  action: ActionableAfterSubscribeAction,
  analyticsContext: GoalJourneyContext | undefined,
  automaticAction: AutomaticAction,
) {
  if (!automaticAction) {
    try {
      recordStatisticsEvent("cta_click");
    } catch (error) {
      logDiagnostic(
        "warn",
        "statistics_event_failed",
        {
          workflow: "after_subscribe_cta",
          phase: "cta_click",
        },
        error,
      );
    }
  }
  const actionType = getAfterSubscribeAnalyticsActionType(action);
  if (analyticsContext && !automaticAction) {
    goalJourneyAnalytics.afterSubscribeCtaActivated(
      analyticsContext,
      actionType,
    );
  }
  return actionType;
}

function trackLinkClick() {
  // Defer identity generation and recording so even synchronous failures
  // cannot interrupt the click-through.
  void Promise.resolve()
    .then(() =>
      fetch(apiRoutes.ctaClick, {
        method: "POST",
        keepalive: true,
        headers: statisticsRequestHeaders(),
      }),
    )
    .then((response) => {
      if (!response.ok) {
        logDiagnostic("warn", "cta_click_tracking_failed", {
          workflow: "after_subscribe_cta",
          phase: "http_error",
          status: response.status,
        });
      }
    })
    .catch((error: unknown) => {
      logDiagnostic(
        "warn",
        "cta_click_tracking_failed",
        { workflow: "after_subscribe_cta", phase: "network" },
        error,
      );
    });
}

function requestDynamicTarget(automaticAction: AutomaticAction) {
  return requestJsonWithRetry<AfterSubscribeTargetResponse>(
    automaticAction
      ? `${apiRoutes.afterSubscribeTarget}?automaticAction=${encodeURIComponent(automaticAction)}`
      : apiRoutes.afterSubscribeTarget,
    undefined,
    {
      // Dynamic CTA resolution historically made one request. Keep that
      // behavior while using the shared structured-error parser.
      maxDurationMs: 0,
      validate: isAfterSubscribeTargetResponse,
    },
  );
}

export const AfterSubscribeButton = ({
  action,
  language,
  onNavigate,
  analyticsContext,
  trackClicks = false,
  automaticAction,
}: AfterSubscribeButtonProps) => {
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(false);
  const messages = getAfterSubscribePresetMessages(language);

  const handleClick = async () => {
    if (resolvingRef.current) {
      return;
    }
    resolvingRef.current = true;
    const actionType = recordCtaActivation(
      action,
      analyticsContext,
      automaticAction,
    );
    if (action.type === "link") {
      if (trackClicks && !automaticAction) {
        trackLinkClick();
      }
      if (analyticsContext && !automaticAction) {
        goalJourneyAnalytics.afterSubscribeCtaOpened(
          analyticsContext,
          actionType,
        );
      }
      resolvingRef.current = false;
      onNavigate(action.url);
      return;
    }
    setResolving(true);
    try {
      const result = await requestDynamicTarget(automaticAction);
      if (result.error || !result.data) {
        logDiagnostic("warn", "dynamic_target_request_failed", {
          workflow: "after_subscribe_cta",
          phase: result.errorResponse ? "http_error" : "invalid_payload",
          status: result.status,
        });
        showToast(
          localizeError(
            language,
            result.errorResponse,
            result.status === 404
              ? messages.dynamicPostUnavailable
              : messages.dynamicPostError,
          ),
        );
        if (analyticsContext && !automaticAction) {
          goalJourneyAnalytics.afterSubscribeCtaFailed(
            analyticsContext,
            actionType,
            result.status === 404 ? "target_unavailable" : "target_error",
          );
        }
        return;
      }
      if (analyticsContext && !automaticAction) {
        goalJourneyAnalytics.afterSubscribeCtaOpened(
          analyticsContext,
          actionType,
        );
      }
      if (result.data.fallbackAction) {
        showToast(
          result.data.fallbackAction === "create-post"
            ? messages.createNewPost
            : messages.viewMostRecentPostToday,
        );
      }
      onNavigate(result.data.target);
    } catch (error) {
      logDiagnostic(
        "error",
        "dynamic_target_failed",
        { workflow: "after_subscribe_cta", phase: "request" },
        error,
      );
      showToast(messages.dynamicPostError);
      if (analyticsContext && !automaticAction) {
        goalJourneyAnalytics.afterSubscribeCtaFailed(
          analyticsContext,
          actionType,
          "target_error",
        );
      }
    } finally {
      resolvingRef.current = false;
      setResolving(false);
    }
  };

  return (
    <SubscriptionButton
      colorTheme={action.colorTheme}
      label={action.buttonText}
      mode={resolving ? "submitting" : "link"}
      onClick={() => {
        void handleClick().catch((error: unknown) => {
          resolvingRef.current = false;
          setResolving(false);
          logDiagnostic(
            "error",
            "client_async_handler_failed",
            { workflow: "after_subscribe_cta", phase: "click_handler" },
            error,
          );
        });
      }}
    />
  );
};
