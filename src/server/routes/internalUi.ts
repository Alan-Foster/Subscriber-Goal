import type { Response, Router } from 'express';
import type { UiResponse } from '@devvit/web/shared';
import { context, reddit, redis } from '@devvit/web/server';
import type {
  CreateGoalFormValues,
  DeleteGoalFormValues,
  EraseDataFormValues,
} from '../../shared/types/api';
import {
  defaultSubGoalColorTheme,
  resolveSubGoalColorTheme,
} from '../../shared/subGoalColorTheme';
import {
  defaultSubGoalLanguage,
  getSubGoalPostMessages,
  resolveSubGoalLanguage,
  subGoalLanguages,
  subGoalPostMessages,
} from '../../shared/subGoalPostI18n';
import { formNames, internalRoutes } from '../../shared/routes';
import { createSubscriberGoal } from '../core/createSubscriberGoal';
import { dispatchPostAction } from '../data/crosspostData';
import {
  eraseFromRecentSubscribers,
} from '../data/subGoalData';
import { getSavedSubredditDisplayName } from '../data/subredditDisplayNameData';
import { untrackSubscriberById, untrackSubscriberByUsername } from '../data/subscriberStats';
import { cancelUpdates, untrackPost } from '../data/updaterData';
import { getAppSettings } from '../settings';
import { getDefaultSubscriberGoal } from '../utils/numberUtils';
import { validateSubredditDisplayName } from '../utils/subredditDisplayName';

