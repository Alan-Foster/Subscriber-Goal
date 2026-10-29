import { showToast } from "@devvit/web/client";
import { useRef, useState } from "react";
import type { AfterSubscribeAction } from "../../../shared/afterSubscribeAction";
import { getAfterSubscribePresetMessages } from "../../../shared/subGoalPostI18n";
import type { SubGoalLanguage } from "../../../shared/subGoalPostI18n";
import type {
  AfterSubscribeTargetResponse,
  NavigationTarget,
} from "../../../shared/types/api";
import { apiRoutes } from "../../../shared/routes";
import { SubscriptionButton } from "./SubscriptionButton";
import {
  getAfterSubscribeAnalyticsActionType,
  goalJourneyAnalytics,
} from "../../analytics/goalJourneyAnalytics";
import type { GoalJourneyContext } from "../../../shared/goalJourneyAnalytics";
import { logDiagnostic } from "../../../shared/diagnostics";
import { requestJsonWithRetry } from "../../utils/fetchWithRetry";
import { localizeError } from "../../../shared/i18n/errors";

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
};

export const AfterSubscribeButton = ({
  action,
  language,
  onNavigate,
  analyticsContext,
  trackClicks = false,
}: AfterSubscribeButtonProps) => {
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(false);
  const messages = getAfterSubscribePresetMessages(language);

  const handleClick = async () => {
    if (resolvingRef.current) {
      return;
    }
    resolvingRef.current = true;
    const actionType = getAfterSubscribeAnalyticsActionType(action);
    if (analyticsContext) {
      goalJourneyAnalytics.afterSubscribeCtaActivated(
        analyticsContext,
        actionType,
      );
    }
    if (action.type === "link") {
      if (trackClicks) {
        void fetch(apiRoutes.ctaClick, {
          method: "POST",
          keepalive: true,
        })
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
      if (analyticsContext) {
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
      const result = await requestJsonWithRetry<AfterSubscribeTargetResponse>(
        apiRoutes.afterSubscribeTarget,
        undefined,
        {
          // Dynamic CTA resolution historically made one request. Keep that
          // behavior while using the shared structured-error parser.
          maxDurationMs: 0,
          validate: (payload): payload is AfterSubscribeTargetResponse =>
            Boolean(
              payload &&
              typeof payload === "object" &&
              "target" in payload &&
              hasUsableNavigationTarget(
                (payload as AfterSubscribeTargetResponse).target,
              ),
            ),
        },
      );
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
        if (analyticsContext) {
          goalJourneyAnalytics.afterSubscribeCtaFailed(
            analyticsContext,
            actionType,
            result.status === 404 ? "target_unavailable" : "target_error",
          );
        }
        return;
      }
      if (analyticsContext) {
        goalJourneyAnalytics.afterSubscribeCtaOpened(
          analyticsContext,
          actionType,
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
      if (analyticsContext) {
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

function hasUsableNavigationTarget(
  target: unknown,
): target is NavigationTarget {
  if (
    typeof target !== "object" ||
    target === null ||
    !("url" in target) ||
    typeof target.url !== "string" ||
    target.url.trim().length === 0
  ) {
    return false;
  }
  try {
    const url = new URL(target.url);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.length > 0 &&
      (!("permalink" in target) ||
        target.permalink === undefined ||
        typeof target.permalink === "string")
    );
  } catch {
    // diagnostic-allow-silent: malformed navigation targets are validation input.
    return false;
  }
}
