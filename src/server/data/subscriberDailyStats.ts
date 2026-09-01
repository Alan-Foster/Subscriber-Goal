import type { RedisClient } from "../types";

export const subscriberDailyStatsKey = "subscriber_daily_stats_v1";
export const subscriberDailyStatsVersion = "subscriber_daily_stats_v2";

const baselineField = (utcDayStartMs: number): string =>
  `baseline:${utcDayStartMs}`;
const recoveredBaselineField = (utcDayStartMs: number): string =>
  `recoveredBaseline:${utcDayStartMs}`;
const latestField = (utcDayStartMs: number): string =>
  `latest:${utcDayStartMs}`;

const utcDayMs = 24 * 60 * 60 * 1000;
const rollingWindowDays = 7;
const retainedDayBuckets = 8;

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
  newSubscribersThisWeek: number;
  growth: {
    count: number;
    period: "today" | "week";
  };
};

const getStoredBaseline = (
  fields: Record<string, string>,
  utcDayStartMs: number,
): number | null =>
  parseSubscriberCount(fields[baselineField(utcDayStartMs)]) ??
  parseSubscriberCount(fields[recoveredBaselineField(utcDayStartMs)]);

const getRollingGrowth = (
  fields: Record<string, string>,
  utcDayStartMs: number,
  displayedSubscribers: number,
): { today: number; week: number } => {
  let week = 0;
  let today = 0;

  for (let offset = 0; offset < rollingWindowDays; offset += 1) {
    const dayStartMs = utcDayStartMs - offset * utcDayMs;
    const baseline = getStoredBaseline(fields, dayStartMs);
    if (baseline === null) continue;

    const latest =
      offset === 0
        ? displayedSubscribers
        : (parseSubscriberCount(fields[latestField(dayStartMs)]) ??
          getStoredBaseline(fields, dayStartMs + utcDayMs));
    if (latest === null) continue;

    const growth = Math.max(0, latest - baseline);
    if (offset === 0) today = growth;
    week += growth;
  }

  return { today, week };
};

const getExpiredDayFields = (
  fields: Record<string, string>,
  utcDayStartMs: number,
): string[] => {
  const oldestRetainedDayStartMs =
    utcDayStartMs - (retainedDayBuckets - 1) * utcDayMs;
  return Object.keys(fields).filter((field) => {
    const match = /^(?:baseline|recoveredBaseline|latest):(\d+)$/.exec(field);
    return match ? Number(match[1]) < oldestRetainedDayStartMs : false;
  });
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
    [latestField(utcDayStartMs)]: String(latestSubscribers),
  });

  const storedFields = await redis.hGetAll(subscriberDailyStatsKey);
  const rollingGrowth = getRollingGrowth(
    storedFields,
    utcDayStartMs,
    displayedSubscribers,
  );
  const expiredFields = getExpiredDayFields(storedFields, utcDayStartMs);
  if (expiredFields.length > 0) {
    await redis.hDel(subscriberDailyStatsKey, expiredFields);
  }

  const growth =
    rollingGrowth.week >= rollingWindowDays
      ? { count: Math.max(1, rollingGrowth.today), period: "today" as const }
      : { count: Math.max(1, rollingGrowth.week), period: "week" as const };

  return {
    utcDayStartMs,
    baselineSubscribers,
    latestSubscribers,
    observedAtMs: nowMs,
    newSubscribersToday: rollingGrowth.today,
    newSubscribersThisWeek: rollingGrowth.week,
    growth,
  };
}
