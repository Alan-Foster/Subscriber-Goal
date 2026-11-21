import type { Router } from "express";
import { registerCreateGoalRoutes } from "./internalUi.createGoal";
import { registerDeleteGoalRoutes } from "./internalUi.deleteGoal";
import { registerEraseDataRoutes } from "./internalUi.eraseData";

export function registerInternalUiRoutes(router: Router): void {
  registerCreateGoalRoutes(router);
  registerDeleteGoalRoutes(router);
  registerEraseDataRoutes(router);
}
