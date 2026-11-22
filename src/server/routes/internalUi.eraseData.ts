import type { Response, Router } from "express";
import type { UiResponse } from "@devvit/web/shared";
import { context, reddit, redis } from "@devvit/web/server";
import { formNames, internalRoutes } from "../../shared/routes";
import { translate } from "../../shared/i18n/catalog";
import type { SubGoalLanguage } from "../../shared/subGoalPostI18n";
import { createOperationId, logDiagnostic } from "../../shared/diagnostics";
import {
  requireCurrentActorAuthority,
  resolveCurrentSubredditLanguage,
} from "./internalUi.common";
import type {
  EraseDataFormValues,
  EraseMyDataFormValues,
} from "../../shared/types/api";
import { eraseFromRecentSubscribers } from "../data/subGoalData";
import {
  untrackSubscriberById,
  untrackSubscriberByUsername,
} from "../data/subscriberStats";
import { findPendingSubscriberUserIdByUsername } from "../data/subscriberTracking";

export function registerEraseDataRoutes(router: Router): void {
  registerEraseDataMenuRoute(router);
  registerEraseMyDataMenuRoute(router);
  registerEraseDataFormRoute(router);
  registerEraseMyDataFormRoute(router);
}

function registerEraseDataMenuRoute(router: Router): void {
  router.post(
    internalRoutes.menu.eraseData,
    async (_req, res: Response<UiResponse>) => {
      const language = await resolveCurrentSubredditLanguage();
      res.json({
        showForm: {
          name: formNames.eraseData,
          form: {
            title: translate(language, "moderator.data.eraseTitle"),
            description: translate(language, "moderator.data.eraseDescription"),
            fields: [
              {
                name: "username",
                label: translate(language, "moderator.data.username"),
                type: "string",
                helpText: translate(language, "moderator.data.usernameHelp"),
                required: false,
              },
              {
                name: "userId",
                label: translate(language, "moderator.data.userId"),
                type: "string",
                helpText: translate(language, "moderator.data.userIdHelp"),
                required: false,
              },
              {
                name: "confirm",
                label: translate(language, "moderator.delete.confirm"),
                type: "boolean",
                defaultValue: false,
                helpText: translate(language, "moderator.delete.irreversible"),
              },
            ],
            acceptLabel: translate(language, "moderator.data.eraseAccept"),
            cancelLabel: translate(language, "moderator.common.cancel"),
          },
        },
      });
    },
  );
}

function registerEraseMyDataMenuRoute(router: Router): void {
  router.post(
    internalRoutes.menu.eraseMyData,
    async (_req, res: Response<UiResponse>) => {
      const language = await resolveCurrentSubredditLanguage();
      res.json({
        showForm: {
          name: formNames.eraseMyData,
          form: {
            title: translate(language, "moderator.data.selfTitle"),
            description: translate(language, "moderator.data.selfDescription"),
            fields: [
              {
                name: "confirm",
                label: translate(language, "moderator.data.selfConfirm"),
                type: "boolean",
                defaultValue: false,
                helpText: translate(language, "moderator.delete.irreversible"),
              },
            ],
            acceptLabel: translate(language, "moderator.data.selfAccept"),
            cancelLabel: translate(language, "moderator.common.cancel"),
          },
        },
      });
    },
  );
}

