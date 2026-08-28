import type { Response, Router } from "express";
import type { UiResponse } from "@devvit/web/shared";
import { context, reddit, redis } from "@devvit/web/server";
import type {
  CreateGoalSetupFormValues,
  CreateSubscribeOnlyFormValues,
  CreateSubscriberGoalFormValues,
  DeleteGoalFormValues,
  EraseDataFormValues,
  EraseMyDataFormValues,
} from "../../shared/types/api";
import {
  defaultSubGoalColorTheme,
  resolveSubGoalColorTheme,
} from "../../shared/subGoalColorTheme";
import {
  defaultSubGoalPostHeight,
  subGoalPostHeights,
} from "../../shared/subGoalPostHeight";
import {
  defaultSubGoalLanguage,
  getSubGoalPostMessages,
  subGoalLanguages,
  subGoalPostMessages,
} from "../../shared/subGoalPostI18n";
import { formNames, internalRoutes } from "../../shared/routes";
import { createSubscriberGoal } from "../core/createSubscriberGoal";
import {
  deleteCreateGoalDraft,
  getCreateGoalDraft,
  saveCreateGoalDraft,
  type CreateGoalDraft,
} from "../data/createGoalDraft";
import { dispatchPostAction } from "../data/crosspostData";
import { eraseFromRecentSubscribers } from "../data/subGoalData";
import { getSavedSubredditDisplayName } from "../data/subredditDisplayNameData";
import {
  untrackSubscriberById,
  untrackSubscriberByUsername,
} from "../data/subscriberStats";
import { cancelUpdates, untrackPost } from "../data/updaterData";
import { getAppSettings } from "../settings";
import { getDefaultSubscriberGoal } from "../utils/numberUtils";
import {
  getPostUrl,
  notifyStickyFailure,
} from "../utils/stickyFailureNotifications";
import { validateSubredditDisplayName } from "../utils/subredditDisplayName";
import { parseDeveloperCommands } from "../utils/developerCommands";
import { toErrorMessage } from "../utils/crosspostLogs";

export function registerInternalUiRoutes(router: Router): void {
  router.post(
    internalRoutes.menu.createGoal,
    async (_req, res: Response<UiResponse>) => {
      if (context.userId) {
        try {
          await deleteCreateGoalDraft(redis, context.userId);
        } catch (error) {
          console.warn(
            `Failed to clear previous create-goal draft for userId=${context.userId}: ${String(error)}`,
          );
        }
      }
      res.json({ showForm: buildCreateGoalSetupForm() });
    },
  );

  router.post(
    internalRoutes.forms.createGoalSetup,
    async (req, res: Response<UiResponse>) => {
      const values = req.body as CreateGoalSetupFormValues;
      const language = values.language?.[0];
      const postHeight = values.postHeight?.[0];
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
        const draft = {
          language: language as (typeof subGoalLanguages)[number],
          postHeight: postHeight as (typeof subGoalPostHeights)[number],
        };
        await saveCreateGoalDraft(redis, userId, draft);
        res.json({
          showForm: await buildCreateGoalDetailsForm(draft),
        });
      } catch (error) {
        console.error("Error preparing create goal details form:", error);
        res.json({ showToast: "Error preparing the post details form." });
      }
    },
  );

  router.post(
    internalRoutes.forms.createSubscriberGoal,
    async (req, res: Response<UiResponse>) => {
      await submitCreateGoalDetails(
        req.body as CreateSubscriberGoalFormValues,
        "subscriber-goal",
        res,
      );
    },
  );

  router.post(
    internalRoutes.forms.createSubscribeOnly,
    async (req, res: Response<UiResponse>) => {
      await submitCreateGoalDetails(
        req.body as CreateSubscribeOnlyFormValues,
        "subscribe-only",
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
      const { confirm } = req.body as DeleteGoalFormValues;
      if (!confirm) {
        res.json({
          showToast:
            "You did not confirm the deletion. If that was a mistake, please try again and enable the confirmation toggle before hitting delete.",
        });
        return;
      }

      const postId = context.postId;
      const subredditName =
        context.subredditName ?? (await reddit.getCurrentSubreddit()).name;
      if (!postId || !subredditName) {
        res.json({
          showToast: "Deletion metadata was somehow lost. Please try again.",
        });
        return;
      }

      try {
        const post = await reddit.getPostById(postId);
        const appSettings = getAppSettings();
        if (
          subredditName.toLowerCase() !==
          appSettings.promoSubreddit.toLowerCase()
        ) {
          await dispatchPostAction(reddit, appSettings, postId, "delete");
        }
        await post.delete();
        await cancelUpdates(redis, postId);
        await untrackPost(redis, postId);
        res.json({ showToast: "Post deleted successfully!" });
      } catch (error) {
        console.error("Error deleting post:", error);
        res.json({
          showToast:
            "Error deleting post. Please refresh the page and try again.",
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
        console.log("Error fetching user details: ", error);
        res.json({
          showToast:
            "Could not fetch all user details. Deletion will proceed, but may not catch all data. Please try again with the user ID if possible.",
        });
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
            showToast:
              "Recent subscriber references were erased where indexed. Subscriber stats could not be fully erased by username; please try again with the user ID if possible.",
          });
          return;
        }
      }

      if (resolvedUsername) {
        await eraseFromRecentSubscribers(redis, resolvedUsername);
      }

      res.json({ showToast: "User data has been erased successfully." });
    },
  );

  router.post(
    internalRoutes.forms.eraseMyData,
    async (req, res: Response<UiResponse>) => {
      const { confirm } = req.body as EraseMyDataFormValues;

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
      try {
        currentUsername = await reddit.getCurrentUsername();
      } catch (error) {
        console.warn(
          `Could not resolve current username for self-erasure: ${String(error)}`,
        );
      }

      await untrackSubscriberById(redis, currentUserId, currentUsername);
      if (currentUsername) {
        await eraseFromRecentSubscribers(redis, currentUsername);
      }

      res.json({ showToast: "Your Sub Goal user data has been erased." });
    },
  );
}

