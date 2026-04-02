import { reddit, redis, context } from '@devvit/web/server';
import type { AppSettings } from '../../shared/types/api';
import { getAppSettings } from '../settings';
import {
  crosspostWikiPages,
  dispatchPostAction,
  getCorrespondingPost,
  hasCrosspost,
  isProcessedRevision,
  modToPostActionMap,
  parseNewPostDispatchReason,
  parsePostActionDispatchReason,
  storeCorrespondingPost,
  storeProcessedRevision,
} from '../data/crosspostData';
import { safeGetWikiPageRevisions } from '../utils/redditUtils';
import { isLinkId, isThingId, type LinkId } from '../types';

export type ModActionEvent = {
  action?: string;
  targetPost?: {
    id: string;
    authorId?: string;
    subredditId?: string;
    nsfw?: boolean;
    subredditName?: string;
  };
  moderator?: {
    name?: string;
  };
};

type NewPostEvent = {
  postId: LinkId;
  revisionId: string;
  goal: number;
};

type PostActionEvent = {
  postId: LinkId;
  revisionId: string;
  action: 'remove' | 'approve' | 'delete';
};

async function getNewPosts(
  appSettings: AppSettings
): Promise<NewPostEvent[]> {
  const revisions = await safeGetWikiPageRevisions(
    reddit,
    appSettings.promoSubreddit,
    crosspostWikiPages.newPost
  );
  if (!revisions) {
    return [];
  }

  const newPosts: Set<NewPostEvent> = new Set();
  for (const revision of revisions) {
    if (await isProcessedRevision(redis, revision.id)) {
      continue;
    }

    const parsedReason = parseNewPostDispatchReason(revision.reason);
    if (!parsedReason) {
      console.warn(
        `[crosspost] skipping revision with unexpected new-post reason: revisionId=${revision.id} reason=${revision.reason}`
      );
      continue;
    }
    const { postId, goal } = parsedReason;
    if (!postId || Number.isNaN(goal) || !isLinkId(postId)) {
      console.warn(
        `[crosspost] skipping new-post revision with invalid payload: revisionId=${revision.id} postId=${postId} goal=${goal}`
      );
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

async function getNewPostActions(
  appSettings: AppSettings,
  actionType: 'remove' | 'approve' | 'delete'
): Promise<PostActionEvent[]> {
  const revisions = await safeGetWikiPageRevisions(
    reddit,
    appSettings.promoSubreddit,
    crosspostWikiPages.action[actionType]
  );
  if (!revisions) {
    return [];
  }

  const newPosts: Set<PostActionEvent> = new Set();
  for (const revision of revisions) {
    if (await isProcessedRevision(redis, revision.id)) {
      continue;
    }

    const parsedReason = parsePostActionDispatchReason(
      revision.reason,
      actionType
    );
    if (!parsedReason) {
      console.warn(
        `[crosspost] skipping revision with unexpected action reason: revisionId=${revision.id} action=${actionType} reason=${revision.reason}`
      );
      continue;
    }
    const { postId } = parsedReason;
    if (!postId || !isLinkId(postId)) {
      console.warn(
        `[crosspost] skipping action revision with invalid post id: revisionId=${revision.id} action=${actionType} postId=${postId}`
      );
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

async function updateFromWikis(appSettings: AppSettings): Promise<void> {
  const newPostIds = await getNewPosts(appSettings);
  for (const newPost of newPostIds) {
    try {
      const post = await reddit.getPostById(newPost.postId);
      if (!post) {
        console.info(
          `[crosspost] source post missing; marking processed: revisionId=${newPost.revisionId} postId=${newPost.postId}`
        );
        await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        continue;
      }
      if (await hasCrosspost(redis, newPost.postId)) {
        console.info(
          `[crosspost] mapping already exists; skipping duplicate crosspost: revisionId=${newPost.revisionId} postId=${newPost.postId}`
        );
        await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        continue;
      }
      const crosspost = await reddit.crosspost({
        subredditName: appSettings.promoSubreddit,
        title: `Visit r/${post.subredditName}, they are trying to reach ${newPost.goal} subscribers!`,
        postId: post.id,
        nsfw:
          post.nsfw ??
          (await reddit.getSubredditInfoById(post.subredditId)).isNsfw,
      });
      await storeCorrespondingPost(redis, newPost.postId, crosspost.id);
      await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
      console.info(
        `[crosspost] created crosspost and marked processed: revisionId=${newPost.revisionId} sourcePostId=${newPost.postId} crosspostId=${crosspost.id}`
      );
    } catch (e) {
      console.error(
        `[crosspost] error creating crosspost: revisionId=${newPost.revisionId} postId=${newPost.postId}`,
        e
      );
    }
  }

  const postActions = [
    ...(await getNewPostActions(appSettings, 'remove')),
    ...(await getNewPostActions(appSettings, 'approve')),
    ...(await getNewPostActions(appSettings, 'delete')),
  ];
  for (const postAction of postActions) {
    let terminal = false;
    try {
      const crosspostId = await getCorrespondingPost(redis, postAction.postId);
      if (!crosspostId) {
        console.info(
          `[crosspost] no mapping found for action; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId}`
        );
        terminal = true;
        await storeProcessedRevision(redis, postAction.revisionId, postAction.postId);
        continue;
      }
      switch (postAction.action) {
        case 'remove':
          if (!isThingId(crosspostId)) {
            console.warn(
              `[crosspost] mapped id is not a valid thing id; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} mappedId=${crosspostId}`
            );
            terminal = true;
            break;
          }
          await reddit.remove(crosspostId, false);
          break;
        case 'approve':
          if (!isThingId(crosspostId)) {
            console.warn(
              `[crosspost] mapped id is not a valid thing id; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} mappedId=${crosspostId}`
            );
            terminal = true;
            break;
          }
          await reddit.approve(crosspostId);
          break;
        case 'delete': {
          if (!isLinkId(crosspostId)) {
            console.warn(
              `[crosspost] mapped id is not a valid post id for delete; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} mappedId=${crosspostId}`
            );
            terminal = true;
            break;
          }
          const crosspost = await reddit.getPostById(crosspostId);
          await crosspost.delete();
          break;
        }
      }
      terminal = true;
      console.info(
        `[crosspost] mirrored action and marked processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} crosspostId=${crosspostId}`
      );
    } catch (e) {
      const errorText = e instanceof Error ? e.message : String(e);
      const missingCrosspost =
        /not[\s-]?found|does not exist|deleted|no longer exists/i.test(errorText);
      if (missingCrosspost) {
        terminal = true;
        console.warn(
          `[crosspost] missing target while mirroring action; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} error=${errorText}`
        );
      } else {
        console.error(
          `[crosspost] error mirroring action: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId}`,
          e
        );
      }
    }

    if (terminal) {
      await storeProcessedRevision(
        redis,
        postAction.revisionId,
        postAction.postId
      );
    }
  }
}

export async function onModAction(event: ModActionEvent): Promise<void> {
  const appSettings = await getAppSettings(
    (context as { settings?: { getAll<T>(): Promise<Partial<T>> } }).settings
  );
  const subredditName =
    context.subredditName ?? (await reddit.getCurrentSubreddit()).name;

  if (
    subredditName.toLowerCase() === appSettings.promoSubreddit.toLowerCase()
  ) {
    if (event.action === 'wikirevise') {
      await updateFromWikis(appSettings);
    }
    return;
  }

  if (
    event.action !== 'removelink' &&
    event.action !== 'approvelink' &&
    event.action !== 'spamlink'
  ) {
    return;
  }

  if (!event.targetPost) {
    console.warn('ModAction missing targetPost', event);
    return;
  }

  const appAccount = await reddit.getAppUser();
  if (!appAccount) {
    console.warn('ModAction missing app account context');
    return;
  }
  if (event.moderator?.name === appAccount.username) {
    return;
  }

  if (event.targetPost.authorId !== appAccount.id) {
    return;
  }

  if (event.action === 'approvelink') {
    return;
  }

  const mappedAction = modToPostActionMap[event.action];
  if (!mappedAction) {
    return;
  }

  await dispatchPostAction(
    reddit,
    appSettings,
    event.targetPost.id,
    mappedAction
  );
}
