import express from 'express';
import type { Response } from 'express';
import type { UiResponse } from '@devvit/web/shared';
import { createServer, context, getServerPort, reddit, redis, realtime } from '@devvit/web/server';
import type {
  CreateGoalFormValues,
  DeleteGoalFormValues,
  DebugRealtimeRequest,
  ErrorResponse,
  EraseDataFormValues,
  InitResponse,
  RefreshResponse,
  RealtimeMessage,
  SubGoalState,
  SubscribeRequest,
  SubscribeResponse,
} from '../shared/types/api';
import type { SettingsClient } from './types';
import { isLinkId } from './types';
import { createGoalPost } from './core/post';
import { dispatchPostAction } from './data/crosspostData';
import {
  checkCompletionStatus,
  eraseFromRecentSubscribers,
  getSubGoalData,
  registerNewSubGoalPost,
  setSubredditDisplayNameForPost,
} from './data/subGoalData';
import {
  getSavedSubredditDisplayName,
  setSavedSubredditDisplayName,
} from './data/subredditDisplayNameData';
import { getSubscriberStats, setNewSubscriber, untrackSubscriberById, untrackSubscriberByUsername } from './data/subscriberStats';
import { cancelUpdates, getQueuedUpdates, getTrackedPosts, queueUpdate, untrackPost } from './data/updaterData';
import { getAppSettings } from './settings';
import { onAppChanged } from './triggers/appChanged';
import { onModAction, type ModActionEvent } from './triggers/modAction';
import { onPostsUpdaterJob } from './triggers/scheduler';
import { getDefaultSubscriberGoal } from './utils/numberUtils';
import { clearUserStickies, getSubredditIcon } from './utils/redditUtils';
import { validateSubredditDisplayName } from './utils/subredditDisplayName';
import { applyTextFallback } from './utils/textFallback';

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text());

const router = express.Router();

const getSettingsClient = (): SettingsClient | undefined =>
  (context as { settings?: SettingsClient }).settings;

const buildState = async (
  postId: string,
  options?: { subscribersOverride?: number; recentSubscriberOverride?: string }
): Promise<SubGoalState> => {
  const subreddit = await reddit.getCurrentSubreddit();
  const subredditIcon = await getSubredditIcon(reddit, subreddit.id);
  const appSettings = await getAppSettings(getSettingsClient());
  const subGoalData = await getSubGoalData(redis, postId);

  const username = context.userId ? await reddit.getCurrentUsername() : null;
  const user =
    context.userId && username ? { id: context.userId, username } : null;
  const subscribed = user?.id
    ? (await getSubscriberStats(redis, user.id)) !== undefined
    : false;

  return {
    goal: subGoalData.goal > 0 ? subGoalData.goal : null,
    recentSubscriber:
      options?.recentSubscriberOverride ??
      (subGoalData.recentSubscriber && subGoalData.recentSubscriber.length > 0
        ? subGoalData.recentSubscriber
        : null),
    completedTime: subGoalData.completedTime ? subGoalData.completedTime : null,
    subscribed,
    user,
    appSettings,
    subreddit: {
      id: subreddit.id,
      name: subGoalData.subredditDisplayName ?? subreddit.name,
      icon: subredditIcon,
      subscribers:
        options?.subscribersOverride ?? subreddit.numberOfSubscribers,
    },
  };
};

router.get('/api/init', async (_req, res): Promise<void> => {
  const { postId } = context;
  if (!postId) {
    console.warn('[api/init] returning 400 validation_error: missing postId');
    res.status(400).json({
      status: 'error',
      message: 'postId is required but missing from context',
    } satisfies ErrorResponse);
    return;
  }

  try {
    const state = await buildState(postId);
    res.json({
      type: 'init',
      postId,
      state,
    } satisfies InitResponse);
  } catch (error) {
    console.error(`API Init Error for post ${postId}:`, error);
    const errorMessage =
      error instanceof Error ? `Initialization failed: ${error.message}` : 'Unknown error during initialization';
    console.warn(
      `[api/init] returning 503 runtime_failure: postId=${postId} message=${errorMessage}`
    );
    res
      .status(503)
      .json({ status: 'error', message: errorMessage } satisfies ErrorResponse);
  }
});

router.get('/api/refresh', async (_req, res): Promise<void> => {
  const { postId } = context;
  if (!postId) {
    console.warn('[api/refresh] returning 400 validation_error: missing postId');
    res.status(400).json({
      status: 'error',
      message: 'postId is required but missing from context',
    } satisfies ErrorResponse);
    return;
  }

  try {
    const subGoalData = await getSubGoalData(redis, postId);
    if (subGoalData.goal && !subGoalData.completedTime) {
      const subreddit = await reddit.getCurrentSubreddit();
      if (subreddit.numberOfSubscribers >= subGoalData.goal) {
        await checkCompletionStatus(reddit, redis, postId);
      }
    }

    const state = await buildState(postId);
    res.json({
      type: 'refresh',
      postId,
      state,
    } satisfies RefreshResponse);
  } catch (error) {
    console.error(`API Refresh Error for post ${postId}:`, error);
    const errorMessage =
      error instanceof Error ? `Refresh failed: ${error.message}` : 'Unknown error during refresh';
    console.warn(
      `[api/refresh] returning 503 runtime_failure: postId=${postId} message=${errorMessage}`
    );
    res
      .status(503)
      .json({ status: 'error', message: errorMessage } satisfies ErrorResponse);
  }
});

