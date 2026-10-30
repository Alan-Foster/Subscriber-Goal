export function getCurrentSubredditNsfw(subreddit: {
  nsfw?: unknown;
}): boolean | undefined {
  return typeof subreddit.nsfw === "boolean" ? subreddit.nsfw : undefined;
}

export function isCrosspostEligible(
  subreddit: { name: string; type?: unknown; nsfw?: unknown },
  promoSubreddit: string,
): boolean {
  return (
    subreddit.type === "public" &&
    getCurrentSubredditNsfw(subreddit) === false &&
    subreddit.name.toLowerCase() !== promoSubreddit.toLowerCase()
  );
}