function registerEraseDataFormRoute(router: Router): void {
  router.post(
    internalRoutes.forms.eraseData,
    async (req, res: Response<UiResponse>) => {
      const language = await resolveCurrentSubredditLanguage();
      const { username, userId, confirm } = req.body as EraseDataFormValues;
      const normalizedUsername =
        typeof username === "string"
          ? username
              .trim()
              .replace(/^\/?u\//i, "")
              .trim()
          : undefined;

      if (!confirm) {
        res.json({
          showToast: translate(language, "moderator.data.eraseNotConfirmed"),
        });
        return;
      }

      if (!normalizedUsername && !userId) {
        res.json({
          showToast: translate(language, "moderator.data.detailsRequired"),
        });
        return;
      }

      const actorAuthority = await requireCurrentActorAuthority({
        requirement: "moderator",
        language,
      });
      if (!actorAuthority.authorized) {
        res.json({ showToast: actorAuthority.message });
        return;
      }

      const identity = await resolveEraseDataIdentity(
        userId,
        normalizedUsername,
        language,
      );
      let { resolvedUserId } = identity;
      const { resolvedUsername, identityLookupWarning } = identity;

      try {
        if (!resolvedUserId && resolvedUsername) {
          resolvedUserId = await findPendingSubscriberUserIdByUsername(
            redis,
            resolvedUsername,
          );
        }
        if (resolvedUserId) {
          await untrackSubscriberById(redis, resolvedUserId, resolvedUsername);
        } else if (resolvedUsername) {
          const result = await untrackSubscriberByUsername(
            redis,
            resolvedUsername,
          );
          if (result.status === "partial") {
            await eraseFromRecentSubscribers(redis, resolvedUsername);
            res.json({
              showToast: translate(language, "moderator.data.partial"),
            });
            return;
          }
        }

        if (identityLookupWarning) {
          res.json({
            showToast: translate(language, "moderator.data.availableErased", {
              warning: identityLookupWarning,
            }),
          });
          return;
        }

        res.json({
          showToast: translate(language, "moderator.data.eraseSuccess"),
        });
      } catch (error) {
        logDiagnostic(
          "error",
          "erase_user_data_failed",
          { workflow: "erase_user_data", phase: "erasure" },
          error,
        );
        res.json({
          showToast: translate(language, "moderator.data.eraseFailed"),
        });
      }
    },
  );
}

function registerEraseMyDataFormRoute(router: Router): void {
  router.post(
    internalRoutes.forms.eraseMyData,
    async (req, res: Response<UiResponse>) => {
      const operationId = createOperationId("erase-self");
      const language = await resolveCurrentSubredditLanguage();
      let phase = "request_validation";
      try {
        const { confirm } = (req.body ?? {}) as EraseMyDataFormValues;
        if (!confirm) {
          res.json({
            showToast: translate(language, "moderator.data.selfNotConfirmed"),
          });
          return;
        }

        const currentUserId = context.userId;
        if (!currentUserId) {
          res.json({
            showToast: translate(language, "moderator.data.selfLoginRequired"),
          });
          return;
        }

        let currentUsername: string | undefined;
        phase = "username_resolution";
        try {
          currentUsername = await reddit.getCurrentUsername();
        } catch (error) {
          logDiagnostic(
            "warn",
            "erase_self_username_resolution_failed",
            { operationId, workflow: "erase_self", phase },
            error,
          );
        }

        phase = "subscriber_untracking";
        await untrackSubscriberById(redis, currentUserId, currentUsername);
        if (currentUsername) {
          phase = "recent_subscriber_cleanup";
          await eraseFromRecentSubscribers(
            redis,
            currentUsername,
            currentUserId,
          );
        }

        phase = "response_completion";
        res.json({
          showToast: translate(language, "moderator.data.selfSuccess"),
        });
      } catch (error) {
        logDiagnostic(
          "error",
          "erase_self_failed",
          { operationId, workflow: "erase_self", phase },
          error,
        );
        res.json({
          showToast: translate(language, "moderator.data.selfFailed", {
            operationId,
          }),
        });
      }
    },
  );
}

async function resolveEraseDataIdentity(
  userId: EraseDataFormValues["userId"],
  normalizedUsername: string | undefined,
  language: SubGoalLanguage,
) {
  let resolvedUserId = userId;
  let resolvedUsername = userId ? undefined : normalizedUsername;
  let identityLookupWarning: string | null = null;

  if (resolvedUserId && !resolvedUserId.startsWith("t2_")) {
    resolvedUserId = `t2_${resolvedUserId}`;
  }

  try {
    if (resolvedUserId) {
      const typedUserId = resolvedUserId as `t2_${string}`;
      const user = await reddit.getUserById(typedUserId);
      if (user) {
        resolvedUsername = user.username;
      }
    } else if (resolvedUsername) {
      const user = await reddit.getUserByUsername(resolvedUsername);
      if (user) {
        resolvedUserId = user.id;
        resolvedUsername = user.username;
      }
    }
  } catch (error) {
    logDiagnostic(
      "warn",
      "erase_user_identity_lookup_failed",
      { workflow: "erase_user_data", phase: "identity_lookup" },
      error,
    );
    identityLookupWarning = translate(
      language,
      "moderator.data.identityWarning",
    );
  }
  return { resolvedUserId, resolvedUsername, identityLookupWarning };
}
