export function getCurrentSubredditNsfw(subreddit: {
  nsfw?: unknown;
}): boolean | undefined {
  return typeof subreddit.nsfw === "boolean" ? subreddit.nsfw : undefined;
}
