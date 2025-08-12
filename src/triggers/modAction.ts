/**
 * @file The initial intent of this file was to register and handle the ModAction trigger. That functionality is still present, however during the final sprint for the hackathon this file grew to include handling events dispatched via the wiki revisions.
 * @todo Refactor this file. `getNewPosts` and `getNewPostActions` should probably be merged into a single function. The afforementioned functions and `updateFromWikis` should probably moved to a separate file (possibly `src/services/wikiMonitor.ts`, which would also introduce a spot for the messaging service).
 */

import {ModAction} from '@devvit/protos';
import {Devvit, RedditAPIClient, RedisClient, TriggerContext} from '@devvit/public-api';
import {isLinkId} from '@devvit/shared-types/tid.js';

import {dispatchPostAction, getCorrespondingPost, hasCrosspost, isProcessedRevision, modToPostActionMap, PostActionType, storeCorrespondingPost, storeProcessedRevision} from '../data/crosspostData.js';
import {AppSettings, getAppSettings} from '../settings.js';
import {safeGetWikiPageRevisions} from '../utils/redditUtils.js';

export type NewPostEvent = {
  postId: string;
  revisionId: string;
  goal: number;
}

export type PostActionEvent = {
  postId: string;
  revisionId: string;
  action: PostActionType;
}

/**
 * This function retrieves all the wiki page revisions for the `post` wiki page of the given subreddit.
 * It then processes all the new revisions and formats them as an array of {@linkcode NewPostEvent} objects.
 * The function itself does not handle the crossposting, it only retrieves the new post events and returns them.
 *
 * The revisions are expected to have a reason in the format: "Post (t3_[\w\d]+) with goal (\d+)". Any other format will be ignored.
 * The wiki page itself is not loaded, the data is passed entirely via the revision reason.
 * @todo Likely merge this with `getNewPostActions` to avoid code duplication.
 * @param reddit - Instance of RedditAPIClient.
 * @param redis - Instance of RedisClient.
 * @param subredditName - The name of the subreddit to get the wiki page revisions from, this should be the central promo subreddit.
 * @returns Returns a list of all the new post events that were found in the wiki page revisions.
 */
export async function getNewPosts (reddit: RedditAPIClient, redis: RedisClient, subredditName: string): Promise<NewPostEvent[]> {
  const revisions = await safeGetWikiPageRevisions(reddit, subredditName, 'post');
  if (!revisions) {
    return [];
  }

  const newPosts: Set<NewPostEvent> = new Set();
  // Format: Post t3_17417kp with goal 1234
  for (const revision of revisions) {
    if (await isProcessedRevision(redis, revision.id)) {
      continue; // Skip already processed revisions
    }

    const match = revision.reason.match(/Post (t3_[\w\d]+) with goal (\d+)/);
    if (!match) {
      console.warn('Invalid revision reason format', revision.reason);
      continue;
    }
    const [text, postId, goalString] = match;
    if (!text || !postId || !goalString) {
      console.warn('Unmatched revision reason data', revision.reason);
      continue;
    }

    const goal = parseInt(goalString);
    if (isNaN(goal)) {
      console.warn('Invalid goal value', goalString);
      continue;
    }

    if (!isLinkId(postId)) {
      console.warn('Invalid postId format', postId);
      continue;
    }

    newPosts.add({
      postId,
      revisionId: revision.id,
      goal,
    });
  }

  return Array.from(newPosts);
}

/**
 * This function retrieves all the wiki page revisions for a given post action, one of the following pages: `remove`, `approve`, or `delete`.
 * It then processes all the new revisions and formats them as an array of {@linkcode PostActionEvent} objects.
 * The function itself does not perform these actions, it only retrieves the events and returns them.
 *
 * The revisions are expected to have a reason in the format: "Dispatch ${actionType} for (t3_[\\w\\d]+)". Any other format will be ignored.
 * The wiki page itself is not loaded, the data is passed entirely via the revision reason.
 * @todo Likely merge this with `getNewPosts` to avoid code duplication.
 * @todo Possibly simplify the reason, as it is currently reduntant with each action type having its own wiki page.
 * @param reddit - Instance of RedditAPIClient.
 * @param redis - Instance of RedisClient.
 * @param subredditName - The name of the subreddit to get the wiki page revisions from, this should be the central promo subreddit.
 * @param actionType - The type of action to retreive revisions for, one of `remove`, `approve`, or `delete`.
 * @returns Returns a list of all the new post events that were found in the wiki page revisions.
 */
export async function getNewPostActions (reddit: RedditAPIClient, redis: RedisClient, subredditName: string, actionType: PostActionType): Promise<PostActionEvent[]> {
  const revisions = await safeGetWikiPageRevisions(reddit, subredditName, `${actionType}`);
  if (!revisions) {
    return [];
  }

  const newPosts: Set<PostActionEvent> = new Set();
  // Format: Dispatch actionType for t3_17417kp
  for (const revision of revisions) {
    if (await isProcessedRevision(redis, revision.id)) {
      continue; // Skip already processed revisions
    }

    const match = revision.reason.match(new RegExp(`Dispatch ${actionType} for (t3_[\\w\\d]+)`));
    if (!match) {
      console.warn('Invalid revision reason format', revision.reason);
      continue;
    }
    const [text, postId] = match;
    if (!text || !postId) {
      console.warn('Unmatched revision reason data', revision.reason);
      continue;
    }

    if (!isLinkId(postId)) {
      console.warn('Invalid postId format', postId);
      continue;
    }

    newPosts.add({
      postId,
      revisionId: revision.id,
      action: actionType,
    });
  }

  return Array.from(newPosts);
}

