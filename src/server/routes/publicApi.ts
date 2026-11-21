import type { Router } from "express";
import { registerNotificationSettingsRoutes } from "./public/notificationSettings";
import { registerCtaClickRoutes } from "./public/ctaClick";
import { registerStatisticsRoutes } from "./public/statistics";
import { registerAfterSubscribeTargetRoutes } from "./public/afterSubscribeTarget";
import { registerInitRoutes } from "./public/init";
import { registerRefreshRoutes } from "./public/refresh";
import { registerSubscribeRoutes } from "./public/subscribe";

export function registerPublicApiRoutes(router: Router): void {
  registerNotificationSettingsRoutes(router);
  registerCtaClickRoutes(router);
  registerStatisticsRoutes(router);
  registerAfterSubscribeTargetRoutes(router);
  registerInitRoutes(router);
  registerRefreshRoutes(router);
  registerSubscribeRoutes(router);
}
