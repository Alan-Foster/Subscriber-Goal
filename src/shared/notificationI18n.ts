import type { SubGoalLanguage } from "./subGoalPostI18n";
import { resolveAppLanguage, translate } from "./i18n/catalog";

export type NotificationMessages = {
  label: string;
  alertsLabel: string;
  title: string;
  description: string;
  enabled: string;
  disabled: string;
  loginRequired: string;
  loadError: string;
  updateError: string;
  enabledToast: string;
  disabledToast: string;
  returnShort: string;
  backAriaLabel: string;
  goalPrompt: (params: { goalText: string }) => string;
  enabledHeading: string;
  successBody: string;
};

const cache = new Map<SubGoalLanguage, NotificationMessages>();

export const getNotificationMessages = (
  language: SubGoalLanguage | undefined,
): NotificationMessages => {
  const resolved = resolveAppLanguage(language);
  const cached = cache.get(resolved);
  if (cached) return cached;
  const messages: NotificationMessages = {
    label: translate(resolved, "notifications.label"),
    alertsLabel: translate(resolved, "notifications.alertsLabel"),
    title: translate(resolved, "notifications.title"),
    description: translate(resolved, "notifications.description"),
    enabled: translate(resolved, "notifications.enabled"),
    disabled: translate(resolved, "notifications.disabled"),
    loginRequired: translate(resolved, "notifications.loginRequired"),
    loadError: translate(resolved, "notifications.loadError"),
    updateError: translate(resolved, "notifications.updateError"),
    enabledToast: translate(resolved, "notifications.enabledToast"),
    disabledToast: translate(resolved, "notifications.disabledToast"),
    returnShort: translate(resolved, "notifications.return"),
    backAriaLabel: translate(resolved, "notifications.backAriaLabel"),
    goalPrompt: ({ goalText }) =>
      translate(resolved, "notifications.goalPrompt", { goalText }),
    enabledHeading: translate(resolved, "notifications.enabledHeading"),
    successBody: translate(resolved, "notifications.successBody"),
  };
  cache.set(resolved, messages);
  return messages;
};
