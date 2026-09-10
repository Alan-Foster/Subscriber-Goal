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
import {
  defaultSubGoalPostHeight,
  subGoalPostHeights,
} from "../../shared/subGoalPostHeight";
import {
  getAfterSubscribePresetMessages,
  getSubGoalPostMessages,
  resolveSubGoalLanguage,
  subGoalLanguages,
  subGoalPostMessages,
} from "../../shared/subGoalPostI18n";
import { formNames, internalRoutes } from "../../shared/routes";
import {
  createSubscriberGoal,
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
import { cancelUpdates, untrackPost } from "../data/updaterData";
import { removeSubscriberGoalPost } from "../data/subscriberGoalPostRegistry";
import { getAppSettings } from "../settings";
import { getDefaultSubscriberGoal } from "../utils/numberUtils";
import {
  getPostUrl,
  notifyStickyFailure,
} from "../utils/stickyFailureNotifications";
import { validateSubredditDisplayName } from "../utils/subredditDisplayName";
import { parseDeveloperCommands } from "../utils/developerCommands";
import { ProhibitedSubredditError } from "../utils/subredditBlacklist";
import { SubscriberGoalStickyCleanupError } from "../utils/redditUtils";
import { createOperationId, logDiagnostic } from "../../shared/diagnostics";
import {
  createDefaultAfterSubscribeAction,
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

export function registerInternalUiRoutes(router: Router): void {
  router.post(
    internalRoutes.menu.createGoal,
    async (_req, res: Response<UiResponse>) => {
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
        res.json({ showForm: await buildCreateGoalSetupForm() });
      } catch (error) {
        logDiagnostic(
          "error",
          "internal_ui_failed",
          { workflow: "create_goal", phase: "setup_form" },
          error,
        );
        res.json({ showToast: "Error preparing the create-post form." });
      }
    },
  );

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
          showToast: "Please select a valid language and post height.",
        });
        return;
      }
      if (!userId) {
        res.json({ showToast: "Please log in to create a Sub Goal post." });
        return;
      }
      try {
        const subreddit = await reddit.getCurrentSubreddit();
        const displayNameError = validateSubredditDisplayName(
          subredditDisplayName,
          subreddit.name,
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
        res.json({ showToast: "Error preparing the post details form." });
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
      res.json({
        showForm: {
          name: formNames.deleteGoal,
          form: {
            title: "Sub Goal - Delete This Post",
            description:
              "This will permanently delete the Sub Goal post. If you wish to temporarily hide the post, you can remove it as a moderator and re-approve it later.",
            fields: [
              {
                name: "confirm",
                label: "Are you sure?",
                type: "boolean",
                defaultValue: false,
                helpText: "This action is irreversible.",
              },
            ],
            acceptLabel: "Delete",
            cancelLabel: "Cancel",
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
            showToast:
              "You did not confirm the deletion. If that was a mistake, please try again and enable the confirmation toggle before hitting delete.",
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
            showToast: `Deletion metadata was somehow lost. Please try again. Reference: ${operationId}`,
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
        await runCleanupPhase("update_cancellation", () =>
          cancelUpdates(redis, postId),
        );
        await runCleanupPhase("post_untracking", () =>
          untrackPost(redis, postId),
        );
        await runCleanupPhase("registry_cleanup", () =>
          removeSubscriberGoalPost(redis, postId),
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
            showToast: `The post was deleted, but some cleanup is still pending. Reference: ${operationId}`,
          });
          return;
        }
        res.json({ showToast: "Post deleted successfully!" });
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
          showToast: `Error deleting post. Please refresh the page and try again. Reference: ${operationId}`,
        });
      }
    },
  );

  router.post(
    internalRoutes.menu.eraseData,
    async (_req, res: Response<UiResponse>) => {
      res.json({
        showForm: {
          name: formNames.eraseData,
          form: {
            title: "Sub Goal - Erase Another User's Data",
            description:
              "This moderator action will erase all data stored by Sub Goal for the specified user.",
            fields: [
              {
                name: "username",
                label: "Username",
                type: "string",
                helpText:
                  "Erase all data associated with this username. Please note that in some cases this may be case sensitive, so it should be entered exactly as it appears in their Reddit profile link.",
                required: false,
              },
              {
                name: "userId",
                label: "User ID",
                type: "string",
                helpText:
                  "Erase all data associated with this user ID. If left blank, this field will be fetched based on the specified username.",
                required: false,
              },
              {
                name: "confirm",
                label: "Are you sure?",
                type: "boolean",
                defaultValue: false,
                helpText: "This action is irreversible.",
              },
            ],
            acceptLabel: "Erase",
            cancelLabel: "Cancel",
          },
        },
      });
    },
  );

  router.post(
    internalRoutes.menu.eraseMyData,
    async (_req, res: Response<UiResponse>) => {
      res.json({
        showForm: {
          name: formNames.eraseMyData,
          form: {
            title: "Sub Goal - Erase My User Data",
            description:
              "This will erase all data stored by Sub Goal for your Reddit account.",
            fields: [
              {
                name: "confirm",
                label: "Remove all of my Sub Goal user data",
                type: "boolean",
                defaultValue: false,
                helpText: "This action is irreversible.",
              },
            ],
            acceptLabel: "Erase My Data",
            cancelLabel: "Cancel",
          },
        },
      });
    },
  );

  router.post(
    internalRoutes.forms.eraseData,
    async (req, res: Response<UiResponse>) => {
      const { username, userId, confirm } = req.body as EraseDataFormValues;

      if (!confirm) {
        res.json({
          showToast:
            "You did not confirm the erasure. Please enable the confirmation toggle before proceeding.",
        });
        return;
      }

      if (!username && !userId) {
        res.json({
          showToast:
            "User details were not provided. Please enter a username, user ID, or both.",
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
        identityLookupWarning =
          "Reddit identity lookup failed, so some associated data may remain. Please retry with the user ID if possible.";
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
              showToast:
                "Recent subscriber references were erased where indexed. Subscriber stats could not be fully erased by username; please try again with the user ID if possible.",
            });
            return;
          }
        }

        if (resolvedUsername) {
          await eraseFromRecentSubscribers(redis, resolvedUsername);
        }

        if (identityLookupWarning) {
          res.json({
            showToast: `Available user data was erased. ${identityLookupWarning}`,
          });
          return;
        }

        res.json({ showToast: "User data has been erased successfully." });
      } catch (error) {
        logDiagnostic(
          "error",
          "erase_user_data_failed",
          { workflow: "erase_user_data", phase: "erasure" },
          error,
        );
        res.json({
          showToast:
            "User data could not be fully erased. Please try again with the user ID.",
        });
      }
    },
  );

  router.post(
    internalRoutes.forms.eraseMyData,
    async (req, res: Response<UiResponse>) => {
      const operationId = createOperationId("erase-self");
      let phase = "request_validation";
      try {
        const { confirm } = (req.body ?? {}) as EraseMyDataFormValues;
        if (!confirm) {
          res.json({
            showToast:
              "You did not confirm the erasure. Please enable the confirmation toggle before proceeding.",
          });
          return;
        }

        const currentUserId = context.userId;
        if (!currentUserId) {
          res.json({
            showToast: "Please log in to erase your Sub Goal user data.",
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
        res.json({ showToast: "Your Sub Goal user data has been erased." });
      } catch (error) {
        logDiagnostic(
          "error",
          "erase_self_failed",
          { operationId, workflow: "erase_self", phase },
          error,
        );
        res.json({
          showToast: `Your Sub Goal user data could not be fully erased. Reference: ${operationId}`,
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

async function buildCreateGoalSetupForm(): Promise<
  NonNullable<UiResponse["showForm"]>
> {
  const subreddit = await reddit.getCurrentSubreddit();
  const defaultLanguage = resolveSubGoalLanguage(subreddit.language);
  const savedDisplayName = await getSavedSubredditDisplayName(redis);
  return {
    name: formNames.createGoalSetup,
    form: {
      title: "Sub Goal - Step 1/3 - Choose Post Type",
      description:
        "Choose the shared post settings. You will customize the post on the next two pages.",
      acceptLabel: "Next",
      cancelLabel: "Cancel",
      fields: [
        {
          name: "language",
          label: "Language",
          type: "select",
          defaultValue: [defaultLanguage],
          options: subGoalLanguages.map((language) => ({
            label: subGoalPostMessages[language].languageLabel,
            value: language,
          })),
          helpText: "This controls the language used in the post.",
          required: true,
        },
        {
          name: "subredditDisplayName",
          label: "Customize Subreddit Name Capitalization",
          type: "string",
          defaultValue: savedDisplayName ?? subreddit.name,
          helpText:
            "Only capitalization may be changed. The customized name is used in the default post title.",
          required: true,
        },
        {
          name: "postHeight",
          label: "Post Height",
          type: "select",
          defaultValue: [defaultSubGoalPostHeight],
          options: [
            { label: "Full Height Subscriber Goal", value: "regular" },
            { label: "Short Subscriber Goal (No Logo)", value: "short" },
            {
              label: "Subscribe Button and CTA Button (No Goal)",
              value: "tiny",
            },
            {
              label: "CTA Button (No Subscribing at all)",
              value: "cta",
            },
          ],
          helpText:
            "Choose a subscriber goal, a subscribe button with a follow-up CTA, or a CTA with no subscribing.",
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
    isNsfw?: boolean;
  },
): NonNullable<UiResponse["showForm"]> {
  const defaultPostTitle = getSubGoalPostMessages(
    draft.language,
  ).defaultPostTitle({ subredditName: draft.subredditDisplayName });
  const commonFields = {
    postTitle: {
      name: "postTitle",
      label: "Post Title",
      type: "string" as const,
      defaultValue: defaultPostTitle,
      helpText:
        "This will be used as the title of the post. You can customize it as you see fit.",
      required: true,
    },
  };
  const colorOptions = getColorOptions();

  if (draft.postHeight === "tiny") {
    return {
      name: formNames.createSubscribeOnly,
      form: {
        title: "Sub Goal - Step 2/3 - Subscribe-Only Details",
        description: "Customize the Tiny subscribe-only post.",
        acceptLabel: "Next",
        cancelLabel: "Cancel",
        fields: [
          commonFields.postTitle,
          {
            name: "colorTheme",
            label: "Subscribe Button Color",
            type: "select",
            defaultValue: [defaultSubGoalColorTheme],
            options: colorOptions,
            helpText:
              "This controls the subscribe button and button glow color.",
            required: true,
          },
          getAfterSubscribeActionField(subreddit.type),
        ],
      },
    };
  }

  if (draft.postHeight === "cta") {
    return {
      name: formNames.createCtaOnly,
      form: {
        title: "Sub Goal - Step 2/3 - CTA Details",
        description: "Customize the CTA-only post.",
        acceptLabel: "Next",
        cancelLabel: "Cancel",
        fields: [
          commonFields.postTitle,
          getAfterSubscribeActionField(subreddit.type, "cta"),
        ],
      },
    };
  }

  const appSettings = getAppSettings();
  const sourceSubredditIsNsfw = subreddit.isNsfw === true;
  const shouldCrosspost =
    !sourceSubredditIsNsfw &&
    subreddit.name.toLowerCase() !== appSettings.promoSubreddit.toLowerCase();
  const crosspostHelpText = sourceSubredditIsNsfw
    ? "Crossposting is disabled for NSFW source subreddits."
    : `Keep this enabled to announce your goal in the r/${appSettings.promoSubreddit} index subreddit.`;

  return {
    name: formNames.createSubscriberGoal,
    form: {
      title: "Sub Goal - Step 2/3 - Subscriber Goal Details",
      description: `Customize the ${draft.postHeight === "short" ? "Short" : "Regular"} subscriber goal.`,
      acceptLabel: "Next",
      cancelLabel: "Cancel",
      fields: [
        commonFields.postTitle,
        {
          name: "subscriberGoal",
          label: "Enter your Subscriber Goal",
          type: "number",
          defaultValue: getDefaultSubscriberGoal(subreddit.numberOfSubscribers),
          helpText:
            "The default is a suggestion based on your current subscriber count.",
          required: true,
        },
        {
          name: "colorTheme",
          label: "Subscribe Button Color",
          type: "select",
          defaultValue: [defaultSubGoalColorTheme],
          options: colorOptions,
          helpText:
            "This controls the subscribe button, progress bar, and button glow color.",
          required: true,
        },
        getAfterSubscribeActionField(subreddit.type),
        {
          name: "autoCreateNextGoal",
          label: "Create a New Subscriber Goal 24 Hours after Goal Success",
          type: "boolean",
          helpText:
            "Once the milestone is reached, automatically create a goal for the next milestone.",
          defaultValue: true,
        },
        {
          name: "crosspost",
          label: `Auto-Crosspost to r/${appSettings.promoSubreddit} (Recommended)`,
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
        ? "CTA Button Text"
        : "Button Text After a User Subscribes",
      type: "string" as const,
      ...(presetDefaults.buttonText
        ? { defaultValue: presetDefaults.buttonText }
        : {}),
      helpText: "Recommended: 6-24 characters. Accepted: 5-50 characters.",
      required: false,
    },
    ...(presetDefaults.showUrl
      ? [
          {
            name: "afterSubscribeUrl",
            label: "URL Link",
            type: "string" as const,
            helpText: "Enter a complete secure https:// URL.",
            required: false,
          },
        ]
      : []),
    {
      name: "afterSubscribeColorTheme",
      label: isCtaOnly ? "CTA Button Color" : "After-Subscribed Button Color",
      type: "select" as const,
      defaultValue: [presetDefaults.colorTheme],
      options: getColorOptions(),
      helpText: "This controls the after-subscribed button color.",
      required: true,
    },
    {
      name: "customDeveloperField",
      label: "Custom Developer Field",
      type: "string" as const,
      helpText:
        "This field is for developers and testing only. Please leave this field empty.",
      required: false,
    },
  ];

  if (draft.details.kind === "subscribe-only") {
    return {
      name: formNames.createSubscribeOnlyFollowUp,
      form: {
        title: "Sub Goal - Step 3/3 - Settings for After Subscribing",
        description: "Choose what subscribed users will see and do.",
        acceptLabel: "Create",
        cancelLabel: "Cancel",
        fields: sharedFields,
      },
    };
  }

  if (draft.details.kind === "cta-only") {
    return {
      name: formNames.createCtaOnlyFollowUp,
      form: {
        title: "Sub Goal - Step 3/3 - CTA Button Settings",
        description: "Customize the CTA shown immediately to every viewer.",
        acceptLabel: "Create",
        cancelLabel: "Cancel",
        fields: sharedFields,
      },
    };
  }

  return {
    name: formNames.createSubscriberGoalFollowUp,
    form: {
      title: "Sub Goal - Step 3/3 - Settings for After Subscribing",
      description:
        "Choose what happens after a user subscribes or the goal succeeds.",
      acceptLabel: "Create",
      cancelLabel: "Cancel",
      fields: sharedFields,
    },
  };
}

function getColorOptions(): Array<{ label: string; value: string }> {
  const labels: Record<(typeof subGoalColorThemes)[number], string> = {
    red: "Red",
    green: "Green",
    purple: "Purple",
    blue: "Blue",
    pink: "Pink",
  };
  return subGoalColorThemes.map((value) => ({ label: labels[value], value }));
}

function getAfterSubscribeActionField(
  subredditType: unknown,
  context: "after-subscribe" | "cta" = "after-subscribe",
) {
  return {
    name: "afterSubscribePreset",
    label:
      context === "cta"
        ? "What Should the CTA Button Do?"
        : "What Should the Button Do After Subscription?",
    type: "select" as const,
    defaultValue: [getDefaultAfterSubscribePreset(subredditType)],
    options: [
      { label: "Link to the Top Post Today", value: "top-post-day" },
      {
        label: "Link to the Most Recent Post Today",
        value: "newest-post",
      },
      { label: "Link to Create a New Text Post", value: "create-post" },
      {
        label: "Link to Create a New Image Post",
        value: "share-picture",
      },
      { label: "Link to a Discord Server", value: "discord" },
      { label: "Link to a Webpage URL", value: "web-link" },
      { label: "Link to the Subreddit Wiki", value: "wiki" },
    ],
    helpText:
      context === "cta"
        ? "Choose what every viewer can do from the post."
        : "Choose what subscribed users can do from the post.",
    required: true,
  };
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
  if (!userId) {
    await respondWithCreateGoalRestart(
      res,
      "Please log in and restart the create-post flow.",
    );
    return;
  }
  try {
    const draft = await getCreateGoalDraft(redis, userId);
    const draftKind =
      draft?.postHeight === "tiny"
        ? "subscribe-only"
        : draft?.postHeight === "cta"
          ? "cta-only"
          : "subscriber-goal";
    if (!draft || draft.stage !== "details" || draftKind !== expectedKind) {
      await respondWithCreateGoalRestart(
        res,
        "Your post setup expired or no longer matches this form. Please begin again.",
      );
      return;
    }

    const subreddit = await reddit.getCurrentSubreddit();
    const postTitle = values.postTitle?.trim();
    if (!postTitle) {
      res.json({ showToast: "Please provide a post title!" });
      return;
    }
    const colorTheme = resolveSubGoalColorTheme(
      "colorTheme" in values ? values.colorTheme?.[0] : undefined,
    );
    const requestedPreset = values.afterSubscribePreset?.[0];
    const afterSubscribePreset = isAfterSubscribePreset(requestedPreset)
      ? requestedPreset
      : getDefaultAfterSubscribePreset(subreddit.type);
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
        res.json({ showToast: "Please select a valid subscriber goal!" });
        return;
      }
      const appSettings = getAppSettings();
      const sourceSubredditIsNsfw =
        (subreddit as { isNsfw?: boolean }).isNsfw === true;
      const defaultCrosspost =
        !sourceSubredditIsNsfw &&
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
    res.json({ showToast: "Error preparing the follow-up options form." });
  }
}

async function submitCreateGoalFollowUp(
  values: CreateGoalFollowUpValues,
  expectedKind: CreateGoalPostKind,
  res: Response<UiResponse>,
): Promise<void> {
  const userId = context.userId;
  if (!userId) {
    await respondWithCreateGoalRestart(
      res,
      "Please log in and restart the create-post flow.",
    );
    return;
  }
  try {
    const draft = await getCreateGoalDraft(redis, userId);
    if (
      !draft ||
      draft.stage !== "follow-up" ||
      draft.details.kind !== expectedKind
    ) {
      await respondWithCreateGoalRestart(
        res,
        "Your post setup expired or no longer matches this form. Please begin again.",
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
    );
    if (displayNameError) {
      res.json({ showToast: displayNameError });
      return;
    }
    if (
      draft.details.kind === "subscriber-goal" &&
      subreddit.numberOfSubscribers >= draft.details.subscriberGoal
    ) {
      res.json({ showToast: "Please select a valid subscriber goal!" });
      return;
    }
    if (developerCommands.selfPost) {
      const submitted = await submitExperimentalSelfPost(subreddit, res);
      if (submitted) {
        await safelyDeleteCreateGoalDraft(userId);
      }
      return;
    }

    const presetDefaults = getAfterSubscribePresetDefaults(
      draft.details.afterSubscribePreset,
      draft.language,
    );
    const resolvedActionInput = resolvePresetActionInput(
      draft.details.afterSubscribePreset,
      subreddit.name,
      values.afterSubscribeUrl,
    );
    const invalidConfigurationFallback = createDefaultAfterSubscribeAction({
      language: draft.language,
      subredditName: subreddit.name,
      subredditType: subreddit.type,
    });
    const afterSubscribeResult = resolveAfterSubscribeAction({
      type: resolvedActionInput.type,
      buttonText: values.afterSubscribeButtonText ?? presetDefaults.buttonText,
      url: resolvedActionInput.url,
      colorTheme:
        values.afterSubscribeColorTheme?.[0] ?? presetDefaults.colorTheme,
      fallbackColorTheme:
        draft.details.kind === "cta-only"
          ? defaultAfterSubscribeColorTheme
          : draft.details.colorTheme,
      invalidConfigurationFallback,
    });
    const persistedAfterSubscribePreset =
      afterSubscribeResult.invalidConfiguration
        ? getDefaultAfterSubscribePreset(subreddit.type)
        : draft.details.afterSubscribePreset;
    const appSettings = getAppSettings();
    const autoCreateNextGoal =
      draft.details.kind === "subscriber-goal"
        ? draft.details.autoCreateNextGoal
        : false;
    const { post, crosspostDispatchResult, stickyResult, flairResult } =
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
          operationId: `manual:${subreddit.id}:${userId}:${stableDraftFingerprint({
            draft,
            afterSubscribeAction: afterSubscribeResult.action,
            submitAsUser: developerCommands.submitAsUser,
            headerText: developerCommands.headerText,
          })}`,
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
    if (stickyResult.status === "not_pinned") {
      const moderatorUsername = await resolveCurrentUsername();
      await notifyStickyFailure({
        reddit,
        subredditId: subreddit.id,
        subredditName: subreddit.name,
        moderatorUsername,
        postTitle: post.title ?? draft.details.postTitle,
        postUrl: getPostUrl(post),
        errorMessage: stickyResult.errorMessage,
      });
    }

    const createdPostLabel =
      draft.details.kind === "cta-only" ? "CTA post" : "Subscriber Goal post";
    const baseToast =
      stickyResult.status === "not_pinned"
        ? `${createdPostLabel} created, but it could not be pinned. Manual moderator action is required.`
        : crosspostDispatchResult.status === "failed"
          ? `${createdPostLabel} created, but crosspost to r/${appSettings.promoSubreddit} failed. Moderators can retry.`
          : `${createdPostLabel} created!`;
    const flairWarning =
      flairResult.status === "omitted"
        ? " The post was created without Subscriber Goal flair; check the app account's Manage Flair permission."
        : "";
    const configurationWarning = afterSubscribeResult.invalidConfiguration
      ? " The button configuration was invalid, so the default action was used."
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
        error instanceof SubscriberGoalStickyCleanupError ||
        error instanceof SubscriberGoalModeratorPermissionError
          ? error.message
          : "An error occurred while creating the post.",
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
      { workflow: "sticky_notification", phase: "username_lookup" },
      error,
    );
  }

  return undefined;
}

async function submitExperimentalSelfPost(
  subreddit: { name: string; numberOfSubscribers: number },
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
      showToast:
        "The selfPost developer command requires an authenticated Reddit user.",
    });
    return false;
  }

  const targetSubreddit = `u_${username}`;
  const title = `Subscriber Goal test for r/${subreddit.name}`;
  const text =
    "This is an experimental Subscriber Goal self-post test.\n\n" +
    `Source subreddit: r/${subreddit.name}\n` +
    `Subscriber count: ${subreddit.numberOfSubscribers}\n` +
    `Executor: u/${username}\n` +
    `Target: r/${targetSubreddit}\n` +
    "Created via Devvit runAs: USER.";

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
      showToast: `Experimental selfPost submitted to r/${targetSubreddit}.`,
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
      showToast: "The experimental self-post could not be submitted.",
    });
    return false;
  }
}
