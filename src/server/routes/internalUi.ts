import type { Response, Router } from "express";
import type { UiResponse } from "@devvit/web/shared";
import { context, reddit, redis } from "@devvit/web/server";
import type {
  CreateGoalFormValues,
  DeleteGoalFormValues,
  EraseDataFormValues,
} from "../../shared/types/api";
import {
  defaultSubGoalColorTheme,
  resolveSubGoalColorTheme,
} from "../../shared/subGoalColorTheme";
import {
  defaultSubGoalLanguage,
  getSubGoalPostMessages,
  resolveSubGoalLanguage,
  subGoalLanguages,
  subGoalPostMessages,
} from "../../shared/subGoalPostI18n";
import { formNames, internalRoutes } from "../../shared/routes";
import { createSubscriberGoal } from "../core/createSubscriberGoal";
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
      try {
        const subreddit = await reddit.getCurrentSubreddit();
        const savedSubredditDisplayName =
          await getSavedSubredditDisplayName(redis);
        const resolvedSubredditDisplayName =
          savedSubredditDisplayName ?? subreddit.name;
        const appSettings = getAppSettings();
        const defaultGoal = getDefaultSubscriberGoal(
          subreddit.numberOfSubscribers,
        );
        const defaultPostTitle = getSubGoalPostMessages(
          defaultSubGoalLanguage,
        ).defaultPostTitle({
          subredditName: resolvedSubredditDisplayName,
        });
        const sourceSubredditIsNsfw =
          (subreddit as { isNsfw?: boolean }).isNsfw === true;
        const shouldCrosspost =
          !sourceSubredditIsNsfw &&
          subreddit.name.toLowerCase() !==
            appSettings.promoSubreddit.toLowerCase();
        const crosspostHelpText = sourceSubredditIsNsfw
          ? "Crossposting is disabled for NSFW source subreddits."
          : `Keep this enabled to announce your goal in the r/${appSettings.promoSubreddit} index subreddit.`;

        res.json({
          showForm: {
            name: formNames.createGoal,
            form: {
              title: "Sub Goal - Create a New Goal",
              description:
                "This will create a new subscriber goal post in the subreddit.",
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
                  helpText:
                    "This controls the language used in the subscriber goal post.",
                  required: true,
                },
                {
                  name: "subscriberGoal",
                  label: "Enter your Subscriber Goal",
                  type: "number",
                  defaultValue: defaultGoal,
                  helpText:
                    "The default goal is a suggestion on your current subscriber count. Set it to any number greater than your current subscriber count.",
                  required: true,
                },
                {
                  name: "postTitle",
                  label: "Post Title",
                  type: "string",
                  defaultValue: defaultPostTitle,
                  helpText:
                    "This will be used as the title of the post, you can customize it as you see fit.",
                  required: true,
                },
                {
                  name: "subredditDisplayName",
                  label: "Customize Subreddit Name Capitalization",
                  type: "string",
                  defaultValue: resolvedSubredditDisplayName,
                  helpText:
                    "Only capitalization may be changed. All letters, numbers, and symbols must exactly match this subreddit name.",
                  required: true,
                },
                {
                  name: "colorTheme",
                  label: "Button Color",
                  type: "select",
                  defaultValue: [defaultSubGoalColorTheme],
                  options: [
                    { label: "Red", value: "red" },
                    { label: "Green", value: "green" },
                    { label: "Purple", value: "purple" },
                    { label: "Blue", value: "blue" },
                  ],
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
                  label:
                    "Create a New Subscriber Goal 24 Hours after Goal Success",
                  type: "boolean",
                  helpText:
                    "Once your goal milestone is reached, a new goal with the next milestone will be automatically created.",
                  defaultValue: true,
                },
                {
                  name: "customDeveloperField",
                  label: "Custom Developer Field",
                  type: "string",
                  helpText:
                    "This field is for developers and testing only. Please leave this field empty",
                },
              ],
            },
          },
        });
      } catch (error) {
        console.error(
          `Failed to open create goal form: subreddit=${context.subredditName ?? "unknown"} userId=${context.userId ?? "unknown"}`,
          error,
        );
        res.json({ showToast: "Error preparing the create goal form." });
      }
    },
  );

  router.post(
    internalRoutes.forms.createGoal,
    async (req, res: Response<UiResponse>) => {
      const values = req.body as CreateGoalFormValues;
      const subscriberGoal = values.subscriberGoal;
      const requestedCrosspost = values.crosspost;
      const title = values.postTitle?.trim();
      const subredditDisplayName = values.subredditDisplayName?.trim();
      const colorTheme = resolveSubGoalColorTheme(values.colorTheme?.[0]);
      const autoCreateNextGoal = values.autoCreateNextGoal !== false;
      const language = resolveSubGoalLanguage(values.language?.[0]);
      const developerCommands = parseDeveloperCommands(
        values.customDeveloperField,
      );

      for (const command of developerCommands.ignoredCommands) {
        console.info(
          `[developerField] ignored unknown create-goal command: command=${command}`,
        );
      }
      for (const warning of developerCommands.warnings) {
        console.warn(`[developerField] ${warning}`);
      }

      try {
        const subreddit = await reddit.getCurrentSubreddit();
        if (developerCommands.selfPost) {
          await submitExperimentalSelfPost(subreddit, res);
          return;
        }

        const appSettings = getAppSettings();
        const sourceSubredditIsNsfw =
          (subreddit as { isNsfw?: boolean }).isNsfw === true;
        const shouldCrosspostByDefault =
          !sourceSubredditIsNsfw &&
          subreddit.name.toLowerCase() !==
            appSettings.promoSubreddit.toLowerCase();
        const resolvedCrosspost =
          typeof requestedCrosspost === "boolean"
            ? requestedCrosspost
            : shouldCrosspostByDefault;

        if (
          !subscriberGoal ||
          subreddit.numberOfSubscribers >= subscriberGoal
        ) {
          res.json({ showToast: "Please select a valid subscriber goal!" });
          return;
        }

        if (!title) {
          res.json({ showToast: "Please provide a post title!" });
          return;
        }
        const subredditDisplayNameValidationMessage =
          validateSubredditDisplayName(subredditDisplayName, subreddit.name);
        if (subredditDisplayNameValidationMessage) {
          res.json({ showToast: subredditDisplayNameValidationMessage });
          return;
        }
        const resolvedSubredditDisplayName =
          subredditDisplayName ?? subreddit.name;
        const englishDefaultTitle = getSubGoalPostMessages(
          defaultSubGoalLanguage,
        ).defaultPostTitle({
          subredditName: resolvedSubredditDisplayName,
        });
        const resolvedTitle =
          title === englishDefaultTitle
            ? getSubGoalPostMessages(language).defaultPostTitle({
                subredditName: resolvedSubredditDisplayName,
              })
            : title;

        if (requestedCrosspost === undefined) {
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
              title: resolvedTitle,
              goal: subscriberGoal,
              subredditDisplayName: resolvedSubredditDisplayName,
              crosspost: resolvedCrosspost,
              colorTheme,
              autoCreateNextGoal,
              language,
              cancelPendingAutoCreateGoals: true,
              submitAsUser: developerCommands.submitAsUser,
              ...(developerCommands.headerText
                ? { headerText: developerCommands.headerText }
                : {}),
            },
          });

        console.info(
          `[crosspost] goal post created: postId=${post.id} subreddit=${subreddit.name} promoSubreddit=${appSettings.promoSubreddit} crosspost=${resolvedCrosspost}`,
        );

        if (stickyResult.status === "not_pinned") {
          const moderatorUsername = await resolveCurrentUsername();
          await notifyStickyFailure({
            reddit,
            subredditId: subreddit.id,
            subredditName: subreddit.name,
            moderatorUsername,
            postTitle: post.title ?? resolvedTitle,
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
            title: "SubGoal - Erase a User's Data",
            description:
              "This will erase all data stored by Sub Goal associated with the specified user, such as when they subscribed and any other related data.",
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
): Promise<void> {
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
    return;
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
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    console.error(
      `[developerField:selfPost] submit failed: sourceSubreddit=${subreddit.name} targetSubreddit=${targetSubreddit} userId=${context.userId ?? "unknown"} error=${errorMessage}`,
    );
    res.json({
      showToast: `Experimental selfPost to r/${targetSubreddit} failed: ${errorMessage}`,
    });
  }
}