router.post('/api/subscribe', async (_req, res): Promise<void> => {
  const { postId, userId } = context;
  if (!postId) {
    res.status(400).json({
      status: 'error',
      message: 'postId is required but missing from context',
    } satisfies ErrorResponse);
    return;
  }

  if (!userId) {
    res.status(401).json({
      status: 'error',
      message: 'Please log in to subscribe.',
    } satisfies ErrorResponse);
    return;
  }

  try {
    const username = await reddit.getCurrentUsername();
    if (!username) {
      res.status(400).json({
        status: 'error',
        message: 'Unable to resolve username.',
      } satisfies ErrorResponse);
      return;
    }

    const body = (_req as { body?: SubscribeRequest }).body;
    const shareUsername = body?.shareUsername === true;

    await reddit.subscribeToCurrentSubreddit();

    const subreddit = await reddit.getCurrentSubreddit();
    const newSubscriberCount = subreddit.numberOfSubscribers + 1;

    await setNewSubscriber(redis, postId, newSubscriberCount, {
      id: userId,
      username,
    }, shareUsername);

    const subGoalData = await getSubGoalData(redis, postId);
    if (subGoalData.goal && newSubscriberCount >= subGoalData.goal) {
      await checkCompletionStatus(reddit, redis, postId);
    }

    const realtimeMessage: RealtimeMessage = {
      type: 'sub',
      newSubscriberCount,
      ...(shareUsername ? { recentSubscriber: username } : {}),
    };
    await realtime.send('subscriber_updates', realtimeMessage);

    const state = await buildState(postId, {
      subscribersOverride: newSubscriberCount,
      ...(shareUsername ? { recentSubscriberOverride: username } : {}),
    });

    res.json({
      type: 'subscribe',
      postId,
      state,
    } satisfies SubscribeResponse);
  } catch (error) {
    console.error(`Subscribe Error for post ${postId}:`, error);
    const errorMessage =
      error instanceof Error ? `Subscription failed: ${error.message}` : 'Subscription failed.';
    res.status(400).json({ status: 'error', message: errorMessage } satisfies ErrorResponse);
  }
});

router.post('/internal/triggers/on-app-install', async (_req, res): Promise<void> => {
  try {
    await onAppChanged();
    res.json({ status: 'ok' });
  } catch (error) {
    console.error(`on-app-install error: ${String(error)}`);
    res.status(400).json({ status: 'error', message: 'Failed to run install trigger' });
  }
});

router.post('/internal/triggers/on-app-upgrade', async (_req, res): Promise<void> => {
  try {
    await onAppChanged();
    res.json({ status: 'ok' });
  } catch (error) {
    console.error(`on-app-upgrade error: ${String(error)}`);
    res.status(400).json({ status: 'error', message: 'Failed to run upgrade trigger' });
  }
});

router.post('/internal/triggers/on-mod-action', async (req, res): Promise<void> => {
  try {
    const modAction = (req.body?.modAction ?? req.body) as ModActionEvent;
    await onModAction(modAction);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error(`on-mod-action error: ${String(error)}`);
    res.status(400).json({ status: 'error', message: 'Failed to handle mod action' });
  }
});

router.post('/internal/scheduler/posts-updater-job', async (_req, res): Promise<void> => {
  try {
    await onPostsUpdaterJob();
    res.json({ status: 'ok' });
  } catch (error) {
    console.error(`postsUpdaterJob error: ${String(error)}`);
    res.status(400).json({ status: 'error', message: 'Failed to run scheduler job' });
  }
});

router.post('/api/debug/realtime', async (req, res): Promise<void> => {
  const body = req.body as DebugRealtimeRequest;
  if (!body || typeof body.nextCount !== 'number' || Number.isNaN(body.nextCount)) {
    res.status(400).json({ status: 'error', message: 'nextCount is required' } satisfies ErrorResponse);
    return;
  }

  const recentSubscriber = body.includeUsername ? 'debug_user' : undefined;
  const message: RealtimeMessage = {
    type: 'sub',
    newSubscriberCount: body.nextCount,
    ...(recentSubscriber ? { recentSubscriber } : {}),
  };

  try {
    await realtime.send('subscriber_updates', message);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Failed to send debug realtime:', error);
    res.status(400).json({ status: 'error', message: 'Failed to send debug realtime' } satisfies ErrorResponse);
  }
});

