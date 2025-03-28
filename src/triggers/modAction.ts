import {ModAction} from '@devvit/protos';
import {Devvit, RedditAPIClient, RedisClient, TriggerContext} from '@devvit/public-api';
import {isLinkId} from '@devvit/shared-types/tid.js';

import {dispatchPostAction, getCorrespondingPost, hasCrosspost, isProcessedRevision, modToPostActionMap, PostActionType, storeCorrespondingPost, storeProcessedRevision} from '../data/crosspostData.js';
import {AppSettings, getAppSettings} from '../settings.js';
import {safeGetWikiPageRevisions} from '../utils/subredditUtils.js';

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
      await reddit.crosspost({
        subredditName: appSettings.promoSubreddit,
        title: `Visit r/${appSettings.promoSubreddit}, they are trying to reach ${newPost.goal} subscribers!`,
        postId: post.id,
      });
      await storeCorrespondingPost(redis, newPost.postId, post.id);
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
  await dispatchPostAction(context.reddit, appSettings, event.targetPost.id, modToPostActionMap['event.action']);
}

export const modActionTrigger = Devvit.addTrigger({
  event: 'ModAction',
  onEvent: onModAction,
});
