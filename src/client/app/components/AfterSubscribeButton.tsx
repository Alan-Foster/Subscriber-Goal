import { showToast } from "@devvit/web/client";
import { useRef, useState } from "react";
import type { AfterSubscribeAction } from "../../../shared/afterSubscribeAction";
import { getAfterSubscribePresetMessages } from "../../../shared/subGoalPostI18n";
import type { SubGoalLanguage } from "../../../shared/subGoalPostI18n";
import type {
  AfterSubscribeTargetResponse,
  ErrorResponse,
  NavigationTarget,
} from "../../../shared/types/api";
import { apiRoutes } from "../../../shared/routes";
import { SubscriptionButton } from "./SubscriptionButton";

type ActionableAfterSubscribeAction = Exclude<
  AfterSubscribeAction,
  { type: "disabled" }
>;

type AfterSubscribeButtonProps = {
  action: ActionableAfterSubscribeAction;
  language: SubGoalLanguage;
  onNavigate: (target: string | NavigationTarget) => void;
};

export const AfterSubscribeButton = ({
  action,
  language,
  onNavigate,
}: AfterSubscribeButtonProps) => {
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(false);
  const messages = getAfterSubscribePresetMessages(language);

  const handleClick = async () => {
    if (resolvingRef.current) {
      return;
    }
    if (action.type === "link") {
      onNavigate(action.url);
      return;
    }
    resolvingRef.current = true;
    setResolving(true);
    try {
      const response = await fetch(apiRoutes.afterSubscribeTarget);
      const payload = (await response.json()) as
        | AfterSubscribeTargetResponse
        | ErrorResponse;
      if (
        !response.ok ||
        !("target" in payload) ||
        !hasUsableNavigationTarget(payload.target)
      ) {
        showToast(
          response.status === 404
            ? messages.dynamicPostUnavailable
            : messages.dynamicPostError,
        );
        return;
      }
      onNavigate(payload.target);
    } catch {
      showToast(messages.dynamicPostError);
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
      onClick={() => void handleClick()}
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
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}
