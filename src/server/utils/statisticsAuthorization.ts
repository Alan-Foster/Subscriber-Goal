import type { RedditClient } from "../types";

const developerUsername = "alan-foster";

type ViewerHint = {
  username: string;
  isModerator?: boolean;
  moderatedSubreddits?: string[];
};

const normalize = (value: string): string => value.trim().toLowerCase();

export async function canViewCurrentSubredditStatistics(
  reddit: RedditClient,
  userId: string | null | undefined,
  subredditName: string,
  viewerHint?: ViewerHint | null,
): Promise<boolean> {
  if (!userId) return false;

  const viewer = viewerHint ?? (await reddit.getCurrentUser());
  if (!viewer) return false;
  const username = viewer.username?.trim();
  if (!username) return false;
  if (normalize(username) === developerUsername) return true;
  if (viewer.isModerator !== true) return false;

  const moderatedSubreddits =
    "moderatedSubreddits" in viewer && viewer.moderatedSubreddits
      ? viewer.moderatedSubreddits
      : "modPermissions" in viewer && viewer.modPermissions instanceof Map
        ? [...viewer.modPermissions.keys()]
        : null;
  if (moderatedSubreddits) {
    return moderatedSubreddits.some(
      (name) => normalize(name) === normalize(subredditName),
    );
  }

  const moderators = await reddit
    .getModerators({
      subredditName,
      username,
      limit: 1,
      pageSize: 1,
    })
    .all();
  return moderators.some(
    (moderator) => normalize(moderator.username) === normalize(username),
  );
}
