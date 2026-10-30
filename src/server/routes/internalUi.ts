import type { Response, Router } from "express";
import type { UiResponse } from "@devvit/web/shared";
import { context, reddit, redis } from "@devvit/web/server";
import type {
  CreateGoalSetupFormValues,
  CreateCtaOnlyFollowUpFormValues,
  CreateCtaOnlyFormValues,
  CreateSubscribeOnlyFollowUpFormValues,
  CreateSubscribeOnlyFormValues,
  CreateSubscriberGoalFollowUpFormValues,
  CreateSubscriberGoalFormValues,
  DeleteGoalFormValues,
  EraseDataFormValues,
  EraseMyDataFormValues,
} from "../../shared/types/api";
import {
  defaultSubGoalColorTheme,
  resolveSubGoalColorTheme,
  subGoalColorThemes,
} from "../../shared/subGoalColorTheme";
import { subGoalPostHeights } from "../../shared/subGoalPostHeight";
import {
  getAfterSubscribePresetMessages,
  getSubGoalPostMessages,
  defaultSubGoalLanguage,
  resolveSubGoalLanguage,
  subGoalLanguages,
  type SubGoalLanguage,
} from "../../shared/subGoalPostI18n";
import { getLanguageMetadata } from "../../shared/i18n/catalog";
import { formNames, internalRoutes } from "../../shared/routes";
import {
  createSubscriberGoal,
  SubscriberGoalCreationInProgressError,
  SubscriberGoalModeratorPermissionError,
} from "../core/createSubscriberGoal";
import {
  deleteCreateGoalDraft,
  getCreateGoalDraft,
  saveCreateGoalDraft,
  type CreateGoalDraft,
  type CreateGoalDraftDetails,
} from "../data/createGoalDraft";
import { dispatchPostAction } from "../data/crosspostData";
import { eraseFromRecentSubscribers } from "../data/subGoalData";
import { getSavedSubredditDisplayName } from "../data/subredditDisplayNameData";
import {
  untrackSubscriberById,
  untrackSubscriberByUsername,
} from "../data/subscriberStats";
import { getAppSettings } from "../settings";
import { getDefaultSubscriberGoal } from "../utils/numberUtils";
import {
  describeHighlightResult,
  getPostUrl,
  notifyHighlightFailure,
} from "../utils/highlightFailureNotifications";
import { validateSubredditDisplayName } from "../utils/subredditDisplayName";
import { parseDeveloperCommands } from "../utils/developerCommands";
import { ProhibitedSubredditError } from "../utils/subredditBlacklist";
import { createOperationId, logDiagnostic } from "../../shared/diagnostics";
import { getCurrentSubredditNsfw } from "../utils/subredditSafety";
import { translate } from "../../shared/i18n/catalog";
import { retireSubscriberGoalPost } from "../core/postRetirement";
import {
  createDefaultAfterSubscribeAction,
  createDefaultCreatePostAction,
  defaultAfterSubscribeColorTheme,
  getDefaultAfterSubscribePreset,
  isAfterSubscribePreset,
  resolveAfterSubscribeAction,
  type AfterSubscribeActionType,
  type AfterSubscribePreset,
} from "../../shared/afterSubscribeAction";

