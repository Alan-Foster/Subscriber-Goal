export const modToPostActionMap = {
    removelink: 'remove',
    spamlink: 'remove',
    approvelink: 'approve',
};
export async function dispatchNewPost(reddit, appSettings, postId, goal) {
    await reddit.updateWikiPage({
        subredditName: appSettings.promoSubreddit,
        page: '/post',
        content: `${postId}\n${goal}`,
        reason: `Post ${postId} with goal ${goal}`,
    });
}
export async function dispatchPostAction(reddit, appSettings, postId, action) {
    await reddit.updateWikiPage({
        subredditName: appSettings.promoSubreddit,
        page: `/${action}`,
        content: postId,
        reason: `Dispatch ${action} for ${postId}`,
    });
}
export const wikiRevisionCutoffKey = 'revisionCutoff';
export const processedRevisionsKey = 'processedRevisions';
export const crosspostListKey = 'crosspostList';
export async function storeRevisionCutoff(redis, cutoff) {
    await redis.set(wikiRevisionCutoffKey, cutoff.getTime().toString());
}
export async function getRevisionCutoff(redis) {
    const cutoff = await redis.get(wikiRevisionCutoffKey);
    if (!cutoff) {
        return new Date(0);
    }
    return new Date(parseInt(cutoff));
}
export async function storeProcessedRevision(redis, wikiRevisionId, postId) {
    await redis.hSet(processedRevisionsKey, {
        [wikiRevisionId]: postId,
    });
}
export async function isProcessedRevision(redis, wikiRevisionId) {
    const revision = await redis.hGet(processedRevisionsKey, wikiRevisionId);
    return !!revision;
}
export async function getAllProcessedRevisions(redis) {
    const revisions = await redis.hGetAll(processedRevisionsKey);
    return Object.keys(revisions);
}
export async function storeCorrespondingPost(redis, postId, crosspostId) {
    await redis.hSet(crosspostListKey, {
        [postId]: crosspostId,
    });
}
export async function getCorrespondingPost(redis, postId) {
    const crosspostId = await redis.hGet(crosspostListKey, postId);
    return crosspostId;
}
export async function hasCrosspost(redis, postId) {
    const crosspostId = await redis.hGet(crosspostListKey, postId);
    return !!crosspostId;
}
//# sourceMappingURL=crosspostData.js.map