export function registerInternalUiRoutes(router: Router): void {
  router.post(
    internalRoutes.menu.createGoal,
    async (_req, res: Response<UiResponse>) => {
      try {
        const subreddit = await reddit.getCurrentSubreddit();
        const savedSubredditDisplayName = await getSavedSubredditDisplayName(redis);
        const resolvedSubredditDisplayName =
          savedSubredditDisplayName ?? subreddit.name;
        const appSettings = getAppSettings();
        const defaultGoal = getDefaultSubscriberGoal(subreddit.numberOfSubscribers);
        const defaultPostTitle = getSubGoalPostMessages(
          defaultSubGoalLanguage
        ).defaultPostTitle({
          subredditName: resolvedSubredditDisplayName,
        });
        const sourceSubredditIsNsfw =
          (subreddit as { isNsfw?: boolean }).isNsfw === true;
        const shouldCrosspost =
          !sourceSubredditIsNsfw &&
          subreddit.name.toLowerCase() !== appSettings.promoSubreddit.toLowerCase();
        const crosspostHelpText = sourceSubredditIsNsfw
          ? 'Crossposting is disabled for NSFW source subreddits.'
          : `Keep this enabled to announce your goal in the r/${appSettings.promoSubreddit} index subreddit.`;

        res.json({
          showForm: {
            name: formNames.createGoal,
            form: {
              title: 'Sub Goal - Create a New Goal',
              description: 'This will create a new subscriber goal post in the subreddit.',
              fields: [
                {
                  name: 'language',
                  label: 'Language',
                  type: 'select',
                  defaultValue: [defaultSubGoalLanguage],
                  options: subGoalLanguages.map((language) => ({
                    label: subGoalPostMessages[language].languageLabel,
                    value: language,
                  })),
                  helpText:
                    'This controls the language used in the subscriber goal post.',
                  required: true,
                },
                {
                  name: 'subscriberGoal',
                  label: 'Enter your Subscriber Goal',
                  type: 'number',
                  defaultValue: defaultGoal,
                  helpText:
                    'The default goal is a suggestion on your current subscriber count. Set it to any number greater than your current subscriber count.',
                  required: true,
                },
                {
                  name: 'postTitle',
                  label: 'Post Title',
                  type: 'string',
                  defaultValue: defaultPostTitle,
                  helpText:
                    'This will be used as the title of the post, you can customize it as you see fit.',
                  required: true,
                },
                {
                  name: 'subredditDisplayName',
                  label: 'Customize Subreddit Name Capitalization',
                  type: 'string',
                  defaultValue: resolvedSubredditDisplayName,
                  helpText:
                    'Only capitalization may be changed. All letters, numbers, and symbols must exactly match this subreddit name.',
                  required: true,
                },
                {
                  name: 'colorTheme',
                  label: 'Button Color',
                  type: 'select',
                  defaultValue: [defaultSubGoalColorTheme],
                  options: [
                    { label: 'Red', value: 'red' },
                    { label: 'Green', value: 'green' },
                    { label: 'Purple', value: 'purple' },
                    { label: 'Blue', value: 'blue' },
                  ],
                  helpText:
                    'This controls the subscribe button, progress bar, and button glow color.',
                  required: true,
                },
                {
                  name: 'crosspost',
                  label: `Auto-Crosspost to r/${appSettings.promoSubreddit} (Recommended)`,
                  type: 'boolean',
                  helpText: crosspostHelpText,
                  defaultValue: shouldCrosspost,
                  disabled: !shouldCrosspost,
                },
                {
                  name: 'autoCreateNextGoal',
                  label: 'Create a New Subscriber Goal 24 Hours after Goal Success',
                  type: 'boolean',
                  helpText:
                    'Once your goal milestone is reached, a new goal with the next milestone will be automatically created.',
                  defaultValue: true,
                },
              ],
            },
          },
        });
      } catch (error) {
        console.error(
          `Failed to open create goal form: subreddit=${context.subredditName ?? 'unknown'} userId=${context.userId ?? 'unknown'}`,
          error
        );
        res.json({ showToast: 'Error preparing the create goal form.' });
      }
    }
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

      try {
        const subreddit = await reddit.getCurrentSubreddit();
        const appSettings = getAppSettings();
        const sourceSubredditIsNsfw =
          (subreddit as { isNsfw?: boolean }).isNsfw === true;
        const shouldCrosspostByDefault =
          !sourceSubredditIsNsfw &&
          subreddit.name.toLowerCase() !== appSettings.promoSubreddit.toLowerCase();
        const resolvedCrosspost =
          typeof requestedCrosspost === 'boolean'
            ? requestedCrosspost
            : shouldCrosspostByDefault;

        if (!subscriberGoal || subreddit.numberOfSubscribers >= subscriberGoal) {
          res.json({ showToast: 'Please select a valid subscriber goal!' });
          return;
        }

        if (!title) {
          res.json({ showToast: 'Please provide a post title!' });
          return;
        }
        const subredditDisplayNameValidationMessage = validateSubredditDisplayName(
          subredditDisplayName,
          subreddit.name
        );
        if (subredditDisplayNameValidationMessage) {
          res.json({ showToast: subredditDisplayNameValidationMessage });
          return;
        }
        const resolvedSubredditDisplayName = subredditDisplayName ?? subreddit.name;
        const englishDefaultTitle = getSubGoalPostMessages(
          defaultSubGoalLanguage
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
            `[crosspost] create-goal crosspost value omitted; derived default used: subreddit=${subreddit.name} promoSubreddit=${appSettings.promoSubreddit} resolvedCrosspost=${resolvedCrosspost}`
          );
        }

        const { post, crosspostDispatchResult } = await createSubscriberGoal({
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
          },
        });

        console.info(
          `[crosspost] goal post created: postId=${post.id} subreddit=${subreddit.name} promoSubreddit=${appSettings.promoSubreddit} crosspost=${resolvedCrosspost}`
        );

        const showToast =
          crosspostDispatchResult.status === 'failed'
            ? `Subscriber Goal post created, but crosspost to r/${appSettings.promoSubreddit} failed. Moderators can retry.`
            : 'Subscriber Goal post created!';

        res.json({
          showToast,
          navigateTo: `https://reddit.com/r/${subreddit.name}/comments/${post.id}`,
        });
      } catch (error) {
        console.error('Error creating goal post:', error);
        res.json({ showToast: 'An error occurred while creating the post.' });
      }
    }
  );

  router.post(
    internalRoutes.menu.deleteGoal,
    async (_req, res: Response<UiResponse>) => {
      res.json({
        showForm: {
          name: formNames.deleteGoal,
          form: {
            title: 'Sub Goal - Delete This Post',
            description:
              'This will permanently delete the Sub Goal post. If you wish to temporarily hide the post, you can remove it as a moderator and re-approve it later.',
            fields: [
              {
                name: 'confirm',
                label: 'Are you sure?',
                type: 'boolean',
                defaultValue: false,
                helpText: 'This action is irreversible.',
              },
            ],
            acceptLabel: 'Delete',
            cancelLabel: 'Cancel',
          },
        },
      });
    }
  );

  router.post(
    internalRoutes.forms.deleteGoal,
    async (req, res: Response<UiResponse>) => {
      const { confirm } = req.body as DeleteGoalFormValues;
      if (!confirm) {
        res.json({
          showToast:
            'You did not confirm the deletion. If that was a mistake, please try again and enable the confirmation toggle before hitting delete.',
        });
        return;
      }

      const postId = context.postId;
      const subredditName =
        context.subredditName ?? (await reddit.getCurrentSubreddit()).name;
      if (!postId || !subredditName) {
        res.json({
          showToast: 'Deletion metadata was somehow lost. Please try again.',
        });
        return;
      }

      try {
        const post = await reddit.getPostById(postId);
        const appSettings = getAppSettings();
        if (
          subredditName.toLowerCase() !== appSettings.promoSubreddit.toLowerCase()
        ) {
          await dispatchPostAction(reddit, appSettings, postId, 'delete');
        }
        await post.delete();
        await cancelUpdates(redis, postId);
        await untrackPost(redis, postId);
        res.json({ showToast: 'Post deleted successfully!' });
      } catch (error) {
        console.error('Error deleting post:', error);
        res.json({
          showToast: 'Error deleting post. Please refresh the page and try again.',
        });
      }
    }
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
              'This will erase all data stored by Sub Goal associated with the specified user, such as when they subscribed and any other related data.',
            fields: [
              {
                name: 'username',
                label: 'Username',
                type: 'string',
                helpText:
                  'Erase all data associated with this username. Please note that in some cases this may be case sensitive, so it should be entered exactly as it appears in their Reddit profile link.',
                required: false,
              },
              {
                name: 'userId',
                label: 'User ID',
                type: 'string',
                helpText:
                  'Erase all data associated with this user ID. If left blank, this field will be fetched based on the specified username.',
                required: false,
              },
              {
                name: 'confirm',
                label: 'Are you sure?',
                type: 'boolean',
                defaultValue: false,
                helpText: 'This action is irreversible.',
              },
            ],
            acceptLabel: 'Erase',
            cancelLabel: 'Cancel',
          },
        },
      });
    }
  );

  router.post(
    internalRoutes.forms.eraseData,
    async (req, res: Response<UiResponse>) => {
      const { username, userId, confirm } = req.body as EraseDataFormValues;

      if (!confirm) {
        res.json({
          showToast:
            'You did not confirm the erasure. Please enable the confirmation toggle before proceeding.',
        });
        return;
      }

      if (!username && !userId) {
        res.json({
          showToast:
            'User details were not provided. Please enter a username, user ID, or both.',
        });
        return;
      }

      let resolvedUserId = userId;
      let resolvedUsername = username;

      if (resolvedUserId && !resolvedUserId.startsWith('t2_')) {
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
        console.log('Error fetching user details: ', error);
        res.json({
          showToast:
            'Could not fetch all user details. Deletion will proceed, but may not catch all data. Please try again with the user ID if possible.',
        });
      }

      if (resolvedUserId) {
        await untrackSubscriberById(redis, resolvedUserId, resolvedUsername);
      } else if (resolvedUsername) {
        const result = await untrackSubscriberByUsername(redis, resolvedUsername);
        if (result.status === 'partial') {
          await eraseFromRecentSubscribers(redis, resolvedUsername);
          res.json({
            showToast:
              'Recent subscriber references were erased where indexed. Subscriber stats could not be fully erased by username; please try again with the user ID if possible.',
          });
          return;
        }
      }

      if (resolvedUsername) {
        await eraseFromRecentSubscribers(redis, resolvedUsername);
      }

      res.json({ showToast: 'User data has been erased successfully.' });
    }
  );
}
