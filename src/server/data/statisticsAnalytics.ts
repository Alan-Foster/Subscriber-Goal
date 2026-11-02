import type {
  StatisticsComparableValue,
  StatisticsResponse,
} from "../../shared/types/api";
import type { RedisClient } from "../types";

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const retentionSeconds = 30 * 24 * 60 * 60;
const visitorBitmapBits = 16_384;
const visitorBitmapBytes = visitorBitmapBits / 8;
const dedupeBitmapBits = 1_048_576;

type AnalyticsEventType = "load" | "join_click" | "join_confirmed" | "cta";

const hourStart = (nowMs: number): number =>
  Math.floor(nowMs / hourMs) * hourMs;
const dayStart = (nowMs: number): number => Math.floor(nowMs / dayMs) * dayMs;
const countsKey = (hour: number): string => `statistics:v1:counts:${hour}`;
const visitorKey = (hour: number): string => `statistics:v1:visitors:${hour}`;
const ctaVisitorKey = (labelId: string, hour: number): string =>
  `statistics:v1:cta-visitors:${labelId}:${hour}`;
const dedupeKey = (type: AnalyticsEventType, day: number): string =>
  `statistics:v1:dedupe:${type}:${day}`;

function hash32(value: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  return hash >>> 0;
}

const labelId = (label: string): string =>
  hash32(`cta-label:${label}`).toString(16).padStart(8, "0");

async function setBitmapMember(
  redis: RedisClient,
  key: string,
  identity: string,
  size: number,
): Promise<boolean> {
  const offset = hash32(identity) % size;
  const [previous = 0] = await redis.bitfield(key, "set", "u1", offset, 1);
  await redis.expire(key, retentionSeconds);
  return previous === 0;
}

async function claimEvent(
  redis: RedisClient,
  type: AnalyticsEventType,
  eventId: string,
  nowMs: number,
): Promise<boolean> {
  return await setBitmapMember(
    redis,
    dedupeKey(type, dayStart(nowMs)),
    `${type}:${eventId}`,
    dedupeBitmapBits,
  );
}

async function incrementFields(
  redis: RedisClient,
  hour: number,
  fields: string[],
): Promise<void> {
  const key = countsKey(hour);
  await Promise.all(fields.map((field) => redis.hIncrBy(key, field, 1)));
  await redis.expire(key, retentionSeconds);
}

export async function recordStatisticsLoad(
  redis: RedisClient,
  options: {
    eventId: string;
    visitorIdentity?: string;
    subscribed: boolean;
    nowMs?: number;
  },
): Promise<boolean> {
  const nowMs = options.nowMs ?? Date.now();
  if (!(await claimEvent(redis, "load", options.eventId, nowMs))) return false;
  const hour = hourStart(nowMs);
  await Promise.all([
    incrementFields(redis, hour, [
      "loads_total",
      options.subscribed ? "loads_subscribed" : "loads_unsubscribed",
    ]),
    options.visitorIdentity
      ? setBitmapMember(
          redis,
          visitorKey(hour),
          `visitor:${options.visitorIdentity}`,
          visitorBitmapBits,
        )
      : Promise.resolve(false),
  ]);
  return true;
}

export async function recordStatisticsJoinClick(
  redis: RedisClient,
  eventId: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!(await claimEvent(redis, "join_click", eventId, nowMs))) return false;
  await incrementFields(redis, hourStart(nowMs), ["join_clicks"]);
  return true;
}

export async function recordStatisticsConfirmedJoin(
  redis: RedisClient,
  attemptId: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!(await claimEvent(redis, "join_confirmed", attemptId, nowMs))) {
    return false;
  }
  await incrementFields(redis, hourStart(nowMs), ["join_confirmed"]);
  return true;
}

export async function recordStatisticsCtaClick(
  redis: RedisClient,
  options: {
    eventId: string;
    label: string;
    visitorIdentity?: string;
    nowMs?: number;
  },
): Promise<boolean> {
  const nowMs = options.nowMs ?? Date.now();
  if (!(await claimEvent(redis, "cta", options.eventId, nowMs))) return false;
  const hour = hourStart(nowMs);
  const id = labelId(options.label);
  const key = countsKey(hour);
  await redis.hSet(key, { [`cta_label:${id}`]: options.label });
  await Promise.all([
    incrementFields(redis, hour, ["cta_clicks", `cta_click:${id}`]),
    options.visitorIdentity
      ? setBitmapMember(
          redis,
          ctaVisitorKey(id, hour),
          `cta:${options.visitorIdentity}`,
          visitorBitmapBits,
        )
      : Promise.resolve(false),
  ]);
  return true;
}

