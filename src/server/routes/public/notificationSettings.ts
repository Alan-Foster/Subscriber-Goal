import type { Router } from "express";
import { context } from "@devvit/web/server";
import { notifications } from "@devvit/notifications";
import type {
  NotificationSettingsRequest,
  NotificationSettingsResponse,
} from "../../../shared/types/api";
import { apiRoutes } from "../../../shared/routes";
import { createOperationId, logDiagnostic } from "../../../shared/diagnostics";
import { localizedError } from "./request";

export function registerNotificationSettingsRoutes(router: Router): void {
  router.get(
    apiRoutes.notificationSettings,
    async (_req, res): Promise<void> => {
      const userId = context.userId;
      if (!userId) {
        res.json({
          type: "notification-settings",
          authenticated: false,
          enabled: false,
        } satisfies NotificationSettingsResponse);
        return;
      }
      try {
        const enabled = await notifications.isOptedIn(userId);
        res.json({
          type: "notification-settings",
          authenticated: true,
          enabled,
        } satisfies NotificationSettingsResponse);
      } catch (error) {
        const operationId = createOperationId("notification-settings-read");
        logDiagnostic(
          "error",
          "api_request_failed",
          {
            operationId,
            route: apiRoutes.notificationSettings,
            workflow: "notification_settings",
            phase: "read",
            status: 503,
          },
          error,
        );
        res
          .status(503)
          .json(localizedError("errors.notifications.load", { operationId }));
      }
    },
  );
  router.post(
    apiRoutes.notificationSettings,
    async (req, res): Promise<void> => {
      const userId = context.userId;
      if (!userId) {
        res
          .status(401)
          .json(localizedError("errors.notifications.loginRequired"));
        return;
      }
      const body = req.body as Partial<NotificationSettingsRequest> | undefined;
      if (typeof body?.enabled !== "boolean") {
        res
          .status(400)
          .json(localizedError("errors.notifications.invalidEnabled"));
        return;
      }

      try {
        const current = await notifications.isOptedIn(userId);
        if (current !== body.enabled) {
          const result = body.enabled
            ? await notifications.optInCurrentUser()
            : await notifications.optOutCurrentUser();
          if (!result.success) {
            throw new Error(
              result.message || "Notification preference was not accepted.",
            );
          }
        }
        const enabled = await notifications.isOptedIn(userId);
        if (enabled !== body.enabled) {
          throw new Error("Notification preference confirmation mismatched.");
        }
        res.json({
          type: "notification-settings",
          authenticated: true,
          enabled,
        } satisfies NotificationSettingsResponse);
      } catch (error) {
        const operationId = createOperationId("notification-settings-write");
        logDiagnostic(
          "error",
          "api_request_failed",
          {
            operationId,
            route: apiRoutes.notificationSettings,
            workflow: "notification_settings",
            phase: "write",
            status: 503,
          },
          error,
        );
        res
          .status(503)
          .json(localizedError("errors.notifications.update", { operationId }));
      }
    },
  );
}
