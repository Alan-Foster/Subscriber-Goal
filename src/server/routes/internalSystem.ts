import { context, redis } from "@devvit/web/server";
import type { Router } from "express";
import { internalRoutes } from "../../shared/routes";
import { initializeOnboardingSubscriberGoal } from "../core/onboardingSubscriberGoal";
import { onAppChanged } from "../triggers/appChanged";
import { onModAction, type ModActionEvent } from "../triggers/modAction";
import { onPostsUpdaterJob } from "../triggers/scheduler";

async function initializeOnboardingGoalForLifecycle(
  lifecycleSource: "install" | "upgrade",
): Promise<void> {
  const result = await initializeOnboardingSubscriberGoal(redis, {
    lifecycleSource,
  });
  console.info(
    `[onboardingSubscriberGoal] lifecycle: subreddit=${context.subredditName ?? context.subredditId ?? "unknown"} source=${lifecycleSource} outcome=${result.outcome} state=${result.state.status} stateSource=${result.state.lifecycleSource} armedAt=${new Date(result.state.armedAt).toISOString()} dueAt=${new Date(result.state.dueAt).toISOString()} completedAt=${result.state.completedAt ? new Date(result.state.completedAt).toISOString() : "none"} postId=${result.state.postId ?? "none"} error=${result.state.errorMessage ?? "none"}`,
  );
}

export function registerInternalSystemRoutes(router: Router): void {
  router.post(
    internalRoutes.triggers.onAppInstall,
    async (_req, res): Promise<void> => {
      try {
        await initializeOnboardingGoalForLifecycle("install");
        await onAppChanged();
        res.json({ status: "ok" });
      } catch (error) {
        console.error(`on-app-install error: ${String(error)}`);
        if (error instanceof Error) {
          console.error(error.stack ?? "(no stack)");
        }
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
        await initializeOnboardingGoalForLifecycle("upgrade");
        await onAppChanged();
        res.json({ status: "ok" });
      } catch (error) {
        console.error(`on-app-upgrade error: ${String(error)}`);
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
        console.error(`on-mod-action error: ${String(error)}`);
        res
          .status(400)
          .json({ status: "error", message: "Failed to handle mod action" });
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
        console.error(`postsUpdaterJob error: ${String(error)}`);
        res
          .status(400)
          .json({ status: "error", message: "Failed to run scheduler job" });
      }
    },
  );
}