/**
 * This function handles events received via the wiki revisions in the central promo subreddit.
 * We are using different wiki pages to dispatch different types of events, so the function has to process all four of them.
 * The first in line are new posts, after that we handle removals, approvals, and deletions in that order.
 * @todo Refactor this to avoid code duplication, likely as a part of merging `getNewPosts` and `getNewPostActions` into a single function.
 * @todo Possibly sort the actions chronologically.
 * @param context - The TriggerContext provided by Devvit, which contains all the stuff for interacting with Reddit, Redis, etc.
 * @param context.redis - Instance of RedisClient.
 * @param context.reddit - Instance of RedditAPIClient.
 * @param appSettings - The app settings, mainly for getting the promo subreddit name.
 */
export async function updateFromWikis ({redis, reddit}: TriggerContext, appSettings: AppSettings) {
  const newPostIds = await getNewPosts(reddit, redis, appSettings.promoSubreddit);
  for (const newPost of newPostIds) {
    try {
      const post = await reddit.getPostById(newPost.postId);
      if (!post) {
        console.warn('Post not found', newPost.postId);
        continue;
      }
      if (await hasCrosspost(redis, newPost.postId)) {
        console.warn('Post already crossposted', newPost.postId);
        await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        continue;
      }
      const crosspost = await reddit.crosspost({
        subredditName: appSettings.promoSubreddit,
        title: `Visit r/${post.subredditName}, they are trying to reach ${newPost.goal} subscribers!`,
        postId: post.id,
      });
      await storeCorrespondingPost(redis, newPost.postId, crosspost.id);
      await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
    } catch (e) {
      console.error('Error crossposting', newPost.postId, e);
    }
  }

  const postActions = [
    ...await getNewPostActions(reddit, redis, appSettings.promoSubreddit, 'remove'),
    ...await getNewPostActions(reddit, redis, appSettings.promoSubreddit, 'approve'),
    ...await getNewPostActions(reddit, redis, appSettings.promoSubreddit, 'delete'),
  ];
  for (const postAction of postActions) {
    try {
      const crosspostId = await getCorrespondingPost(redis, postAction.postId);
      if (!crosspostId) {
        console.warn('Crosspost not found', postAction.postId);
        continue;
      }
      switch (postAction.action) {
      case 'remove':
        await reddit.remove(crosspostId, false);
        break;
      case 'approve':
        await reddit.approve(crosspostId);
        break;
      case 'delete':
        await (await reddit.getPostById(crosspostId)).delete();
        break;
      }
      await storeProcessedRevision(redis, postAction.revisionId, postAction.postId);
    } catch (e) {
      console.error('Error processing action', postAction.postId, e);
    }
  }
}

/**
 * The "ModAction" trigger fires for every new entry in the subreddit's moderation log.
 * Some of the normal limitations of the modlog apply here (such as some automod actions not being logged).
 * Actions taken by the app itself will also be logged here, you may want to ignore those to avoid infinite loops.
 *
 * This function has two execution paths depending on whether the app is currently running in the central promo subreddit or not:
 *
 * - If this app instance is running in the promo subreddit, it will only handle `wikirevise` actions, which are used to recieve events from other subreddits. Assuming this is the case, it will call {@linkcode updateFromWikis} to process new wiki revisions.
 *
 * - If this is a regular installation of the app, this function only monitor for `removelink`, `approvelink`, and `spamlink` actions. These actions are sent to the central promo subreddit, so the app there can mirror the actions on the crossposted post there. Removal actions are always sent, while approval actions are only sent if crossposting is enabled. The reasoning here is that crossposting may have been disabled after a post was already crossposted, meaning we'd still want to process removal for it. Assuming all the conditions are met, it will call {@linkcode dispatchPostAction}.
 * @param event - This is the event data about the mod action that caused the trigger to fire.
 * @param context - This is the TriggerContext provided by Devvit, which contains all the stuff for interacting with Reddit, Redis, etc.
 */
export async function onModAction (event: ModAction, context: TriggerContext) {
  const appSettings = await getAppSettings(context.settings);
  const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

  if (subredditName.toLowerCase() === appSettings.promoSubreddit.toLowerCase()) {
    if (event.action === 'wikirevise') {
      await updateFromWikis(context, appSettings);
    }
    return; // We don't want to execute further in the promo subreddit.
  } else if (event.action !== 'removelink' && event.action !== 'approvelink' && event.action !== 'spamlink') {
    return; // If it's a different subreddit, we only care about these actions.
  }

  if (!event.targetPost) {
    console.warn('ModAction missing targetPost', event);
    return;
  }

  const appAccount = await context.reddit.getAppUser();
  if (event.moderator?.name === appAccount.username) {
    return; // Ignore actions taken by the app itself, like approving immediately after posting
  }

  if (event.targetPost.authorId !== appAccount.id) {
    return; // Ignore actions taken by the app itself, like approving immediately after posting
  }

  if (!appSettings.crosspost && event.action === 'approvelink') {
    return; // Ignore approvals if crossposting is disabled, we still want to respect removals though (in case the setting was changed after the post was already crossposted)
  }
  await dispatchPostAction(context.reddit, appSettings, event.targetPost.id, modToPostActionMap[event.action]);
}

/**
 * @description This registers `onModAction` as the handler for `ModAction` trigger. It is exported via main.js to tell Devvit about the trigger.
 */
export const modActionTrigger = Devvit.addTrigger({
  event: 'ModAction',
  onEvent: onModAction,
});
