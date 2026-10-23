import type { RedisClient } from "../types";

export const highlightContradictionKey =
  "subscriber_goal_highlight_contradiction_v1_state";

export type HighlightContradictionIncident = {
  postId: string;
  firstObservedAt: number;
  lastObservedAt: number;
  consecutiveCount: number;
  listed: boolean;
  postState: boolean;
};

export async function getHighlightContradictionIncident(
  redis: RedisClient,
): Promise<HighlightContradictionIncident | undefined> {
  const raw = await redis.hGetAll(highlightContradictionKey);
  const firstObservedAt = Number(raw.firstObservedAt);
  const lastObservedAt = Number(raw.lastObservedAt);
  const consecutiveCount = Number(raw.consecutiveCount);
  if (
    !raw.postId ||
    !Number.isFinite(firstObservedAt) ||
    !Number.isFinite(lastObservedAt) ||
    !Number.isFinite(consecutiveCount)
  ) {
    return undefined;
  }
  return {
    postId: raw.postId,
    firstObservedAt,
    lastObservedAt,
    consecutiveCount,
    listed: raw.listed === "true",
    postState: raw.postState === "true",
  };
}

export async function recordHighlightContradiction(
  redis: RedisClient,
  input: { postId: string; listed: boolean; postState: boolean; nowMs: number },
): Promise<HighlightContradictionIncident> {
  const existing = await getHighlightContradictionIncident(redis);
  const same = existing?.postId === input.postId;
  const incident: HighlightContradictionIncident = {
    postId: input.postId,
    firstObservedAt: same ? existing.firstObservedAt : input.nowMs,
    lastObservedAt: input.nowMs,
    consecutiveCount: same ? existing.consecutiveCount + 1 : 1,
    listed: input.listed,
    postState: input.postState,
  };
  await redis.hSet(highlightContradictionKey, {
    postId: incident.postId,
    firstObservedAt: String(incident.firstObservedAt),
    lastObservedAt: String(incident.lastObservedAt),
    consecutiveCount: String(incident.consecutiveCount),
    listed: String(incident.listed),
    postState: String(incident.postState),
  });
  return incident;
}

export async function clearHighlightContradictionIncident(
  redis: RedisClient,
  postId?: string,
): Promise<void> {
  if (!postId) {
    await redis.del(highlightContradictionKey);
    return;
  }
  const current = await getHighlightContradictionIncident(redis);
  if (current?.postId === postId) await redis.del(highlightContradictionKey);
}
