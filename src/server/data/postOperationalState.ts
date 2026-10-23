import type { RedisClient } from "../types";

export const postOperationalStateKeyPrefix =
  "subscriber_goal_post_operational_v1";

export type PostOperationalState = {
  postId: string;
  archived: boolean;
  locked: boolean;
  highlightBlocked: boolean;
  updatedAt: number;
};

const key = (postId: string): string =>
  `${postOperationalStateKeyPrefix}:${postId}`;

export async function getPostOperationalState(
  redis: RedisClient,
  postId: string,
): Promise<PostOperationalState | undefined> {
  const raw = await redis.hGetAll(key(postId));
  const updatedAt = Number(raw.updatedAt);
  if (!raw.postId || !Number.isFinite(updatedAt)) return undefined;
  return {
    postId: raw.postId,
    archived: raw.archived === "true",
    locked: raw.locked === "true",
    highlightBlocked: raw.highlightBlocked === "true",
    updatedAt,
  };
}

export async function savePostOperationalState(
  redis: RedisClient,
  state: PostOperationalState,
): Promise<void> {
  await redis.hSet(key(state.postId), {
    postId: state.postId,
    archived: String(state.archived),
    locked: String(state.locked),
    highlightBlocked: String(state.highlightBlocked),
    updatedAt: String(state.updatedAt),
  });
}

export async function clearPostOperationalState(
  redis: RedisClient,
  postId: string,
): Promise<void> {
  await redis.del(key(postId));
}
