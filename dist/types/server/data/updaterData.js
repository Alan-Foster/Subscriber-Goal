export const postsKey = 'posts';
export const updatesKey = 'updater';
export async function trackPost(redis, postId, created) {
    await redis.zAdd(postsKey, { member: postId, score: created.getTime() });
}
export async function untrackPost(redis, postId) {
    await redis.zRem(postsKey, [postId]);
}
export async function getTrackedPosts(redis) {
    const zRangeResult = await redis.zRange(postsKey, 0, -1);
    return zRangeResult.map((result) => result.member);
}
export async function getQueuedUpdates(redis) {
    const zRangeResult = await redis.zRange(updatesKey, 0, -1);
    return zRangeResult.map((result) => result.member);
}
export async function queueUpdate(redis, postId, lastUpdate) {
    await redis.zAdd(updatesKey, { member: postId, score: lastUpdate.getTime() });
}
export async function queueUpdates(redis, postIds) {
    const members = postIds.map((postId) => ({
        member: postId,
        score: Date.now(),
    }));
    await redis.zAdd(updatesKey, ...members);
}
export async function cancelUpdates(redis, postId) {
    await redis.zRem(updatesKey, [postId]);
}
//# sourceMappingURL=updaterData.js.map