function stableDraftFingerprint(value: unknown): string {
  const input = JSON.stringify(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

async function resolveCurrentSubredditLanguage(): Promise<SubGoalLanguage> {
  try {
    return resolveSubGoalLanguage(
      (await reddit.getCurrentSubreddit()).language,
    );
  } catch {
    // diagnostic-allow-silent: the default language is safe when subreddit metadata is unavailable.
    return defaultSubGoalLanguage;
  }
}

export function registerInternalUiRoutes(router: Router): void {
  const registerCreateGoalMenuRoute = (
    route: string,
    defaultPostHeight: "regular" | "cta",
  ): void => {
    router.post(route, async (_req, res: Response<UiResponse>) => {
      if (context.userId) {
        try {
          await deleteCreateGoalDraft(redis, context.userId);
        } catch (error) {
          logDiagnostic(
            "warn",
            "create_goal_draft_cleanup_failed",
            { workflow: "create_goal", phase: "previous_draft_cleanup" },
            error,
          );
        }
      }
      try {
        res.json({
          showForm: await buildCreateGoalSetupForm(defaultPostHeight),
        });
      } catch (error) {
        logDiagnostic(
          "error",
          "internal_ui_failed",
          { workflow: "create_goal", phase: "setup_form" },
          error,
        );
        res.json({
          showToast: translate(
            await resolveCurrentSubredditLanguage(),
            "moderator.form.prepareSetupFailed",
          ),
        });
      }
    });
  };

  registerCreateGoalMenuRoute(internalRoutes.menu.createGoal, "regular");
  registerCreateGoalMenuRoute(internalRoutes.menu.createCta, "cta");

  router.post(
    internalRoutes.forms.createGoalSetup,
    async (req, res: Response<UiResponse>) => {
      const values = req.body as CreateGoalSetupFormValues;
      const language = values.language?.[0];
      const postHeight = values.postHeight?.[0];
      const subredditDisplayName = values.subredditDisplayName?.trim();
      const userId = context.userId;
      if (
        !language ||
        !subGoalLanguages.includes(
          language as (typeof subGoalLanguages)[number],
        ) ||
        !postHeight ||
        !subGoalPostHeights.includes(
          postHeight as (typeof subGoalPostHeights)[number],
        )
      ) {
        res.json({
          showToast: translate(
            await resolveCurrentSubredditLanguage(),
            "moderator.form.invalidLanguageHeight",
          ),
        });
        return;
      }
      if (!userId) {
        res.json({
          showToast: translate(language, "moderator.form.loginRequired"),
        });
        return;
      }
      try {
        const subreddit = await reddit.getCurrentSubreddit();
        const displayNameError = validateSubredditDisplayName(
          subredditDisplayName,
          subreddit.name,
          language,
        );
        if (displayNameError) {
          res.json({ showToast: displayNameError });
          return;
        }
        const draft = {
          stage: "details" as const,
          language: language as (typeof subGoalLanguages)[number],
          postHeight: postHeight as (typeof subGoalPostHeights)[number],
          subredditDisplayName: subredditDisplayName ?? subreddit.name,
          customDeveloperField: "",
        };
        await saveCreateGoalDraft(redis, userId, draft);
        res.json({
          showForm: buildCreateGoalDetailsForm(draft, subreddit),
        });
      } catch (error) {
        logDiagnostic(
          "error",
          "internal_ui_failed",
          { workflow: "create_goal", phase: "details_form" },
          error,
        );
        res.json({
          showToast: translate(language, "moderator.form.prepareDetailsFailed"),
        });
      }
    },
  );

  router.post(
    internalRoutes.forms.createSubscriberGoal,
    async (req, res: Response<UiResponse>) => {
      await submitCreateGoalStepTwo(
        req.body as CreateSubscriberGoalFormValues,
        "subscriber-goal",
        res,
      );
    },
  );

  router.post(
    internalRoutes.forms.createSubscribeOnly,
    async (req, res: Response<UiResponse>) => {
      await submitCreateGoalStepTwo(
        req.body as CreateSubscribeOnlyFormValues,
        "subscribe-only",
        res,
      );
    },
  );

  router.post(
    internalRoutes.forms.createCtaOnly,
    async (req, res: Response<UiResponse>) => {
      await submitCreateGoalStepTwo(
        req.body as CreateCtaOnlyFormValues,
        "cta-only",
        res,
      );
    },
  );

  router.post(
    internalRoutes.forms.createSubscriberGoalFollowUp,
    async (req, res: Response<UiResponse>) => {
      await submitCreateGoalFollowUp(
        req.body as CreateSubscriberGoalFollowUpFormValues,
        "subscriber-goal",
        res,
      );
    },
  );

  router.post(
    internalRoutes.forms.createSubscribeOnlyFollowUp,
    async (req, res: Response<UiResponse>) => {
      await submitCreateGoalFollowUp(
        req.body as CreateSubscribeOnlyFollowUpFormValues,
        "subscribe-only",
        res,
      );
    },
  );

  router.post(
    internalRoutes.forms.createCtaOnlyFollowUp,
    async (req, res: Response<UiResponse>) => {
      await submitCreateGoalFollowUp(
        req.body as CreateCtaOnlyFollowUpFormValues,
        "cta-only",
        res,
      );
    },
  );

  router.post(
    internalRoutes.menu.deleteGoal,
    async (_req, res: Response<UiResponse>) => {
      const language = await resolveCurrentSubredditLanguage();
      res.json({
        showForm: {
          name: formNames.deleteGoal,
          form: {
            title: translate(language, "moderator.delete.title"),
            description: translate(language, "moderator.delete.description"),
            fields: [
              {
                name: "confirm",
                label: translate(language, "moderator.delete.confirm"),
                type: "boolean",
                defaultValue: false,
                helpText: translate(language, "moderator.delete.irreversible"),
              },
            ],
            acceptLabel: translate(language, "moderator.delete.accept"),
            cancelLabel: translate(language, "moderator.common.cancel"),
          },
        },
      });
    },
  );

  router.post(
    internalRoutes.forms.deleteGoal,
    async (req, res: Response<UiResponse>) => {
      const operationId = createOperationId("delete-goal");
      const postId = context.postId;
      const language = await resolveCurrentSubredditLanguage();
      let phase = "request_validation";
      logDiagnostic("info", "delete_goal_started", {
        operationId,
        workflow: "delete_goal",
        phase,
        postId,
      });
      try {
        const { confirm } = (req.body ?? {}) as DeleteGoalFormValues;
        if (!confirm) {
          res.json({
            showToast: translate(language, "moderator.delete.notConfirmed"),
          });
          return;
        }
        if (!postId) {
          logDiagnostic("warn", "delete_goal_metadata_missing", {
            operationId,
            workflow: "delete_goal",
            phase,
          });
          res.json({
            showToast: translate(language, "moderator.delete.metadataLost", {
              operationId,
            }),
          });
          return;
        }

        phase = "metadata_resolution";
        const subredditName =
          context.subredditName ?? (await reddit.getCurrentSubreddit()).name;
        if (!subredditName) {
          throw new Error("Subreddit name was unavailable during deletion.");
        }
        logDiagnostic("info", "delete_goal_phase_complete", {
          operationId,
          workflow: "delete_goal",
          phase,
          postId,
        });

        phase = "post_lookup";
        const post = await reddit.getPostById(postId);
        logDiagnostic("info", "delete_goal_phase_complete", {
          operationId,
          workflow: "delete_goal",
          phase,
          postId,
        });
        const appSettings = getAppSettings();
        phase = "crosspost_delete_dispatch";
        if (
          subredditName.toLowerCase() !==
          appSettings.promoSubreddit.toLowerCase()
        ) {
          await dispatchPostAction(reddit, appSettings, postId, "delete");
        }
        logDiagnostic("info", "delete_goal_phase_complete", {
          operationId,
          workflow: "delete_goal",
          phase,
          postId,
        });
        phase = "reddit_post_delete";
        await post.delete();
        logDiagnostic("info", "delete_goal_phase_complete", {
          operationId,
          workflow: "delete_goal",
          phase,
          postId,
        });
        const cleanupFailures: string[] = [];
        const runCleanupPhase = async (
          cleanupPhase: string,
          operation: () => Promise<unknown>,
        ): Promise<void> => {
          phase = cleanupPhase;
          try {
            await operation();
            logDiagnostic("info", "delete_goal_phase_complete", {
              operationId,
              workflow: "delete_goal",
              phase,
              postId,
            });
          } catch (error) {
            cleanupFailures.push(cleanupPhase);
            logDiagnostic(
              "error",
              "delete_goal_cleanup_failed",
              { operationId, workflow: "delete_goal", phase, postId },
              error,
            );
          }
        };
        await runCleanupPhase("post_retirement", () =>
          retireSubscriberGoalPost(redis, postId, "app_menu_deletion"),
        );
        phase = "response_completion";
        if (cleanupFailures.length > 0) {
          logDiagnostic("warn", "delete_goal_partially_completed", {
            operationId,
            workflow: "delete_goal",
            phase,
            postId,
            failedCleanupCount: cleanupFailures.length,
          });
          res.json({
            showToast: translate(language, "moderator.delete.cleanupPending", {
              operationId,
            }),
          });
          return;
        }
        res.json({
          showToast: translate(language, "moderator.delete.success"),
        });
        logDiagnostic("info", "delete_goal_completed", {
          operationId,
          workflow: "delete_goal",
          phase,
          postId,
        });
      } catch (error) {
        logDiagnostic(
          "error",
          "delete_goal_failed",
          { operationId, workflow: "delete_goal", phase, postId },
          error,
        );
        res.json({
          showToast: translate(language, "moderator.delete.failed", {
            operationId,
          }),
        });
      }
    },
  );

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

  router.post(
    internalRoutes.forms.eraseData,
    async (req, res: Response<UiResponse>) => {
      const language = await resolveCurrentSubredditLanguage();
      const { username, userId, confirm } = req.body as EraseDataFormValues;

      if (!confirm) {
        res.json({
          showToast: translate(language, "moderator.data.eraseNotConfirmed"),
        });
        return;
      }

      if (!username && !userId) {
        res.json({
          showToast: translate(language, "moderator.data.detailsRequired"),
        });
        return;
      }

      let resolvedUserId = userId;
      let resolvedUsername = username;
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

      try {
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

        if (resolvedUsername) {
          await eraseFromRecentSubscribers(redis, resolvedUsername);
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
          await eraseFromRecentSubscribers(redis, currentUsername);
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

type CreateGoalPostKind = "subscriber-goal" | "subscribe-only" | "cta-only";
type CreateGoalDetailsValues =
  | CreateSubscriberGoalFormValues
  | CreateSubscribeOnlyFormValues
  | CreateCtaOnlyFormValues;
type CreateGoalFollowUpValues =
  | CreateSubscriberGoalFollowUpFormValues
  | CreateSubscribeOnlyFollowUpFormValues
  | CreateCtaOnlyFollowUpFormValues;

async function buildCreateGoalSetupForm(
  initialPostHeight: "regular" | "cta" = "regular",
): Promise<NonNullable<UiResponse["showForm"]>> {
  const subreddit = await reddit.getCurrentSubreddit();
  const defaultLanguage = resolveSubGoalLanguage(subreddit.language);
  const savedDisplayName = await getSavedSubredditDisplayName(redis);
  return {
    name: formNames.createGoalSetup,
    form: {
      title: translate(defaultLanguage, "moderator.setup.title"),
      description: translate(defaultLanguage, "moderator.setup.description"),
      acceptLabel: translate(defaultLanguage, "moderator.common.next"),
      cancelLabel: translate(defaultLanguage, "moderator.common.cancel"),
      fields: [
        {
          name: "language",
          label: translate(defaultLanguage, "moderator.setup.language"),
          type: "select",
          defaultValue: [defaultLanguage],
          options: subGoalLanguages.map((language) => ({
            label: getLanguageMetadata(language).label,
            value: language,
          })),
          helpText: translate(defaultLanguage, "moderator.setup.languageHelp"),
          required: true,
        },
        {
          name: "subredditDisplayName",
          label: translate(defaultLanguage, "moderator.setup.displayName"),
          type: "string",
          defaultValue: savedDisplayName ?? subreddit.name,
          helpText: translate(
            defaultLanguage,
            "moderator.setup.displayNameHelp",
          ),
          required: true,
        },
        {
          name: "postHeight",
          label: translate(defaultLanguage, "moderator.setup.postHeight"),
          type: "select",
          defaultValue: [initialPostHeight],
          options: [
            {
              label: translate(defaultLanguage, "moderator.setup.regular"),
              value: "regular",
            },
            {
              label: translate(defaultLanguage, "moderator.setup.short"),
              value: "short",
            },
            {
              label: translate(defaultLanguage, "moderator.setup.tiny"),
              value: "tiny",
            },
            {
              label: translate(defaultLanguage, "moderator.setup.cta"),
              value: "cta",
            },
          ],
          helpText: translate(defaultLanguage, "moderator.setup.help"),
          required: true,
        },
      ],
    },
  };
}

function buildCreateGoalDetailsForm(
  draft: Pick<
    Extract<CreateGoalDraft, { stage: "details" }>,
    "language" | "postHeight" | "subredditDisplayName"
  >,
  subreddit: {
    name: string;
    numberOfSubscribers: number;
    type?: unknown;
    nsfw?: unknown;
  },
): NonNullable<UiResponse["showForm"]> {
  const defaultPostTitle = getSubGoalPostMessages(
    draft.language,
  ).defaultPostTitle({ subredditName: draft.subredditDisplayName });
  const commonFields = {
    postTitle: {
      name: "postTitle",
      label: translate(draft.language, "moderator.details.postTitle"),
      type: "string" as const,
      defaultValue: defaultPostTitle,
      helpText: translate(draft.language, "moderator.details.postTitleHelp"),
      required: true,
    },
  };
  const colorOptions = getColorOptions(draft.language);

  if (draft.postHeight === "tiny") {
    return {
      name: formNames.createSubscribeOnly,
      form: {
        title: translate(draft.language, "moderator.details.joinOnlyTitle"),
        description: translate(
          draft.language,
          "moderator.details.joinOnlyDescription",
        ),
        acceptLabel: translate(draft.language, "moderator.common.next"),
        cancelLabel: translate(draft.language, "moderator.common.cancel"),
        fields: [
          commonFields.postTitle,
          {
            name: "colorTheme",
            label: translate(draft.language, "moderator.details.joinColor"),
            type: "select",
            defaultValue: [defaultSubGoalColorTheme],
            options: colorOptions,
            helpText: translate(
              draft.language,
              "moderator.details.joinColorHelp",
            ),
            required: true,
          },
          getAfterSubscribeActionField(
            subreddit.type,
            "after-subscribe",
            getCurrentSubredditNsfw(subreddit) === true,
            draft.language,
          ),
        ],
      },
    };
  }

  if (draft.postHeight === "cta") {
    return {
      name: formNames.createCtaOnly,
      form: {
        title: translate(draft.language, "moderator.details.ctaTitle"),
        description: translate(
          draft.language,
          "moderator.details.ctaDescription",
        ),
        acceptLabel: translate(draft.language, "moderator.common.next"),
        cancelLabel: translate(draft.language, "moderator.common.cancel"),
        fields: [
          commonFields.postTitle,
          getAfterSubscribeActionField(
            subreddit.type,
            "cta",
            getCurrentSubredditNsfw(subreddit) === true,
            draft.language,
          ),
        ],
      },
    };
  }

  const appSettings = getAppSettings();
  const sourceSubredditNsfw = getCurrentSubredditNsfw(subreddit);
  const sourceSubredditIsNsfw = sourceSubredditNsfw === true;
  const shouldCrosspost =
    sourceSubredditNsfw === false &&
    subreddit.name.toLowerCase() !== appSettings.promoSubreddit.toLowerCase();
  const crosspostHelpText = sourceSubredditIsNsfw
    ? translate(draft.language, "moderator.details.crosspostNsfw")
    : sourceSubredditNsfw === undefined
      ? translate(draft.language, "moderator.details.crosspostUnknown")
      : translate(draft.language, "moderator.details.crosspostHelp", {
          subredditName: appSettings.promoSubreddit,
        });

  return {
    name: formNames.createSubscriberGoal,
    form: {
      title: translate(draft.language, "moderator.details.goalTitle"),
      description: translate(
        draft.language,
        "moderator.details.goalDescription",
        { height: draft.postHeight === "short" ? "Short" : "Regular" },
      ),
      acceptLabel: translate(draft.language, "moderator.common.next"),
      cancelLabel: translate(draft.language, "moderator.common.cancel"),
      fields: [
        commonFields.postTitle,
        {
          name: "subscriberGoal",
          label: translate(draft.language, "moderator.details.goal"),
          type: "number",
          defaultValue: getDefaultSubscriberGoal(subreddit.numberOfSubscribers),
          helpText: translate(draft.language, "moderator.details.goalHelp"),
          required: true,
        },
        {
          name: "colorTheme",
          label: translate(draft.language, "moderator.details.joinColor"),
          type: "select",
          defaultValue: [defaultSubGoalColorTheme],
          options: colorOptions,
          helpText: translate(
            draft.language,
            "moderator.details.goalColorHelp",
          ),
          required: true,
        },
        getAfterSubscribeActionField(
          subreddit.type,
          "after-subscribe",
          sourceSubredditIsNsfw,
          draft.language,
        ),
        {
          name: "autoCreateNextGoal",
          label: translate(draft.language, "moderator.details.autoNext"),
          type: "boolean",
          helpText: translate(draft.language, "moderator.details.autoNextHelp"),
          defaultValue: true,
        },
        {
          name: "crosspost",
          label: translate(draft.language, "moderator.details.crosspost", {
            subredditName: appSettings.promoSubreddit,
          }),
          type: "boolean",
          helpText: crosspostHelpText,
          defaultValue: shouldCrosspost,
          disabled: !shouldCrosspost,
        },
      ],
    },
  };
}

function buildCreateGoalFollowUpForm(
  draft: Extract<CreateGoalDraft, { stage: "follow-up" }>,
): NonNullable<UiResponse["showForm"]> {
  const presetDefaults = getAfterSubscribePresetDefaults(
    draft.details.afterSubscribePreset,
    draft.language,
  );
  const isCtaOnly = draft.details.kind === "cta-only";
  const sharedFields = [
    {
      name: "afterSubscribeButtonText",
      label: isCtaOnly
        ? translate(draft.language, "moderator.followUp.ctaText")
        : translate(draft.language, "moderator.followUp.buttonText"),
      type: "string" as const,
      ...(presetDefaults.buttonText
        ? { defaultValue: presetDefaults.buttonText }
        : {}),
      helpText: translate(draft.language, "moderator.followUp.textHelp"),
      required: false,
    },
    ...(presetDefaults.showUrl
      ? [
          {
            name: "afterSubscribeUrl",
            label: translate(draft.language, "moderator.followUp.url"),
            type: "string" as const,
            helpText: translate(draft.language, "moderator.followUp.urlHelp"),
            required: false,
          },
        ]
      : []),
    {
      name: "afterSubscribeColorTheme",
      label: isCtaOnly
        ? translate(draft.language, "moderator.followUp.ctaColor")
        : translate(draft.language, "moderator.followUp.buttonColor"),
      type: "select" as const,
      defaultValue: [presetDefaults.colorTheme],
      options: getColorOptions(draft.language),
      helpText: translate(draft.language, "moderator.followUp.buttonColorHelp"),
      required: true,
    },
    {
      name: "customDeveloperField",
      label: translate(draft.language, "moderator.followUp.developerField"),
      type: "string" as const,
      helpText: translate(
        draft.language,
        "moderator.followUp.developerFieldHelp",
      ),
      required: false,
    },
  ];

  if (draft.details.kind === "subscribe-only") {
    return {
      name: formNames.createSubscribeOnlyFollowUp,
      form: {
        title: translate(draft.language, "moderator.followUp.title"),
        description: translate(
          draft.language,
          "moderator.followUp.description",
        ),
        acceptLabel: translate(draft.language, "moderator.common.create"),
        cancelLabel: translate(draft.language, "moderator.common.cancel"),
        fields: sharedFields,
      },
    };
  }

  if (draft.details.kind === "cta-only") {
    return {
      name: formNames.createCtaOnlyFollowUp,
      form: {
        title: translate(draft.language, "moderator.followUp.ctaTitle"),
        description: translate(
          draft.language,
          "moderator.followUp.ctaDescription",
        ),
        acceptLabel: translate(draft.language, "moderator.common.create"),
        cancelLabel: translate(draft.language, "moderator.common.cancel"),
        fields: sharedFields,
      },
    };
  }

  return {
    name: formNames.createSubscriberGoalFollowUp,
    form: {
      title: translate(draft.language, "moderator.followUp.goalTitle"),
      description: translate(
        draft.language,
        "moderator.followUp.goalDescription",
      ),
      acceptLabel: translate(draft.language, "moderator.common.create"),
      cancelLabel: translate(draft.language, "moderator.common.cancel"),
      fields: sharedFields,
    },
  };
}

function getColorOptions(
  language: SubGoalLanguage = defaultSubGoalLanguage,
): Array<{ label: string; value: string }> {
  const labels: Record<(typeof subGoalColorThemes)[number], string> = {
    red: translate(language, "moderator.color.red"),
    green: translate(language, "moderator.color.green"),
    purple: translate(language, "moderator.color.purple"),
    blue: translate(language, "moderator.color.blue"),
    pink: translate(language, "moderator.color.pink"),
  };
  return subGoalColorThemes.map((value) => ({ label: labels[value], value }));
}

function getAfterSubscribeActionField(
  subredditType: unknown,
  context: "after-subscribe" | "cta" = "after-subscribe",
  isNsfw = false,
  language: SubGoalLanguage = defaultSubGoalLanguage,
) {
  const options = [
    {
      label: translate(language, "moderator.followUp.topPost"),
      value: "top-post-day",
    },
    {
      label: translate(language, "moderator.followUp.newestPost"),
      value: "newest-post",
    },
    {
      label: translate(language, "moderator.followUp.createPost"),
      value: "create-post",
    },
    {
      label: translate(language, "moderator.followUp.sharePicture"),
      value: "share-picture",
    },
    {
      label: translate(language, "moderator.followUp.discord"),
      value: "discord",
    },
    {
      label: translate(language, "moderator.followUp.web"),
      value: "web-link",
    },
    {
      label: translate(language, "moderator.followUp.wiki"),
      value: "wiki",
    },
  ].filter(
    ({ value }) =>
      !isNsfw || (value !== "top-post-day" && value !== "newest-post"),
  );
  return {
    name: "afterSubscribePreset",
    label:
      context === "cta"
        ? translate(language, "moderator.followUp.actionCta")
        : translate(language, "moderator.followUp.action"),
    type: "select" as const,
    defaultValue: [
      isNsfw ? "create-post" : getDefaultAfterSubscribePreset(subredditType),
    ],
    options,
    helpText:
      context === "cta"
        ? translate(language, "moderator.followUp.actionCtaHelp")
        : translate(language, "moderator.followUp.actionHelp"),
    required: true,
  };
}

function normalizeAfterSubscribePresetForNsfw(
  preset: AfterSubscribePreset,
  isNsfw: boolean,
): AfterSubscribePreset {
  return isNsfw && (preset === "top-post-day" || preset === "newest-post")
    ? "create-post"
    : preset;
}

function getAfterSubscribePresetDefaults(
  preset: AfterSubscribePreset,
  language: (typeof subGoalLanguages)[number],
): {
  buttonText: string;
  colorTheme: (typeof subGoalColorThemes)[number];
  showUrl: boolean;
} {
  const messages = getAfterSubscribePresetMessages(language);
  switch (preset) {
    case "discord":
      return {
        buttonText: messages.joinDiscord,
        colorTheme: defaultAfterSubscribeColorTheme,
        showUrl: true,
      };
    case "top-post-day":
      return {
        buttonText: messages.viewTopPostToday,
        colorTheme: defaultAfterSubscribeColorTheme,
        showUrl: false,
      };
    case "wiki":
      return {
        buttonText: messages.readWiki,
        colorTheme: defaultAfterSubscribeColorTheme,
        showUrl: true,
      };
    case "create-post":
      return {
        buttonText: messages.createNewPost,
        colorTheme: defaultAfterSubscribeColorTheme,
        showUrl: false,
      };
    case "share-picture":
      return {
        buttonText: messages.sharePicture,
        colorTheme: defaultAfterSubscribeColorTheme,
        showUrl: false,
      };
    case "newest-post":
      return {
        buttonText: messages.viewMostRecentPostToday,
        colorTheme: defaultAfterSubscribeColorTheme,
        showUrl: false,
      };
    case "web-link":
      return {
        buttonText: "",
        colorTheme: defaultAfterSubscribeColorTheme,
        showUrl: true,
      };
  }
}

async function submitCreateGoalStepTwo(
  values: CreateGoalDetailsValues,
  expectedKind: CreateGoalPostKind,
  res: Response<UiResponse>,
): Promise<void> {
  const userId = context.userId;
  let requestLanguage: unknown = await resolveCurrentSubredditLanguage();
  if (!userId) {
    await respondWithCreateGoalRestart(
      res,
      translate(requestLanguage, "moderator.form.restartLogin"),
    );
    return;
  }
  try {
    const draft = await getCreateGoalDraft(redis, userId);
    requestLanguage = draft?.language ?? requestLanguage;
    const draftKind =
      draft?.postHeight === "tiny"
        ? "subscribe-only"
        : draft?.postHeight === "cta"
          ? "cta-only"
          : "subscriber-goal";
    if (!draft || draft.stage !== "details" || draftKind !== expectedKind) {
      await respondWithCreateGoalRestart(
        res,
        translate(draft?.language, "moderator.form.expired"),
      );
      return;
    }

    const subreddit = await reddit.getCurrentSubreddit();
    const postTitle = values.postTitle?.trim();
    if (!postTitle) {
      res.json({
        showToast: translate(
          draft.language,
          "moderator.form.postTitleRequired",
        ),
      });
      return;
    }
    const colorTheme = resolveSubGoalColorTheme(
      "colorTheme" in values ? values.colorTheme?.[0] : undefined,
    );
    const requestedPreset = values.afterSubscribePreset?.[0];
    const selectedPreset = isAfterSubscribePreset(requestedPreset)
      ? requestedPreset
      : getDefaultAfterSubscribePreset(subreddit.type);
    const afterSubscribePreset = normalizeAfterSubscribePresetForNsfw(
      selectedPreset,
      getCurrentSubredditNsfw(subreddit) === true,
    );
    let details: CreateGoalDraftDetails;
    if (expectedKind === "subscribe-only") {
      details = {
        kind: "subscribe-only",
        postTitle,
        colorTheme,
        afterSubscribePreset,
      };
    } else if (expectedKind === "cta-only") {
      details = {
        kind: "cta-only",
        postTitle,
        afterSubscribePreset,
      };
    } else {
      const subscriberGoal =
        "subscriberGoal" in values ? values.subscriberGoal : undefined;
      if (!subscriberGoal || subreddit.numberOfSubscribers >= subscriberGoal) {
        res.json({
          showToast: translate(draft.language, "moderator.form.goalInvalid"),
        });
        return;
      }
      const appSettings = getAppSettings();
      const sourceSubredditNsfw = getCurrentSubredditNsfw(subreddit);
      const defaultCrosspost =
        sourceSubredditNsfw === false &&
        subreddit.name.toLowerCase() !==
          appSettings.promoSubreddit.toLowerCase();
      details = {
        kind: "subscriber-goal",
        postTitle,
        subscriberGoal,
        colorTheme,
        crosspost:
          "crosspost" in values && typeof values.crosspost === "boolean"
            ? values.crosspost
            : defaultCrosspost,
        afterSubscribePreset,
        autoCreateNextGoal:
          !("autoCreateNextGoal" in values) ||
          values.autoCreateNextGoal !== false,
      };
    }

    const nextDraft = {
      stage: "follow-up" as const,
      language: draft.language,
      postHeight: draft.postHeight,
      subredditDisplayName: draft.subredditDisplayName,
      customDeveloperField: draft.customDeveloperField,
      details,
    };
    await saveCreateGoalDraft(redis, userId, nextDraft);
    res.json({
      showForm: buildCreateGoalFollowUpForm({ version: 4, ...nextDraft }),
    });
  } catch (error) {
    logDiagnostic(
      "error",
      "internal_ui_failed",
      { workflow: "create_goal", phase: "follow_up_form" },
      error,
    );
    res.json({
      showToast: translate(
        requestLanguage,
        "moderator.form.prepareFollowUpFailed",
      ),
    });
  }
}

async function submitCreateGoalFollowUp(
  values: CreateGoalFollowUpValues,
  expectedKind: CreateGoalPostKind,
  res: Response<UiResponse>,
): Promise<void> {
  const userId = context.userId;
  let requestLanguage: unknown = await resolveCurrentSubredditLanguage();
  if (!userId) {
    await respondWithCreateGoalRestart(
      res,
      translate(requestLanguage, "moderator.form.restartLogin"),
    );
    return;
  }
  try {
    const draft = await getCreateGoalDraft(redis, userId);
    requestLanguage = draft?.language ?? requestLanguage;
    if (
      !draft ||
      draft.stage !== "follow-up" ||
      draft.details.kind !== expectedKind
    ) {
      await respondWithCreateGoalRestart(
        res,
        translate(draft?.language, "moderator.form.expired"),
      );
      return;
    }

    const developerCommands = parseDeveloperCommands(
      values.customDeveloperField ?? "",
    );
    for (const command of developerCommands.ignoredCommands) {
      console.info(
        `[developerField] ignored unknown create-goal command: command=${command}`,
      );
    }
    for (const warning of developerCommands.warnings) {
      logDiagnostic("warn", "developer_command_warning", {
        workflow: "developer_command",
        phase: "validation",
        category: warning,
      });
    }

    const subreddit = await reddit.getCurrentSubreddit();
    const displayNameError = validateSubredditDisplayName(
      draft.subredditDisplayName,
      subreddit.name,
      draft.language,
    );
    if (displayNameError) {
      res.json({ showToast: displayNameError });
      return;
    }
    if (
      draft.details.kind === "subscriber-goal" &&
      subreddit.numberOfSubscribers >= draft.details.subscriberGoal
    ) {
      res.json({
        showToast: translate(draft.language, "moderator.form.goalInvalid"),
      });
      return;
    }
    if (developerCommands.selfPost) {
      const submitted = await submitExperimentalSelfPost(subreddit, res);
      if (submitted) {
        await safelyDeleteCreateGoalDraft(userId);
      }
      return;
    }

    const isNsfw = getCurrentSubredditNsfw(subreddit) === true;
    const normalizedPreset = normalizeAfterSubscribePresetForNsfw(
      draft.details.afterSubscribePreset,
      isNsfw,
    );
    const replacedNsfwDynamicPreset =
      normalizedPreset !== draft.details.afterSubscribePreset;
    const presetDefaults = getAfterSubscribePresetDefaults(
      normalizedPreset,
      draft.language,
    );
    const resolvedActionInput = resolvePresetActionInput(
      normalizedPreset,
      subreddit.name,
      values.afterSubscribeUrl,
    );
    const invalidConfigurationFallback = isNsfw
      ? createDefaultCreatePostAction({
          language: draft.language,
          subredditName: subreddit.name,
        })
      : createDefaultAfterSubscribeAction({
          language: draft.language,
          subredditName: subreddit.name,
          subredditType: subreddit.type,
        });
    const afterSubscribeResult = resolveAfterSubscribeAction({
      type: resolvedActionInput.type,
      buttonText: replacedNsfwDynamicPreset
        ? presetDefaults.buttonText
        : (values.afterSubscribeButtonText ?? presetDefaults.buttonText),
      url: resolvedActionInput.url,
      colorTheme: replacedNsfwDynamicPreset
        ? presetDefaults.colorTheme
        : (values.afterSubscribeColorTheme?.[0] ?? presetDefaults.colorTheme),
      fallbackColorTheme:
        draft.details.kind === "cta-only"
          ? defaultAfterSubscribeColorTheme
          : draft.details.colorTheme,
      invalidConfigurationFallback,
    });
    const persistedAfterSubscribePreset =
      afterSubscribeResult.invalidConfiguration
        ? isNsfw
          ? "create-post"
          : getDefaultAfterSubscribePreset(subreddit.type)
        : normalizedPreset;
    const appSettings = getAppSettings();
    const autoCreateNextGoal =
      draft.details.kind === "subscriber-goal"
        ? draft.details.autoCreateNextGoal
        : false;
    const { post, crosspostDispatchResult, highlightResult, flairResult } =
      await createSubscriberGoal({
        reddit,
        redis,
        appSettings,
        options: {
          title: draft.details.postTitle,
          ...(draft.details.kind === "subscriber-goal"
            ? { goal: draft.details.subscriberGoal }
            : {}),
          subredditDisplayName: draft.subredditDisplayName,
          crosspost:
            draft.details.kind === "subscriber-goal"
              ? draft.details.crosspost
              : false,
          colorTheme:
            draft.details.kind === "cta-only" &&
            afterSubscribeResult.action.type !== "disabled"
              ? afterSubscribeResult.action.colorTheme
              : draft.details.kind === "cta-only"
                ? defaultAfterSubscribeColorTheme
                : draft.details.colorTheme,
          postHeight: draft.postHeight,
          autoCreateNextGoal,
          language: draft.language,
          afterSubscribeAction: afterSubscribeResult.action,
          afterSubscribePreset: persistedAfterSubscribePreset,
          cancelPendingAutoCreateGoals: true,
          operationId: `manual:${subreddit.id}:${userId}:${stableDraftFingerprint(
            {
              draft,
              afterSubscribeAction: afterSubscribeResult.action,
              submitAsUser: developerCommands.submitAsUser,
              headerText: developerCommands.headerText,
            },
          )}`,
          submitAsUser: developerCommands.submitAsUser,
          ...(developerCommands.headerText
            ? { headerText: developerCommands.headerText }
            : {}),
        },
      });

    await safelyDeleteCreateGoalDraft(userId);
    const crosspost =
      draft.details.kind === "subscriber-goal"
        ? draft.details.crosspost
        : false;
    console.info(
      `[crosspost] goal post created: postId=${post.id} subreddit=${subreddit.name} promoSubreddit=${appSettings.promoSubreddit} crosspost=${crosspost}`,
    );
    if (highlightResult.issues.length > 0) {
      logDiagnostic("warn", "manual_goal_highlight_degraded", {
        workflow: "internal_ui",
        phase: "highlight",
        postId: post.id,
        failureCategories: highlightResult.issues
          .map(({ category }) => category)
          .join(","),
        capacityOutcome: highlightResult.capacityOutcome,
        cleanupOutcome: highlightResult.cleanupOutcome,
        rollbackOutcome: highlightResult.rollbackOutcome,
        reorderOutcome: highlightResult.reorderOutcome,
      });
      const moderatorUsername = await resolveCurrentUsername();
      await notifyHighlightFailure({
        reddit,
        subredditId: subreddit.id,
        subredditName: subreddit.name,
        moderatorUsername,
        postTitle: post.title ?? draft.details.postTitle,
        postUrl: getPostUrl(post),
        errorMessage: highlightResult.errorMessage,
        highlightResult,
        language: draft.language,
      });
    }

    const createdPostLabel =
      draft.details.kind === "cta-only"
        ? translate(draft.language, "moderator.create.ctaLabel")
        : translate(draft.language, "moderator.create.goalLabel");
    const baseToast =
      highlightResult.issues.length > 0
        ? translate(draft.language, "moderator.create.degraded", {
            postType: createdPostLabel,
            details: describeHighlightResult(highlightResult, draft.language),
          })
        : crosspostDispatchResult.status === "failed"
          ? translate(draft.language, "moderator.create.crosspostFailed", {
              postType: createdPostLabel,
              subredditName: appSettings.promoSubreddit,
            })
          : translate(draft.language, "moderator.create.success", {
              postType: createdPostLabel,
            });
    const flairWarning =
      flairResult.status === "omitted"
        ? ` ${translate(draft.language, "moderator.create.flairWarning")}`
        : "";
    const configurationWarning = afterSubscribeResult.invalidConfiguration
      ? ` ${translate(draft.language, "moderator.create.configurationWarning")}`
      : "";
    res.json({
      showToast: `${baseToast}${flairWarning}${configurationWarning}`,
      navigateTo: `https://reddit.com/r/${subreddit.name}/comments/${post.id}`,
    });
  } catch (error) {
    logDiagnostic(
      "error",
      "create_goal_failed",
      {
        workflow: "create_goal",
        phase: "post_creation",
        postId: context.postId,
      },
      error,
    );
    res.json({
      showToast:
        error instanceof ProhibitedSubredditError ||
        error instanceof SubscriberGoalModeratorPermissionError ||
        error instanceof SubscriberGoalCreationInProgressError
          ? error.message
          : translate(requestLanguage, "moderator.form.creationFailed"),
    });
  }
}

function resolvePresetActionInput(
  preset: AfterSubscribePreset,
  subredditName: string,
  submittedUrl: string | undefined,
): { type: AfterSubscribeActionType; url?: string } {
  if (preset === "top-post-day" || preset === "newest-post") {
    return { type: preset };
  }
  if (preset === "create-post" || preset === "share-picture") {
    return {
      type: "link",
      url: `https://www.reddit.com/r/${subredditName}/submit/`,
    };
  }
  return {
    type: "link",
    ...(submittedUrl !== undefined ? { url: submittedUrl } : {}),
  };
}

async function respondWithCreateGoalRestart(
  res: Response<UiResponse>,
  showToast: string,
): Promise<void> {
  try {
    res.json({ showToast, showForm: await buildCreateGoalSetupForm() });
  } catch (error) {
    logDiagnostic(
      "error",
      "internal_ui_failed",
      { workflow: "create_goal", phase: "restart_form" },
      error,
    );
    res.json({ showToast });
  }
}

async function safelyDeleteCreateGoalDraft(userId: string): Promise<void> {
  try {
    await deleteCreateGoalDraft(redis, userId);
  } catch (error) {
    logDiagnostic(
      "warn",
      "create_goal_draft_cleanup_failed",
      { workflow: "create_goal", phase: "completed_draft_cleanup" },
      error,
    );
  }
}

async function resolveCurrentUsername(): Promise<string | undefined> {
  try {
    const username = await reddit.getCurrentUsername();
    if (username) {
      return username;
    }
  } catch (error) {
    logDiagnostic(
      "warn",
      "username_resolution_failed",
      { workflow: "highlight_notification", phase: "username_lookup" },
      error,
    );
  }

  return undefined;
}

async function submitExperimentalSelfPost(
  subreddit: {
    name: string;
    numberOfSubscribers: number;
    language?: unknown;
  },
  res: Response<UiResponse>,
): Promise<boolean> {
  let username: string | undefined;
  try {
    username = await reddit.getCurrentUsername();
  } catch (error) {
    logDiagnostic(
      "warn",
      "developer_command_failed",
      { workflow: "self_post", phase: "username_lookup" },
      error,
    );
  }

  if (!username) {
    res.json({
      showToast: translate(
        subreddit.language,
        "moderator.developer.loginRequired",
      ),
    });
    return false;
  }

  const targetSubreddit = `u_${username}`;
  const title = translate(subreddit.language, "moderator.developer.title", {
    subredditName: subreddit.name,
  });
  const text = translate(subreddit.language, "moderator.developer.body", {
    subredditName: subreddit.name,
    subscriberCount: subreddit.numberOfSubscribers,
    username,
    targetSubreddit,
  });

  try {
    const post = await reddit.submitPost({
      subredditName: targetSubreddit,
      title,
      text,
      runAs: "USER",
    });
    const postUrl =
      getPostUrl(post) ??
      (post.id
        ? `https://reddit.com/r/${targetSubreddit}/comments/${post.id}`
        : undefined);

    res.json({
      showToast: translate(subreddit.language, "moderator.developer.success", {
        targetSubreddit,
      }),
      ...(postUrl ? { navigateTo: postUrl } : {}),
    });
    return true;
  } catch (error) {
    logDiagnostic(
      "error",
      "developer_command_failed",
      { workflow: "self_post", phase: "submission" },
      error,
    );
    res.json({
      showToast: translate(subreddit.language, "moderator.developer.failed"),
    });
    return false;
  }
}
