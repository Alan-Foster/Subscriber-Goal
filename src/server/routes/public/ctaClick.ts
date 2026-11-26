import type { Router } from "express";
import { context, redis } from "@devvit/web/server";
import type { RecordCtaClickResponse } from "../../../shared/types/api";
import { apiRoutes } from "../../../shared/routes";
import { getSubGoalData } from "../../data/subGoalData";
import { isClickActivityPreset, recordCtaClick } from "../../data/ctaActivity";
import { logDiagnostic } from "../../../shared/diagnostics";
import { localizedError, visitorIdentity } from "./request";

export function registerCtaClickRoutes(router: Router): void {
  router.post(apiRoutes.ctaClick, async (req, res): Promise<void> => {
    const { postId } = context;
    if (!postId) {
      res.status(400).json(localizedError("errors.api.postIdRequired"));
      return;
    }
    try {
      const subGoalData = await getSubGoalData(redis, postId, context.postData);
      if (
        subGoalData.afterSubscribeAction.type === "disabled" ||
        !isClickActivityPreset(subGoalData.afterSubscribePreset)
      ) {
        res
          .status(400)
          .json(localizedError("errors.api.ctaActivityUnsupported"));
        return;
      }
      const identity = visitorIdentity(req);
      if (identity) {
        await recordCtaClick(
          redis,
          postId,
          context.userId
            ? `user:${context.userId}`
            : `visitor:${identity.toLowerCase()}`,
        );
      }
      res.json({ status: "ok" } satisfies RecordCtaClickResponse);
    } catch (error) {
      logDiagnostic(
        "error",
        "api_request_failed",
        {
          route: apiRoutes.ctaClick,
          workflow: "cta_click",
          postId,
          status: 503,
        },
        error,
      );
      res.status(503).json(localizedError("errors.api.ctaActivityFailed"));
    }
  });
}
