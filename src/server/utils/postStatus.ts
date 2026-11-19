import { classifyPostLookupError } from "../core/postRetirement";

// The SDK describes removal actors, not irreversibility. Only author deletion
// is terminal; moderation, filtering and admin takedowns may be reversed.
// https://developers.reddit.com/docs/api/redditapi/models/classes/Post#removedbycategory
// https://support.reddithelp.com/hc/en-us/articles/360043483451
// https://support.reddithelp.com/hc/en-us/articles/23511059871252
export const terminalRemovedByCategories = ["author", "deleted"] as const;

export type TerminalRemovedByCategory =
  (typeof terminalRemovedByCategories)[number];

export type PostAvailability =
  | { status: "active" }
  | { status: "temporarily_removed"; category?: string }
  | { status: "terminal"; category: TerminalRemovedByCategory };

export function getPostAvailability(post: unknown): PostAvailability {
  if (!post || typeof post !== "object")
    return { status: "temporarily_removed" };
  const data = post as {
    removedByCategory?: unknown;
    removed?: unknown;
    spam?: unknown;
  };
  const category =
    typeof data.removedByCategory === "string"
      ? data.removedByCategory.trim()
      : undefined;
  if (
    terminalRemovedByCategories.includes(category as TerminalRemovedByCategory)
  ) {
    return {
      status: "terminal",
      category: category as TerminalRemovedByCategory,
    };
  }
  if (
    category ||
    data.removed === true ||
    data.spam === true ||
    (data.removedByCategory != null &&
      typeof data.removedByCategory !== "string")
  ) {
    return { status: "temporarily_removed", ...(category ? { category } : {}) };
  }
  return { status: "active" };
}

export const getTerminalRemovedByCategory = (
  post: unknown,
): TerminalRemovedByCategory | undefined => {
  const availability = getPostAvailability(post);
  return availability.status === "terminal" ? availability.category : undefined;
};

// A known removal is a pause, not a failed creation attempt. Keep rechecking
// without using the finite error budgets or replacing the known post.
export const temporarilyRemovedPostRecheckDelayMs = 60 * 60 * 1000;
export const getPostUpdateRecheckKey = (postId: string): string =>
  `subscriber_goal_update_recheck_v1:${postId}`;

export class PostTemporarilyUnavailableError extends Error {
  constructor(
    readonly postId: string,
    readonly category?: string,
  ) {
    super(
      `Post ${postId} is temporarily removed or its removal status is uncertain.`,
    );
    this.name = "PostTemporarilyUnavailableError";
  }
}

export const isMissingPostError = (error: unknown, postId?: string): boolean =>
  classifyPostLookupError(error, postId).status === "missing";
