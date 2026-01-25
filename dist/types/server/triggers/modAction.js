import { reddit, redis, context } from '@devvit/web/server';
import { getAppSettings } from '../settings';
import { dispatchPostAction, getCorrespondingPost, hasCrosspost, isProcessedRevision, modToPostActionMap, storeCorrespondingPost, storeProcessedRevision, } from '../data/crosspostData';
import { safeGetWikiPageRevisions } from '../utils/redditUtils';
const isLinkId = (postId) => /^t3_[\w\d]+$/.test(postId);
async function getNewPosts(appSettings) {
    const revisions = await safeGetWikiPageRevisions(reddit, appSettings.promoSubreddit, 'post');
    if (!revisions) {
        return [];
    }
    const newPosts = new Set();
    for (const revision of revisions) {
        if (await isProcessedRevision(redis, revision.id)) {
            continue;
        }
        const match = revision.reason.match(/Post (t3_[\w\d]+) with goal (\d+)/);
        if (!match) {
            continue;
        }
        const [, postId, goalString] = match;
        const goal = parseInt(goalString);
        if (!postId || Number.isNaN(goal) || !isLinkId(postId)) {
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
async function getNewPostActions(appSettings, actionType) {
    const revisions = await safeGetWikiPageRevisions(reddit, appSettings.promoSubreddit, `${actionType}`);
    if (!revisions) {
        return [];
    }
    const newPosts = new Set();
    for (const revision of revisions) {
        if (await isProcessedRevision(redis, revision.id)) {
            continue;
        }
        const match = revision.reason.match(new RegExp(`Dispatch ${actionType} for (t3_[\\w\\d]+)`));
        if (!match) {
            continue;
        }
        const [, postId] = match;
        if (!postId || !isLinkId(postId)) {
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
async function updateFromWikis(appSettings) {
    const newPostIds = await getNewPosts(appSettings);
    for (const newPost of newPostIds) {
        try {
            const post = await reddit.getPostById(newPost.postId);
            if (!post) {
                await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
                continue;
            }
            if (await hasCrosspost(redis, newPost.postId)) {
                await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
                continue;
            }
            const crosspost = await reddit.crosspost({
                subredditName: appSettings.promoSubreddit,
                title: `Visit r/${post.subredditName}, they are trying to reach ${newPost.goal} subscribers!`,
                postId: post.id,
                nsfw: post.nsfw ??
                    (await reddit.getSubredditInfoById(post.subredditId)).isNsfw,
            });
            await storeCorrespondingPost(redis, newPost.postId, crosspost.id);
            await storeProcessedRevision(redis, newPost.revisionId, newPost.postId);
        }
        catch (e) {
            console.error('Error crossposting', newPost.postId, e);
        }
    }
    const postActions = [
        ...(await getNewPostActions(appSettings, 'remove')),
        ...(await getNewPostActions(appSettings, 'approve')),
        ...(await getNewPostActions(appSettings, 'delete')),
    ];
    for (const postAction of postActions) {
        try {
            const crosspostId = await getCorrespondingPost(redis, postAction.postId);
            if (!crosspostId) {
                await storeProcessedRevision(redis, postAction.revisionId, postAction.postId);
                continue;
            }
            switch (postAction.action) {
                case 'remove':
                    await reddit.remove(crosspostId, false);
                    break;
                case 'approve':
                    await reddit.approve(crosspostId);
                    break;
                case 'delete': {
                    const crosspost = await reddit.getPostById(crosspostId);
                    await crosspost.delete();
                    break;
                }
            }
            await storeProcessedRevision(redis, postAction.revisionId, postAction.postId);
        }
        catch (e) {
            console.error('Error processing action', postAction.postId, e);
        }
    }
}
export async function onModAction(event) {
    const appSettings = await getAppSettings(context.settings);
    const subredditName = context.subredditName ?? (await reddit.getCurrentSubredditName());
    if (subredditName.toLowerCase() === appSettings.promoSubreddit.toLowerCase()) {
        if (event.action === 'wikirevise') {
            await updateFromWikis(appSettings);
        }
        return;
    }
    if (event.action !== 'removelink' &&
        event.action !== 'approvelink' &&
        event.action !== 'spamlink') {
        return;
    }
    if (!event.targetPost) {
        console.warn('ModAction missing targetPost', event);
        return;
    }
    const appAccount = await reddit.getAppUser();
    if (event.moderator?.name === appAccount.username) {
        return;
    }
    if (event.targetPost.authorId !== appAccount.id) {
        return;
    }
    if (event.action === 'approvelink') {
        return;
    }
    await dispatchPostAction(reddit, appSettings, event.targetPost.id, modToPostActionMap[event.action]);
}
//# sourceMappingURL=modAction.js.map