type CreateGoalDetailsKind = "subscriber-goal" | "subscribe-only";
type CreateGoalDetailsValues =
  | CreateSubscriberGoalFormValues
  | CreateSubscribeOnlyFormValues;
type CreateGoalDraftSelection = Pick<
  CreateGoalDraft,
  "language" | "postHeight"
>;

function buildCreateGoalSetupForm(): NonNullable<UiResponse["showForm"]> {
  return {
    name: formNames.createGoalSetup,
    form: {
      title: "Sub Goal - Choose Post Type",
      description:
        "Choose the language and post height. You will customize the post on the next page.",
      acceptLabel: "Next",
      cancelLabel: "Cancel",
      fields: [
        {
          name: "language",
          label: "Language",
          type: "select",
          defaultValue: [defaultSubGoalLanguage],
          options: subGoalLanguages.map((language) => ({
            label: subGoalPostMessages[language].languageLabel,
            value: language,
          })),
          helpText: "This controls the language used in the post.",
          required: true,
        },
        {
          name: "postHeight",
          label: "Post Height",
          type: "select",
          defaultValue: [defaultSubGoalPostHeight],
          options: [
            { label: "Regular", value: "regular" },
            { label: "Short (no logo)", value: "short" },
            { label: "Tiny (Only Subscribe Button)", value: "tiny" },
          ],
          helpText:
            "Regular and Short create subscriber goals. Tiny creates only a subscribe button.",
          required: true,
        },
      ],
    },
  };
}

