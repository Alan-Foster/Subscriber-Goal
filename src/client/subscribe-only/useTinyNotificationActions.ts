import { showToast } from "@devvit/web/client";
import { useRef } from "react";
import { getNotificationMessages } from "../../shared/notificationI18n";
import type { SubGoalState } from "../../shared/types/api";
import type { useNotificationSettings } from "../app/hooks/useNotificationSettings";
import { NOTIFICATION_SETTINGS_ENTRY_ENABLED } from "../app/notificationFeatureFlags";
import type { TinySubscribeViewPhase } from "../app/viewSelection";

export function useTinyNotificationActions(
  viewPhase: TinySubscribeViewPhase,
  setViewPhase: (phase: TinySubscribeViewPhase) => void,
  language: SubGoalState["language"] | undefined,
  notificationSettings: ReturnType<typeof useNotificationSettings>,
) {
  const previousViewPhaseRef =
    useRef<Exclude<TinySubscribeViewPhase, "notifications">>("subscribe");
  const notificationMessages = getNotificationMessages(language);
  const openNotifications = () => {
    if (!NOTIFICATION_SETTINGS_ENTRY_ENABLED) {
      return;
    }
    if (viewPhase !== "notifications") {
      previousViewPhaseRef.current = viewPhase;
      setViewPhase("notifications");
    }
  };
  const returnFromNotifications = () => {
    setViewPhase(previousViewPhaseRef.current);
  };
  const toggleNotifications = (enabled: boolean) => {
    void notificationSettings.update(enabled).then((updated) => {
      if (!updated) {
        showToast(notificationMessages.updateError);
        return;
      }
      showToast({
        text: enabled
          ? notificationMessages.enabledToast
          : notificationMessages.disabledToast,
        appearance: "success",
      });
    });
  };
  return { openNotifications, returnFromNotifications, toggleNotifications };
}
