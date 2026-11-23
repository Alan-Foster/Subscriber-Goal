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
      isOptionalString(value.authorId) &&
      isOptionalString(value.subredditId) &&
      isOptionalString(value.subredditName) &&
      (value.nsfw === undefined || typeof value.nsfw === "boolean"))
  );
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
