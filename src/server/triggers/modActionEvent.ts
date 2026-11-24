import { isOptionalString, isRecord } from "../utils/runtimeValidation";

export type ModActionEvent = {
  action?: string;
  actionedAt?: string;
  targetUser?: {
    name?: string;
  };
  targetPost?: {
    id: string;
    authorId?: string;
    subredditId?: string;
    nsfw?: boolean;
    subredditName?: string;
  };
  moderator?: {
    name?: string;
  };
};

function isOptionalNamedUser(value: unknown): boolean {
  return (
    value === undefined || (isRecord(value) && isOptionalString(value.name))
  );
}

function isOptionalTargetPost(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      typeof value.id === "string" &&
      hasValidPostMetadata(value))
  );
}

function hasValidPostMetadata(post: Record<string, unknown>): boolean {
  return (
    isOptionalString(post.authorId) &&
    isOptionalString(post.subredditId) &&
    isOptionalString(post.subredditName) &&
    (post.nsfw === undefined || typeof post.nsfw === "boolean")
  );
}

function isAbsentTargetPost(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      (value.id === undefined || value.id === "") &&
      hasValidPostMetadata(value))
  );
}

/**
 * Treats fields the platform may send as empty as absent, so the strict
 * validator below only rejects real type errors. ts-proto's `PostV2.toJSON`
 * omits an empty `id`, so a placeholder `targetPost` can arrive without one.
 * Downstream handlers already handle a missing `targetPost`. Returns a
 * shallow copy and never mutates the request body.
 */
export function normalizeModActionEvent(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const normalized = { ...value };
  if (isAbsentTargetPost(normalized.targetPost)) delete normalized.targetPost;
  if (normalized.targetUser === null) delete normalized.targetUser;
  if (normalized.moderator === null) delete normalized.moderator;
  return normalized;
}

export function isModActionEvent(value: unknown): value is ModActionEvent {
  return (
    isRecord(value) &&
    isOptionalString(value.action) &&
    isOptionalString(value.actionedAt) &&
    isOptionalNamedUser(value.targetUser) &&
    isOptionalNamedUser(value.moderator) &&
    isOptionalTargetPost(value.targetPost)
  );
}
