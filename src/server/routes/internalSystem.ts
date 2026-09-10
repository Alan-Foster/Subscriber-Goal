import type { Router } from "express";
import { internalRoutes } from "../../shared/routes";
import { onAppChanged } from "../triggers/appChanged";
import { onModAction, type ModActionEvent } from "../triggers/modAction";
import { onPostsUpdaterJob } from "../triggers/scheduler";
import { recordCommunityPostCreated } from "../data/ctaActivity";
import { reddit, redis } from "@devvit/web/server";
import { logDiagnostic } from "../../shared/diagnostics";
import { getSubGoalData } from "../data/subGoalData";
import {
  MILESTONE_NOTIFICATION_DELIVERY_ENABLED,
  isMilestoneNotificationJob,
  processMilestoneNotificationBatch,
} from "../core/milestoneNotifications";

export function registerInternalSystemRoutes(router: Router): void {
  router.post(
    internalRoutes.triggers.onAppInstall,
    async (req, res): Promise<void> => {
      try {
        const installerUsername = getInstallerUsername(req.body);
        await onAppChanged({
          lifecycleSource: "install",
          ...(installerUsername ? { installerUsername } : {}),
        });
        res.json({ status: "ok" });
      } catch (error) {
        logDiagnostic(
          "error",
          "internal_trigger_failed",
          {
            route: internalRoutes.triggers.onAppInstall,
            workflow: "app_install",
          },
          error,
        );
        res
          .status(503)
          .json({ status: "error", message: "Failed to run install trigger" });
      }
    },
  );

  router.post(
    internalRoutes.triggers.onAppUpgrade,
    async (req, res): Promise<void> => {
      try {
        const installerUsername = getInstallerUsername(req.body);
        await onAppChanged({
          lifecycleSource: "upgrade",
          ...(installerUsername ? { installerUsername } : {}),
        });
        res.json({ status: "ok" });
      } catch (error) {
        logDiagnostic(
          "error",
          "internal_trigger_failed",
          {
            route: internalRoutes.triggers.onAppUpgrade,
            workflow: "app_upgrade",
          },
          error,
        );
        res
          .status(503)
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
        logDiagnostic(
          "error",
          "internal_trigger_failed",
          {
            route: internalRoutes.triggers.onModAction,
            workflow: "mod_action",
          },
          error,
        );
        res
          .status(503)
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
        logDiagnostic(
          "error",
          "internal_trigger_failed",
          {
            route: internalRoutes.triggers.onPostCreate,
            workflow: "post_create",
          },
          error,
        );
        res.status(503).json({
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
        logDiagnostic(
          "error",
          "scheduler_route_failed",
          {
            route: internalRoutes.scheduler.postsUpdaterJob,
            workflow: "posts_updater",
          },
          error,
        );
        res
          .status(503)
          .json({ status: "error", message: "Failed to run scheduler job" });
      }
    },
  );

  router.post(
    internalRoutes.scheduler.milestoneNotificationJob,
    async (req, res): Promise<void> => {
      const payload = req.body?.data ?? req.body;
      if (!isMilestoneNotificationJob(payload)) {
        res.status(400).json({
          status: "error",
          message: "Invalid milestone notification job payload.",
        });
        return;
      }
      try {
        if (!MILESTONE_NOTIFICATION_DELIVERY_ENABLED) {
          const result = await processMilestoneNotificationBatch(
            payload,
            {
              postId: payload.postId,
              completedTime: payload.completedTime,
              subredditName: "suppressed",
              goal: 1,
            },
            { deliveryEnabled: false },
          );
          res.json(result);
          return;
        }

        const [subGoalData, subreddit] = await Promise.all([
          getSubGoalData(redis, payload.postId),
          reddit.getCurrentSubreddit(),
        ]);
        if (
          !subGoalData.completedTime ||
          subGoalData.completedTime !== payload.completedTime ||
          subGoalData.goal <= 0
        ) {
          res.status(409).json({
            status: "error",
            message: "Milestone campaign no longer matches goal state.",
          });
          return;
        }
        const result = await processMilestoneNotificationBatch(payload, {
          postId: payload.postId,
          completedTime: payload.completedTime,
          subredditName: subGoalData.subredditDisplayName ?? subreddit.name,
          goal: subGoalData.goal,
        });
        res.json(result);
      } catch (error) {
        logDiagnostic(
          "error",
          "scheduler_route_failed",
          {
            route: internalRoutes.scheduler.milestoneNotificationJob,
            workflow: "milestone_notification",
          },
          error,
        );
        res.status(503).json({
          status: "error",
          message: "Failed to process milestone notification batch",
        });
      }
    },
  );
}

function getInstallerUsername(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const candidates = [
    record,
    record.event,
    record.data,
    record.appInstall,
    record.appUpgrade,
  ];
  for (const candidate of candidates) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !("installer" in candidate)
    ) {
      continue;
    }
    const installer = candidate.installer;
    if (installer && typeof installer === "object" && "name" in installer) {
      return typeof installer.name === "string" ? installer.name : undefined;
    }
  }
  return undefined;
}
