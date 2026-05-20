export const terminalRemovedByCategories = [
  'anti_evil_ops',
  'author',
  'automod_filtered',
  'community_ops',
  'content_takedown',
  'copyright_takedown',
  'deleted',
  'moderator',
  'reddit',
] as const;

export type TerminalRemovedByCategory = (typeof terminalRemovedByCategories)[number];

export const getTerminalRemovedByCategory = (
  post: unknown
): TerminalRemovedByCategory | string | undefined => {
  if (!post || typeof post !== 'object') {
    return undefined;
  }
  const removedByCategory = (post as { removedByCategory?: unknown })
    .removedByCategory;
  if (typeof removedByCategory === 'string') {
    return removedByCategory;
  }
  return undefined;
};

export const isMissingPostError = (error: unknown): boolean => {
  const errorText = error instanceof Error ? error.message : String(error);
  return /no post\s+t3_|not[\s-]?found|does not exist|deleted|no longer exists/i.test(
    errorText
  );
};
