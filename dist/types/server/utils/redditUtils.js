export async function getSubredditIcon(reddit, subredditId, defaultIconUrl = 'https://i.redd.it/xaaj3xsdy0re1.png') {
    const subredditStyles = await reddit.getSubredditStyles(subredditId);
    return (subredditStyles.icon ??
        defaultIconUrl);
}
export async function clearUserStickies(reddit, username) {
    const subreddit = await reddit.getCurrentSubreddit();
    const topPosts = await reddit
        .getHotPosts({ limit: 2, subredditName: subreddit.name })
        .all();
    for (const post of topPosts) {
        if (post.stickied && post.authorName === username) {
            await post.unsticky();
            console.log(`Unstickied post: ${post.id}`);
        }
    }
}
export async function safeGetWikiPageRevisions(reddit, subredditName, page) {
    try {
        const revisions = await reddit.getWikiPageRevisions({ subredditName, page }).all();
        return revisions.map((revision) => ({
            id: revision.id,
            reason: revision.reason ?? '',
        }));
    }
    catch (e) {
        console.error(`Failed to get wiki page ${page} for subreddit ${subredditName}:`, e);
        return undefined;
    }
}
//# sourceMappingURL=redditUtils.js.map