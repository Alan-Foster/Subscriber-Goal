import type { RedisClient } from "../types";

export const subscriberDailyStatsKey = "subscriber_daily_stats_v1";
export const subscriberDailyStatsVersion = "subscriber_daily_stats_v1";

const baselineField = (utcDayStartMs: number): string =>
  `baseline:${utcDayStartMs}`;
const recoveredBaselineField = (utcDayStartMs: number): string =>
  `recoveredBaseline:${utcDayStartMs}`;

const parseSubscriberCount = (value: string | undefined): number | null => {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const normalizeSubscriberCount = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid subscriber count: ${String(value)}`);
  }
  return Math.trunc(value);
};

export const getUtcDayStartMs = (nowMs: number): number => {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

export type DailySubscriberObservation = {
  utcDayStartMs: number;
  baselineSubscribers: number;
  latestSubscribers: number;
  observedAtMs: number;
  newSubscribersToday: number;
};

/**
 * Atomically establishes one baseline per UTC day, records the latest Reddit
 * total, and returns non-negative net growth from that baseline.
 *
 * `displayedSubscribers` may include the subscribe route's optimistic +1 while
 * `currentSubscribers` remains the raw Reddit total used to initialize the
 * baseline and persist the latest observation.
 */
export async function observeDailySubscriberCount(
  redis: RedisClient,
  currentSubscribers: number,
  options: {
    nowMs?: number;
    displayedSubscribers?: number;
  } = {},
): Promise<DailySubscriberObservation> {
  const nowMs = options.nowMs ?? Date.now();
  const latestSubscribers = normalizeSubscriberCount(currentSubscribers);
  const displayedSubscribers = normalizeSubscriberCount(
    options.displayedSubscribers ?? currentSubscribers,
  );
  const utcDayStartMs = getUtcDayStartMs(nowMs);
  const field = baselineField(utcDayStartMs);

  let rawBaseline = await redis.hGet(subscriberDailyStatsKey, field);
  if (rawBaseline !== undefined && parseSubscriberCount(rawBaseline) === null) {
    const recoveryField = recoveredBaselineField(utcDayStartMs);
    await redis.hSetNX(
      subscriberDailyStatsKey,
      recoveryField,
      String(latestSubscribers),
    );
    rawBaseline = await redis.hGet(subscriberDailyStatsKey, recoveryField);
  }
  if (rawBaseline === undefined) {
    await redis.hSetNX(
      subscriberDailyStatsKey,
      field,
      String(latestSubscribers),
    );
    rawBaseline = await redis.hGet(subscriberDailyStatsKey, field);
  }

  const baselineSubscribers = parseSubscriberCount(rawBaseline);
  if (baselineSubscribers === null) {
    throw new Error("Could not establish the UTC subscriber baseline.");
  }

  await redis.hSet(subscriberDailyStatsKey, {
    version: subscriberDailyStatsVersion,
    utcDayStartMs: String(utcDayStartMs),
    baselineSubscribers: String(baselineSubscribers),
    latestSubscribers: String(latestSubscribers),
    observedAtMs: String(nowMs),
  });

  return {
    utcDayStartMs,
    baselineSubscribers,
    latestSubscribers,
    observedAtMs: nowMs,
    newSubscribersToday: Math.max(
      0,
      displayedSubscribers - baselineSubscribers,
    ),
  };
}
