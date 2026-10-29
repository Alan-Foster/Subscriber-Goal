import { useCallback, useEffect, useRef, useState } from "react";
import type {
  NotificationSettingsResponse,
  NotificationSettingsRequest,
} from "../../../shared/types/api";
import { apiRoutes } from "../../../shared/routes";
import { requestJsonWithRetry } from "../../utils/fetchWithRetry";
import { requestSubscribeJson } from "../../hooks/useSubGoal";
import { getNotificationMessages } from "../../../shared/notificationI18n";
import { localizeError } from "../../../shared/i18n/errors";
import type { SubGoalLanguage } from "../../../shared/subGoalPostI18n";

const isNotificationSettingsResponse = (
  value: unknown,
): value is NotificationSettingsResponse => {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<NotificationSettingsResponse>;
  return (
    response.type === "notification-settings" &&
    typeof response.authenticated === "boolean" &&
    typeof response.enabled === "boolean"
  );
};

export const useNotificationSettings = (
  active: boolean,
  language?: SubGoalLanguage,
) => {
  const [settings, setSettings] = useState<NotificationSettingsResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const submittingRef = useRef(false);
  const messages = getNotificationMessages(language);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    const result = await requestJsonWithRetry<NotificationSettingsResponse>(
      apiRoutes.notificationSettings,
      undefined,
      { validate: isNotificationSettingsResponse, maxDurationMs: 5_000 },
    );
    if (requestId !== requestRef.current || result.aborted) return;
    setLoading(false);
    if (result.error || !result.data) {
      setError(
        localizeError(
          language,
          result.errorResponse,
          result.error ?? messages.loadError,
        ),
      );
      return;
    }
    setSettings(result.data);
  }, [language, messages.loadError]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  const update = useCallback(
    async (enabled: boolean) => {
      if (submittingRef.current) return null;
      submittingRef.current = true;
      setSubmitting(true);
      setError(null);
      const body: NotificationSettingsRequest = { enabled };
      const result = await requestSubscribeJson<NotificationSettingsResponse>(
        apiRoutes.notificationSettings,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        isNotificationSettingsResponse,
        { timeoutMs: 10_000 },
      );
      submittingRef.current = false;
      setSubmitting(false);
      if (result.error || !result.data) {
        setError(
          localizeError(
            language,
            result.error
              ? {
                  message: result.error,
                  ...(result.errorMessageKey
                    ? {
                        messageKey: result.errorMessageKey,
                        messageParams: result.errorMessageParams ?? {},
                      }
                    : {}),
                }
              : undefined,
            messages.updateError,
          ),
        );
        return null;
      }
      setSettings(result.data);
      return result.data;
    },
    [language, messages.updateError],
  );

  return {
    settings,
    loading: loading || (active && settings === null && error === null),
    submitting,
    error,
    update,
    reload: load,
  };
};