async function buildCreateGoalDetailsForm(
  draft: CreateGoalDraftSelection,
): Promise<NonNullable<UiResponse["showForm"]>> {
  const subreddit = await reddit.getCurrentSubreddit();
  const savedSubredditDisplayName = await getSavedSubredditDisplayName(redis);
  const subredditDisplayName = savedSubredditDisplayName ?? subreddit.name;
  const defaultPostTitle = getSubGoalPostMessages(
    draft.language,
  ).defaultPostTitle({ subredditName: subredditDisplayName });
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
    subredditDisplayName: {
      name: "subredditDisplayName",
      label: "Customize Subreddit Name Capitalization",
      type: "string" as const,
      defaultValue: subredditDisplayName,
      helpText:
        "Only capitalization may be changed. All letters, numbers, and symbols must exactly match this subreddit name.",
      required: true,
    },
    developer: {
      name: "customDeveloperField",
      label: "Custom Developer Field",
      type: "string" as const,
      helpText:
        "This field is for developers and testing only. Please leave this field empty",
    },
  };
  const colorOptions = [
    { label: "Red", value: "red" },
    { label: "Green", value: "green" },
    { label: "Purple", value: "purple" },
    { label: "Blue", value: "blue" },
  ];

  if (draft.postHeight === "tiny") {
    return {
      name: formNames.createSubscribeOnly,
      form: {
        title: "Sub Goal - Create a Subscribe-Only Button",
        description:
          "Customize the Tiny subscribe-only post before creating it.",
        acceptLabel: "Create",
        cancelLabel: "Cancel",
        fields: [
          commonFields.postTitle,
          commonFields.subredditDisplayName,
          {
            name: "colorTheme",
            label: "Button Color",
            type: "select",
            defaultValue: [defaultSubGoalColorTheme],
            options: colorOptions,
            helpText:
              "This controls the subscribe button and button glow color.",
            required: true,
          },
          commonFields.developer,
        ],
      },
    };
  }

  const appSettings = getAppSettings();
  const sourceSubredditIsNsfw =
    (subreddit as { isNsfw?: boolean }).isNsfw === true;
  const shouldCrosspost =
    !sourceSubredditIsNsfw &&
    subreddit.name.toLowerCase() !== appSettings.promoSubreddit.toLowerCase();
  const crosspostHelpText = sourceSubredditIsNsfw
    ? "Crossposting is disabled for NSFW source subreddits."
    : `Keep this enabled to announce your goal in the r/${appSettings.promoSubreddit} index subreddit.`;

  return {
    name: formNames.createSubscriberGoal,
    form: {
      title: "Sub Goal - Create a New Goal",
      description: `Customize the ${draft.postHeight === "short" ? "Short" : "Regular"} subscriber goal before creating it.`,
      acceptLabel: "Create",
      cancelLabel: "Cancel",
      fields: [
        commonFields.postTitle,
        commonFields.subredditDisplayName,
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
          label: "Button Color",
          type: "select",
          defaultValue: [defaultSubGoalColorTheme],
          options: colorOptions,
          helpText:
            "This controls the subscribe button, progress bar, and button glow color.",
          required: true,
        },
        {
          name: "crosspost",
          label: `Auto-Crosspost to r/${appSettings.promoSubreddit} (Recommended)`,
          type: "boolean",
          helpText: crosspostHelpText,
          defaultValue: shouldCrosspost,
          disabled: !shouldCrosspost,
        },
        {
          name: "autoCreateNextGoal",
          label: "Create a New Subscriber Goal 24 Hours after Goal Success",
          type: "boolean",
          helpText:
            "Once your goal milestone is reached, a new goal with the next milestone will be automatically created.",
          defaultValue: true,
        },
        commonFields.developer,
      ],
    },
  };
}

