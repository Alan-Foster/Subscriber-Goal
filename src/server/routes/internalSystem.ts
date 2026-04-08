import type { Router } from 'express';
import { internalRoutes } from '../../shared/routes';
import { onAppChanged } from '../triggers/appChanged';
import { onModAction, type ModActionEvent } from '../triggers/modAction';
import { onPostsUpdaterJob } from '../triggers/scheduler';

export function registerInternalSystemRoutes(router: Router): void {
  router.post(
    internalRoutes.triggers.onAppInstall,
    async (_req, res): Promise<void> => {
      try {
        await onAppChanged();
        res.json({ status: 'ok' });
      } catch (error) {
        console.error(`on-app-install error: ${String(error)}`);
        if (error instanceof Error) {
          console.error(error.stack ?? '(no stack)');
        }
        res
          .status(400)
          .json({ status: 'error', message: 'Failed to run install trigger' });
      }
    }
  );

  router.post(
    internalRoutes.triggers.onAppUpgrade,
    async (_req, res): Promise<void> => {
      try {
        await onAppChanged();
        res.json({ status: 'ok' });
      } catch (error) {
        console.error(`on-app-upgrade error: ${String(error)}`);
        res
          .status(400)
          .json({ status: 'error', message: 'Failed to run upgrade trigger' });
      }
    }
  );

  router.post(
    internalRoutes.triggers.onModAction,
    async (req, res): Promise<void> => {
      try {
        const modAction = (req.body?.modAction ?? req.body) as ModActionEvent;
        await onModAction(modAction);
        res.json({ status: 'ok' });
      } catch (error) {
        console.error(`on-mod-action error: ${String(error)}`);
        res
          .status(400)
          .json({ status: 'error', message: 'Failed to handle mod action' });
      }
    }
  );

  router.post(
    internalRoutes.scheduler.postsUpdaterJob,
    async (_req, res): Promise<void> => {
      try {
        await onPostsUpdaterJob();
        res.json({ status: 'ok' });
      } catch (error) {
        console.error(`postsUpdaterJob error: ${String(error)}`);
        res
          .status(400)
          .json({ status: 'error', message: 'Failed to run scheduler job' });
      }
    }
  );
}
