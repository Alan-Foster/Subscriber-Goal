import type { Router } from "express";
import { internalRoutes } from "../../shared/routes";
import { onAppChanged } from "../triggers/appChanged";
import { onModAction, type ModActionEvent } from "../triggers/modAction";
import { onPostsUpdaterJob } from "../triggers/scheduler";
import { recordCommunityPostCreated } from "../data/ctaActivity";
import { redis } from "@devvit/web/server";
import { logDiagnostic } from "../../shared/diagnostics";

export function registerInternalSystemRoutes(router: Router): void {
  router.post(
    internalRoutes.triggers.onAppInstall,
    async (_req, res): Promise<void> => {
      try {
        await onAppChanged({ lifecycleSource: "install" });
        res.json({ status: "ok" });
      } catch (error) {
        logDiagnostic("error", "internal_trigger_failed", { route: internalRoutes.triggers.onAppInstall, workflow: "app_install" }, error);
        res
          .status(400)
          .json({ status: "error", message: "Failed to run install trigger" });
      }
    },
  );

  router.post(
    internalRoutes.triggers.onAppUpgrade,
    async (_req, res): Promise<void> => {
      try {
        await onAppChanged({ lifecycleSource: "upgrade" });
        res.json({ status: "ok" });
      } catch (error) {
        logDiagnostic("error", "internal_trigger_failed", { route: internalRoutes.triggers.onAppUpgrade, workflow: "app_upgrade" }, error);
        res
          .status(400)
          .json({ status: "error", message: "Failed to run upgrade trigger" });
      }
    },
  );

  router.post(
    internalRoutes.triggers.onModAction,
    async (req, res): Promise<void> => {
      try {
        const modAction = (req.body?.modAction ?? req.body) as ModActionEvent;
        await onModAction(modAction);
        res.json({ status: "ok" });
      } catch (error) {
        logDiagnostic("error", "internal_trigger_failed", { route: internalRoutes.triggers.onModAction, workflow: "mod_action" }, error);
        res
          .status(400)
          .json({ status: "error", message: "Failed to handle mod action" });
      }
    },
  );

  router.post(
    internalRoutes.triggers.onPostCreate,
    async (req, res): Promise<void> => {
      const post = req.body?.post ?? req.body;
      try {
        if (typeof post?.id !== "string") {
          res.status(400).json({
            status: "error",
            message: "Post ID is required.",
          });
          return;
        }
        await recordCommunityPostCreated(redis, post.id, post.createdAt);
        res.json({ status: "ok" });
      } catch (error) {
        logDiagnostic("error", "internal_trigger_failed", { route: internalRoutes.triggers.onPostCreate, workflow: "post_create" }, error);
        res.status(400).json({
          status: "error",
          message: "Failed to record post creation",
        });
      }
    },
  );

  router.post(
    internalRoutes.scheduler.postsUpdaterJob,
    async (_req, res): Promise<void> => {
      try {
        await onPostsUpdaterJob();
        res.json({ status: "ok" });
      } catch (error) {
        logDiagnostic("error", "scheduler_route_failed", { route: internalRoutes.scheduler.postsUpdaterJob, workflow: "posts_updater" }, error);
        res
          .status(400)
          .json({ status: "error", message: "Failed to run scheduler job" });
      }
    },
  );
}
