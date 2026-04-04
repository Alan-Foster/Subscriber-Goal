export function validateSubredditDisplayName(
  input: string | undefined,
  canonicalSubredditName: string
): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) {
    return 'Please provide a subreddit display name.';
  }

  if (trimmed.toLowerCase() !== canonicalSubredditName.toLowerCase()) {
    return 'Subreddit display name can only change capitalization; all other characters must match exactly.';
  }

  return undefined;
}