async function submitCreateGoalDetails(
  values: CreateGoalDetailsValues,
  expectedKind: CreateGoalDetailsKind,
  res: Response<UiResponse>,
): Promise<void> {
  const userId = context.userId;
  if (!userId) {
    res.json({
      showToast: "Please log in and restart the create-post flow.",
      showForm: buildCreateGoalSetupForm(),
    });
    return;
  }

  try {
    const draft = await getCreateGoalDraft(redis, userId);
    const draftKind =
      draft?.postHeight === "tiny" ? "subscribe-only" : "subscriber-goal";
    if (!draft || draftKind !== expectedKind) {
      res.json({
        showToast:
          "Your post setup expired or no longer matches this form. Please choose the post type again.",
        showForm: buildCreateGoalSetupForm(),
      });
      return;
    }

    const title = values.postTitle?.trim();
    const subredditDisplayName = values.subredditDisplayName?.trim();
    const colorTheme = resolveSubGoalColorTheme(values.colorTheme?.[0]);
    const developerCommands = parseDeveloperCommands(
      values.customDeveloperField,
    );
    const subscriberGoal =
      "subscriberGoal" in values ? values.subscriberGoal : undefined;
    const requestedCrosspost =
      "crosspost" in values ? values.crosspost : undefined;
    const autoCreateNextGoal =
      "autoCreateNextGoal" in values
        ? values.autoCreateNextGoal !== false
        : false;

    for (const command of developerCommands.ignoredCommands) {
      console.info(
        `[developerField] ignored unknown create-goal command: command=${command}`,
      );
    }
    for (const warning of developerCommands.warnings) {
      console.warn(`[developerField] ${warning}`);
    }

    const subreddit = await reddit.getCurrentSubreddit();
    if (developerCommands.selfPost) {
      const submitted = await submitExperimentalSelfPost(subreddit, res);
      if (submitted) {
        await safelyDeleteCreateGoalDraft(userId);
      }
      return;
    }

    const appSettings = getAppSettings();
    const sourceSubredditIsNsfw =
      (subreddit as { isNsfw?: boolean }).isNsfw === true;
    const shouldCrosspostByDefault =
      !sourceSubredditIsNsfw &&
      subreddit.name.toLowerCase() !== appSettings.promoSubreddit.toLowerCase();
    const resolvedCrosspost =
      typeof requestedCrosspost === "boolean"
        ? requestedCrosspost
        : shouldCrosspostByDefault;
    const shouldCreateTinyPost = draft.postHeight === "tiny";

    if (
      !shouldCreateTinyPost &&
      (!subscriberGoal || subreddit.numberOfSubscribers >= subscriberGoal)
    ) {
      res.json({ showToast: "Please select a valid subscriber goal!" });
      return;
    }
    if (!title) {
      res.json({ showToast: "Please provide a post title!" });
      return;
    }
    const subredditDisplayNameValidationMessage = validateSubredditDisplayName(
      subredditDisplayName,
      subreddit.name,
    );
    if (subredditDisplayNameValidationMessage) {
      res.json({ showToast: subredditDisplayNameValidationMessage });
      return;
    }
    const resolvedSubredditDisplayName = subredditDisplayName ?? subreddit.name;

    if (!shouldCreateTinyPost && requestedCrosspost === undefined) {
      console.info(
        `[crosspost] create-goal crosspost value omitted; derived default used: subreddit=${subreddit.name} promoSubreddit=${appSettings.promoSubreddit} resolvedCrosspost=${resolvedCrosspost}`,
      );
    }

    const { post, crosspostDispatchResult, stickyResult } =
      await createSubscriberGoal({
        reddit,
        redis,
        appSettings,
        options: {
          title,
          ...(shouldCreateTinyPost ? {} : { goal: subscriberGoal as number }),
          subredditDisplayName: resolvedSubredditDisplayName,
          crosspost: shouldCreateTinyPost ? false : resolvedCrosspost,
          colorTheme,
          postHeight: draft.postHeight,
          autoCreateNextGoal: shouldCreateTinyPost ? false : autoCreateNextGoal,
          language: draft.language,
          cancelPendingAutoCreateGoals: true,
          submitAsUser: developerCommands.submitAsUser,
          ...(developerCommands.headerText
            ? { headerText: developerCommands.headerText }
            : {}),
        },
      });

    await safelyDeleteCreateGoalDraft(userId);
    console.info(
      `[crosspost] goal post created: postId=${post.id} subreddit=${subreddit.name} promoSubreddit=${appSettings.promoSubreddit} crosspost=${shouldCreateTinyPost ? false : resolvedCrosspost}`,
    );

    if (stickyResult.status === "not_pinned") {
      const moderatorUsername = await resolveCurrentUsername();
      await notifyStickyFailure({
        reddit,
        subredditId: subreddit.id,
        subredditName: subreddit.name,
        moderatorUsername,
        postTitle: post.title ?? title,
        postUrl: getPostUrl(post),
        errorMessage: stickyResult.errorMessage,
      });
    }

    const showToast =
      stickyResult.status === "not_pinned"
        ? "Subscriber Goal post created, but it could not be pinned. Manual moderator action is required."
        : crosspostDispatchResult.status === "failed"
          ? `Subscriber Goal post created, but crosspost to r/${appSettings.promoSubreddit} failed. Moderators can retry.`
          : "Subscriber Goal post created!";

    res.json({
      showToast,
      navigateTo: `https://reddit.com/r/${subreddit.name}/comments/${post.id}`,
    });
  } catch (error) {
    console.error("Error creating goal post:", error);
    res.json({ showToast: "An error occurred while creating the post." });
  }
}

async function safelyDeleteCreateGoalDraft(userId: string): Promise<void> {
  try {
    await deleteCreateGoalDraft(redis, userId);
  } catch (error) {
    console.warn(
      `Failed to delete completed create-goal draft for userId=${userId}: ${String(error)}`,
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
    console.warn(
      `Failed to resolve current username for sticky failure notification: ${String(
        error,
      )}`,
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
    console.warn(
      `[developerField:selfPost] failed to resolve current username: subreddit=${subreddit.name} userId=${context.userId ?? "unknown"} error=${toErrorMessage(error)}`,
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
    const errorMessage = toErrorMessage(error);
    console.error(
      `[developerField:selfPost] submit failed: sourceSubreddit=${subreddit.name} targetSubreddit=${targetSubreddit} userId=${context.userId ?? "unknown"} error=${errorMessage}`,
    );
    res.json({
      showToast: `Experimental selfPost to r/${targetSubreddit} failed: ${errorMessage}`,
    });
    return false;
  }
}