router.post('/internal/menu/create-goal', async (_req, res: Response<UiResponse>) => {
  try {
    const subreddit = await reddit.getCurrentSubreddit();
    const savedSubredditDisplayName = await getSavedSubredditDisplayName(redis);
    const resolvedSubredditDisplayName =
      savedSubredditDisplayName ?? subreddit.name;
    const appSettings = await getAppSettings(getSettingsClient());
    const defaultGoal = getDefaultSubscriberGoal(subreddit.numberOfSubscribers);
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
        name: 'createGoalForm',
        form: {
          title: 'Sub Goal - Create a New Goal',
          description: 'This will create a new subscriber goal post in the subreddit.',
          fields: [
            {
              name: 'subscriberGoal',
              label: 'Enter your Subscriber Goal',
              type: 'number',
              defaultValue: defaultGoal,
              helpText:
                'The default goal is a suggestion on your current subscriber count, you may set it to any number greater than your current subscriber count.',
              required: true,
            },
            {
              name: 'postTitle',
              label: 'Post Title',
              type: 'string',
              defaultValue: `Welcome to r/${resolvedSubredditDisplayName}!`,
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
              name: 'crosspost',
              label: `Auto-Crosspost to r/${appSettings.promoSubreddit} (Recommended)`,
              type: 'boolean',
              helpText: crosspostHelpText,
              defaultValue: shouldCrosspost,
              disabled: !shouldCrosspost,
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
});

router.post('/internal/form/create-goal', async (req, res: Response<UiResponse>) => {
  const values = req.body as CreateGoalFormValues;
  const subscriberGoal = values.subscriberGoal;
  const requestedCrosspost = values.crosspost;
  const title = values.postTitle?.trim();
  const subredditDisplayName = values.subredditDisplayName?.trim();

  try {
    const subreddit = await reddit.getCurrentSubreddit();
    const appSettings = await getAppSettings(getSettingsClient());
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

    if (requestedCrosspost === undefined) {
      console.info(
        `[crosspost] create-goal crosspost value omitted; derived default used: subreddit=${subreddit.name} promoSubreddit=${appSettings.promoSubreddit} resolvedCrosspost=${resolvedCrosspost}`
      );
    }

    const appUser = await reddit.getAppUser();
    if (!appUser?.username) {
      res.json({ showToast: 'Could not resolve app user.' });
      return;
    }
    await clearUserStickies(reddit, appUser.username);

    const post = await createGoalPost({
      title,
      subredditName: subreddit.name,
    });

    await applyTextFallback(post, {
      goal: subscriberGoal,
      subscribers: subreddit.numberOfSubscribers,
      subredditName: resolvedSubredditDisplayName,
      completedTime: null,
    });
    await setSavedSubredditDisplayName(redis, resolvedSubredditDisplayName);

    const crosspostDispatchResult = await registerNewSubGoalPost(
      reddit,
      redis,
      appSettings,
      post,
      subscriberGoal,
      resolvedCrosspost,
      resolvedSubredditDisplayName
    );

    const trackedPosts = await getTrackedPosts(redis);
    const queuedPosts = await getQueuedUpdates(redis);
    const activePostIds = [...new Set([...trackedPosts, ...queuedPosts])];
    for (const activePostId of activePostIds) {
      if (!isLinkId(activePostId)) {
        continue;
      }
      try {
        const activePost = await reddit.getPostById(activePostId);
        if (activePost.subredditId !== subreddit.id) {
          continue;
        }
        await setSubredditDisplayNameForPost(
          redis,
          activePostId,
          resolvedSubredditDisplayName
        );
        await queueUpdate(redis, activePostId, new Date());
      } catch (backfillError) {
        console.warn(
          `Failed to backfill subreddit display name for active post ${activePostId}: ${String(
            backfillError
          )}`
        );
      }
    }

    await post.approve();
    await post.sticky();

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
});

router.post('/internal/menu/delete-goal', async (_req, res: Response<UiResponse>) => {
  res.json({
    showForm: {
      name: 'deleteGoalForm',
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
});

router.post('/internal/form/delete-goal', async (req, res: Response<UiResponse>) => {
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
    const appSettings = await getAppSettings(getSettingsClient());
    if (subredditName.toLowerCase() !== appSettings.promoSubreddit.toLowerCase()) {
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
});

router.post('/internal/menu/erase-data', async (_req, res: Response<UiResponse>) => {
  res.json({
    showForm: {
      name: 'eraseDataForm',
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
});

router.post('/internal/form/erase-data', async (req, res: Response<UiResponse>) => {
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
    await untrackSubscriberById(redis, resolvedUserId);
  }

  if (resolvedUsername) {
    await untrackSubscriberByUsername(redis, resolvedUsername);
    await eraseFromRecentSubscribers(redis, resolvedUsername);
  }

  res.json({ showToast: 'User data has been erased successfully.' });
});

app.use(router);

const port = getServerPort();

const server = createServer(app);
server.on('error', (err) => console.error(`server error; ${err.stack}`));
server.listen(port);