const parseCount = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const sumField = (rows: Record<string, string>[], field: string): number =>
  rows.reduce((sum, row) => sum + parseCount(row[field]), 0);

const emptyBitmap = (): Uint8Array => new Uint8Array(visitorBitmapBytes);

function unionBuffers(buffers: Array<Buffer | undefined>): Uint8Array {
  const result = emptyBitmap();
  for (const buffer of buffers) {
    if (!buffer) continue;
    const limit = Math.min(result.length, buffer.length);
    for (let index = 0; index < limit; index += 1) {
      result[index] = result[index]! | buffer[index]!;
    }
  }
  return result;
}

function bitmapIntersection(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = emptyBitmap();
  for (let index = 0; index < result.length; index += 1) {
    result[index] = left[index]! & right[index]!;
  }
  return result;
}

function bitmapDifference(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = emptyBitmap();
  for (let index = 0; index < result.length; index += 1) {
    result[index] = left[index]! & ~right[index]!;
  }
  return result;
}

function countSetBits(bitmap: Uint8Array): number {
  let count = 0;
  for (const byte of bitmap) {
    let value = byte;
    while (value > 0) {
      value &= value - 1;
      count += 1;
    }
  }
  return count;
}

function estimateCardinality(bitmap: Uint8Array): number {
  const occupied = countSetBits(bitmap);
  if (occupied === 0) return 0;
  if (occupied >= visitorBitmapBits) return visitorBitmapBits;
  return Math.round(
    -visitorBitmapBits * Math.log(1 - occupied / visitorBitmapBits),
  );
}

const round = (value: number): number => Math.round(value * 100) / 100;

export function compareStatisticsValues(
  value: number,
  previousValue: number,
): StatisticsComparableValue {
  const absoluteChange = round(value - previousValue);
  const percentChange =
    previousValue === 0
      ? value === 0
        ? 0
        : null
      : round((absoluteChange / previousValue) * 100);
  return {
    value: round(value),
    previousValue: round(previousValue),
    absoluteChange,
    percentChange,
    comparisonStatus:
      previousValue === 0 && value > 0
        ? "new"
        : absoluteChange > 0
          ? "increase"
          : absoluteChange < 0
            ? "decrease"
            : "unchanged",
  };
}

const rate = (numerator: number, denominator: number): number =>
  denominator > 0 ? round((numerator / denominator) * 100) : 0;

const hoursForRange = (startHour: number, count: number): number[] =>
  Array.from({ length: count }, (_, index) => startHour + index * hourMs);

async function readVisitorUnion(
  redis: RedisClient,
  hours: number[],
  keyForHour: (hour: number) => string,
): Promise<Uint8Array> {
  return unionBuffers(
    await Promise.all(hours.map((hour) => redis.getBuffer(keyForHour(hour)))),
  );
}

