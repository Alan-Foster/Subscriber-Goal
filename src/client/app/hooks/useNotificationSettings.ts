import { useCallback, useEffect, useRef, useState } from "react";
import type {
  NotificationSettingsResponse,
  NotificationSettingsRequest,
} from "../../../shared/types/api";
import { apiRoutes } from "../../../shared/routes";
import { requestJsonWithRetry } from "../../utils/fetchWithRetry";
import { requestSubscribeJson } from "../../hooks/useSubGoal";

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

export const useNotificationSettings = (active: boolean) => {
  const [settings, setSettings] = useState<NotificationSettingsResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

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
      setError(result.error ?? "Notification settings could not be loaded.");
      return;
    }
    setSettings(result.data);
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  const update = useCallback(
    async (enabled: boolean) => {
      if (submitting) return null;
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
      setSubmitting(false);
      if (result.error || !result.data) {
        setError(result.error ?? "Notification settings could not be updated.");
        return null;
      }
      setSettings(result.data);
      return result.data;
    },
    [submitting],
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
