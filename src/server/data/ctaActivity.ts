import type { AfterSubscribePreset } from "../../shared/afterSubscribeAction";
import type { CompactCtaActivityMetric } from "../../shared/types/api";
import type { RedditClient, RedisClient } from "../types";
import { getUtcDayStartMs } from "./subscriberDailyStats";

const utcDayMs = 24 * 60 * 60 * 1000;
const rollingWindowDays = 7;
const retainedSeconds = 9 * 24 * 60 * 60;
const postBackfillLimit = 1_000;
const postBackfillCompleteKey = "community_post_activity_backfill_v1";
const postBackfillLockKey = "community_post_activity_backfill_lock_v1";

const postDayKey = (dayStartMs: number): string =>
  `community_post_activity:${dayStartMs}`;
const clickDayKey = (postId: string, dayStartMs: number): string =>
  `cta_click_activity:${postId}:${dayStartMs}`;

export const postActivityPresets = new Set<AfterSubscribePreset>([
  "top-post-day",
  "newest-post",
  "create-post",
  "share-picture",
]);

export const clickActivityPresets = new Set<AfterSubscribePreset>([
  "web-link",
  "discord",
  "wiki",
]);

export function isClickActivityPreset(
  preset: AfterSubscribePreset | null,
): boolean {
  return preset !== null && clickActivityPresets.has(preset);
}

export async function recordCommunityPostCreated(
  redis: RedisClient,
  postId: string,
  createdAt: unknown,
): Promise<void> {
  const createdAtMs = normalizeCreatedAtMs(createdAt);
  if (!postId || createdAtMs === null) return;
  const dayStartMs = getUtcDayStartMs(createdAtMs);
  const key = postDayKey(dayStartMs);
  await redis.zAdd(key, { member: postId, score: createdAtMs });
  await redis.expire(key, retainedSeconds);
}

export async function ensureCommunityPostActivityBackfill(
  reddit: RedditClient,
  redis: RedisClient,
  subredditName: string,
  options: { nowMs?: number } = {},
): Promise<void> {
  if (await redis.get(postBackfillCompleteKey)) return;
  const lock = await redis.set(postBackfillLockKey, "1", {
    nx: true,
    expiration: new Date(Date.now() + 2 * 60 * 1000),
  });
  if (!lock) return;
  try {
    const nowMs = options.nowMs ?? Date.now();
    const oldestDayStartMs =
      getUtcDayStartMs(nowMs) - (rollingWindowDays - 1) * utcDayMs;
    const posts = await reddit
      .getNewPosts({
        subredditName,
        limit: postBackfillLimit,
        pageSize: 100,
      })
      .all();
    for (const post of posts) {
      const createdAtMs = normalizeCreatedAtMs(post.createdAt);
      if (createdAtMs !== null && createdAtMs >= oldestDayStartMs) {
        await recordCommunityPostCreated(redis, post.id, createdAtMs);
      }
    }
    await redis.set(postBackfillCompleteKey, String(nowMs));
  } finally {
    await redis.del(postBackfillLockKey);
  }
}

export async function recordCtaClick(
  redis: RedisClient,
  postId: string,
  options: { nowMs?: number } = {},
): Promise<void> {
  const dayStartMs = getUtcDayStartMs(options.nowMs ?? Date.now());
  const key = clickDayKey(postId, dayStartMs);
  await redis.incrBy(key, 1);
  await redis.expire(key, retainedSeconds);
}

export async function getCtaActivityMetric(
  redis: RedisClient,
  postId: string,
  preset: AfterSubscribePreset | null,
  options: { nowMs?: number } = {},
): Promise<CompactCtaActivityMetric> {
  const todayStartMs = getUtcDayStartMs(options.nowMs ?? Date.now());
  if (isClickActivityPreset(preset)) {
    const values = await redis.mGet(
      rollingDayStarts(todayStartMs).map((day) => clickDayKey(postId, day)),
    );
    return {
      kind: "clicks",
      count: values.reduce((sum, value) => sum + parseCount(value), 0),
      period: "week",
    };
  }

  const counts = await Promise.all(
    rollingDayStarts(todayStartMs).map((day) => redis.zCard(postDayKey(day))),
  );
  const week = counts.reduce((sum, count) => sum + count, 0);
  return week >= rollingWindowDays
    ? { kind: "posts", count: Math.max(1, counts[0] ?? 0), period: "today" }
    : { kind: "posts", count: Math.max(1, week), period: "week" };
}

const rollingDayStarts = (todayStartMs: number): number[] =>
  Array.from(
    { length: rollingWindowDays },
    (_, offset) => todayStartMs - offset * utcDayMs,
  );

const parseCount = (value: string | null): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const normalizeCreatedAtMs = (value: unknown): number | null => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