export async function getStatisticsReport(
  redis: RedisClient,
  subredditName: string,
  hours: 24 | 168,
  nowMs = Date.now(),
): Promise<StatisticsResponse> {
  const currentFirstHour = hourStart(nowMs) - (hours - 1) * hourMs;
  const previousFirstHour = currentFirstHour - hours * hourMs;
  const prePreviousFirstHour = previousFirstHour - hours * hourMs;
  const currentHours = hoursForRange(currentFirstHour, hours);
  const previousHours = hoursForRange(previousFirstHour, hours);
  const prePreviousHours = hoursForRange(prePreviousFirstHour, hours);

  const [
    currentRows,
    previousRows,
    currentVisitors,
    previousVisitors,
    prePreviousVisitors,
  ] = await Promise.all([
    Promise.all(currentHours.map((hour) => redis.hGetAll(countsKey(hour)))),
    Promise.all(previousHours.map((hour) => redis.hGetAll(countsKey(hour)))),
    readVisitorUnion(redis, currentHours, visitorKey),
    readVisitorUnion(redis, previousHours, visitorKey),
    readVisitorUnion(redis, prePreviousHours, visitorKey),
  ]);

  const currentUnique = estimateCardinality(currentVisitors);
  const previousUnique = estimateCardinality(previousVisitors);
  const currentReturning = estimateCardinality(
    bitmapIntersection(currentVisitors, previousVisitors),
  );
  const previousReturning = estimateCardinality(
    bitmapIntersection(previousVisitors, prePreviousVisitors),
  );
  const currentNew = estimateCardinality(
    bitmapDifference(currentVisitors, previousVisitors),
  );
  const previousNew = estimateCardinality(
    bitmapDifference(previousVisitors, prePreviousVisitors),
  );

  const currentConfirmed = sumField(currentRows, "join_confirmed");
  const previousConfirmed = sumField(previousRows, "join_confirmed");
  const currentJoinClicks = sumField(currentRows, "join_clicks");
  const previousJoinClicks = sumField(previousRows, "join_clicks");
  const currentCtaClicks = sumField(currentRows, "cta_clicks");
  const previousCtaClicks = sumField(previousRows, "cta_clicks");

  const labels = new Map<string, string>();
  for (const row of [...currentRows, ...previousRows]) {
    for (const [field, value] of Object.entries(row)) {
      if (field.startsWith("cta_label:")) labels.set(field.slice(10), value);
    }
  }

  const byLabel = await Promise.all(
    [...labels.entries()]
      .sort((left, right) => left[1].localeCompare(right[1]))
      .map(async ([id, label]) => {
        const [currentLabelVisitors, previousLabelVisitors] = await Promise.all(
          [
            readVisitorUnion(redis, currentHours, (hour) =>
              ctaVisitorKey(id, hour),
            ),
            readVisitorUnion(redis, previousHours, (hour) =>
              ctaVisitorKey(id, hour),
            ),
          ],
        );
        return {
          label,
          clicks: compareStatisticsValues(
            sumField(currentRows, `cta_click:${id}`),
            sumField(previousRows, `cta_click:${id}`),
          ),
          uniqueUsers: compareStatisticsValues(
            estimateCardinality(currentLabelVisitors),
            estimateCardinality(previousLabelVisitors),
          ),
        };
      }),
  );

  return {
    schemaVersion: 1,
    subreddit: { name: subredditName },
    period: {
      hours,
      generatedAt: new Date(nowMs).toISOString(),
      start: new Date(currentFirstHour).toISOString(),
      end: new Date(nowMs).toISOString(),
      previousStart: new Date(previousFirstHour).toISOString(),
      previousEnd: new Date(currentFirstHour).toISOString(),
      bucketGranularitySeconds: 3600,
    },
    metrics: {
      loads: {
        total: compareStatisticsValues(
          sumField(currentRows, "loads_total"),
          sumField(previousRows, "loads_total"),
        ),
        subscribed: compareStatisticsValues(
          sumField(currentRows, "loads_subscribed"),
          sumField(previousRows, "loads_subscribed"),
        ),
        unsubscribed: compareStatisticsValues(
          sumField(currentRows, "loads_unsubscribed"),
          sumField(previousRows, "loads_unsubscribed"),
        ),
      },
      visitors: {
        unique: compareStatisticsValues(currentUnique, previousUnique),
        new: compareStatisticsValues(currentNew, previousNew),
        returning: compareStatisticsValues(currentReturning, previousReturning),
        returningRate: compareStatisticsValues(
          rate(currentReturning, currentUnique),
          rate(previousReturning, previousUnique),
        ),
      },
      joins: {
        clicks: compareStatisticsValues(currentJoinClicks, previousJoinClicks),
        confirmed: compareStatisticsValues(currentConfirmed, previousConfirmed),
        conversionRate: compareStatisticsValues(
          rate(currentConfirmed, currentJoinClicks),
          rate(previousConfirmed, previousJoinClicks),
        ),
      },
      ctas: {
        clicks: compareStatisticsValues(currentCtaClicks, previousCtaClicks),
        conversionRate: compareStatisticsValues(
          rate(currentCtaClicks, currentConfirmed),
          rate(previousCtaClicks, previousConfirmed),
        ),
        byLabel,
      },
    },
    methodology: {
      uniqueCounting:
        "Approximate linear-counting bitmaps aggregated into UTC hourly buckets.",
      newVisitorDefinition:
        "A visitor present in the selected period but absent from its immediately preceding equal-length period.",
      returningVisitorDefinition:
        "A visitor present in both the selected period and its immediately preceding equal-length period.",
      anonymousIdentity:
        "Anonymous uniqueness is browser/device based and resets if local storage is cleared.",
      membership:
        "Subscribed status is the app's server-side tracked membership state at initial load; Reddit does not expose the viewer's complete membership state to this app.",
      retentionDays: 30,
      collectionStartedAt: "deployment",
    },
  };
}
