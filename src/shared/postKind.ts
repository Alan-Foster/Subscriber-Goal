export const subscriberGoalPostKind = "subscriber-goal-v1" as const;
export const subscribeOnlyPostKind = "subscribe-only-v1" as const;

export type PostKind =
  | typeof subscriberGoalPostKind
  | typeof subscribeOnlyPostKind;

export type SubscriberGoalPostData = {
  postKind: PostKind;
};

export function resolvePostKind(value: unknown): PostKind | undefined {
  return value === subscriberGoalPostKind || value === subscribeOnlyPostKind
    ? value
    : undefined;
}

export function resolvePostKindFromPostData(
  value: unknown,
): PostKind | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return resolvePostKind((value as { postKind?: unknown }).postKind);
}
