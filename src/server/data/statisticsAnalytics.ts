import type {
  StatisticsComparableValue,
  StatisticsCoverage,
  StatisticsCoveragePeriod,
  StatisticsResponse,
} from "../../shared/types/api";
import type { RedisClient } from "../types";

const hourMs = 3_600_000;
const retentionHours = 720;
const retentionSeconds = 2_592_000;
const bitmapBits = 16_384;
const bitmapBytes = bitmapBits / 8;
const dedupeBits = 1_048_576;
type EventType = "load" | "join_click" | "join_confirmed" | "cta";
type SessionKind =
  | "all"
  | "subscribed"
  | "join_eligible"
  | "secondary_eligible"
  | "cta_only_eligible"
  | "interaction_eligible"
  | "interaction"
  | "join_click"
  | "secondary_click"
  | "cta_only_click";
export type StatisticsExposure = "join" | "secondary_cta" | "cta_only" | "none";

const hourStart = (time: number) => Math.floor(time / hourMs) * hourMs;
const dayStart = (time: number) =>
  Math.floor(time / (24 * hourMs)) * 24 * hourMs;
const countsKey = (hour: number) => `statistics:v1:counts:${hour}`;
const visitorKey = (hour: number) => `statistics:v1:visitors:${hour}`;
const sessionKey = (kind: SessionKind, hour: number) =>
  `statistics:v2:sessions:${kind}:${hour}`;
const ctaSessionKey = (id: string, hour: number) =>
  `statistics:v2:cta-sessions:${id}:${hour}`;
const dedupeKey = (type: EventType, day: number) =>
  `statistics:v1:dedupe:${type}:${day}`;
const coverageKey = (family: "traffic" | "sessions") =>
  `statistics:v2:coverage:${family}`;

function hash32(value: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1)
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  return hash >>> 0;
}
const labelId = (label: string) =>
  hash32(`cta-label:${label}`).toString(16).padStart(8, "0");
const sessionMember = (identity: string, postId: string) =>
  `session:${identity}:${postId}`;

async function mark(
  redis: RedisClient,
  key: string,
  identity: string,
  size = bitmapBits,
): Promise<boolean> {
  const [previous = 0] = await redis.bitfield(
    key,
    "set",
    "u1",
    hash32(identity) % size,
    1,
  );
  await redis.expire(key, retentionSeconds);
  return previous === 0;
}
async function ensureCoverage(
  redis: RedisClient,
  family: "traffic" | "sessions",
  now: number,
): Promise<void> {
  const key = coverageKey(family);
  await redis.set(key, String(hourStart(now)), { nx: true });
  await redis.expire(key, retentionSeconds);
}
async function claim(
  redis: RedisClient,
  type: EventType,
  eventId: string,
  now: number,
): Promise<boolean> {
  return await mark(
    redis,
    dedupeKey(type, dayStart(now)),
    `${type}:${eventId}`,
    dedupeBits,
  );
}
async function increment(
  redis: RedisClient,
  hour: number,
  fields: string[],
): Promise<void> {
  const key = countsKey(hour);
  await Promise.all(fields.map((field) => redis.hIncrBy(key, field, 1)));
  await redis.expire(key, retentionSeconds);
}
async function markSessions(
  redis: RedisClient,
  hour: number,
  identity: string | undefined,
  postId: string,
  kinds: SessionKind[],
): Promise<void> {
  if (!identity) return;
  const member = sessionMember(identity, postId);
  await Promise.all(
    kinds.map((kind) => mark(redis, sessionKey(kind, hour), member)),
  );
}

export async function recordStatisticsLoad(
  redis: RedisClient,
  options: {
    eventId: string;
    postId: string;
    visitorIdentity?: string;
    appTrackedSubscribed: boolean;
    exposure: StatisticsExposure;
    nowMs?: number;
  },
): Promise<boolean> {
  const now = options.nowMs ?? Date.now();
  if (!(await claim(redis, "load", options.eventId, now))) return false;
  const hour = hourStart(now);
  const kinds: SessionKind[] = ["all"];
  if (options.appTrackedSubscribed) kinds.push("subscribed");
  if (options.exposure === "join") kinds.push("join_eligible");
  if (options.exposure === "secondary_cta") kinds.push("secondary_eligible");
  if (options.exposure === "cta_only") kinds.push("cta_only_eligible");
  if (options.exposure !== "none") kinds.push("interaction_eligible");
  await Promise.all([
    increment(redis, hour, [
      "loads_total",
      options.appTrackedSubscribed ? "loads_subscribed" : "loads_unsubscribed",
    ]),
    options.visitorIdentity
      ? mark(redis, visitorKey(hour), `visitor:${options.visitorIdentity}`)
      : Promise.resolve(false),
    markSessions(redis, hour, options.visitorIdentity, options.postId, kinds),
    ensureCoverage(redis, "traffic", now),
    ensureCoverage(redis, "sessions", now),
  ]);
  return true;
}

export async function recordStatisticsJoinClick(
  redis: RedisClient,
  options: {
    eventId: string;
    postId: string;
    visitorIdentity?: string;
    nowMs?: number;
  },
): Promise<boolean> {
  const now = options.nowMs ?? Date.now();
  if (!(await claim(redis, "join_click", options.eventId, now))) return false;
  const hour = hourStart(now);
  await Promise.all([
    increment(redis, hour, ["join_clicks"]),
    markSessions(redis, hour, options.visitorIdentity, options.postId, [
      "join_click",
      "interaction",
    ]),
    ensureCoverage(redis, "sessions", now),
  ]);
  return true;
}

export async function recordStatisticsConfirmedJoin(
  redis: RedisClient,
  options: {
    attemptId: string;
    postId: string;
    visitorIdentity?: string | undefined;
    secondaryCtaEligible?: boolean;
    nowMs?: number;
  },
): Promise<boolean> {
  const now = options.nowMs ?? Date.now();
  if (!(await claim(redis, "join_confirmed", options.attemptId, now)))
    return false;
  const hour = hourStart(now);
  await Promise.all([
    increment(redis, hour, ["join_confirmed"]),
    options.secondaryCtaEligible
      ? markSessions(redis, hour, options.visitorIdentity, options.postId, [
          "subscribed",
          "secondary_eligible",
          "interaction_eligible",
        ])
      : Promise.resolve(),
    ensureCoverage(redis, "sessions", now),
  ]);
  return true;
}

export async function recordStatisticsCtaClick(
  redis: RedisClient,
  options: {
    eventId: string;
    postId: string;
    label: string;
    kind: "secondary" | "cta_only";
    visitorIdentity?: string;
    nowMs?: number;
  },
): Promise<boolean> {
  const now = options.nowMs ?? Date.now();
  if (!(await claim(redis, "cta", options.eventId, now))) return false;
  const hour = hourStart(now);
  const id = labelId(options.label);
  const secondary = options.kind === "secondary";
  await redis.hSet(countsKey(hour), { [`cta_label:${id}`]: options.label });
  await Promise.all([
    increment(redis, hour, [
      "cta_clicks",
      `cta_click:${id}`,
      secondary ? "secondary_cta_clicks" : "cta_only_clicks",
      ...(secondary ? [`secondary_cta_click:${id}`] : []),
    ]),
    options.visitorIdentity && secondary
      ? mark(
          redis,
          ctaSessionKey(id, hour),
          sessionMember(options.visitorIdentity, options.postId),
        )
      : Promise.resolve(false),
    markSessions(redis, hour, options.visitorIdentity, options.postId, [
      secondary ? "secondary_click" : "cta_only_click",
      "interaction",
    ]),
    ensureCoverage(redis, "sessions", now),
  ]);
  return true;
}

const parseCount = (value: string | undefined) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
};
const sumField = (rows: Record<string, string>[], field: string) =>
  rows.reduce((sum, row) => sum + parseCount(row[field]), 0);
const empty = () => new Uint8Array(bitmapBytes);
function union(buffers: Array<Buffer | Uint8Array | undefined>): Uint8Array {
  const result = empty();
  for (const buffer of buffers)
    if (buffer)
      for (
        let index = 0;
        index < Math.min(result.length, buffer.length);
        index += 1
      )
        result[index] = result[index]! | buffer[index]!;
  return result;
}
function intersection(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = empty();
  for (let index = 0; index < result.length; index += 1)
    result[index] = left[index]! & right[index]!;
  return result;
}
function difference(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = empty();
  for (let index = 0; index < result.length; index += 1)
    result[index] = left[index]! & ~right[index]!;
  return result;
}
function bitCount(bitmap: Uint8Array): number {
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
function estimate(bitmap: Uint8Array): number {
  const occupied = bitCount(bitmap);
  return occupied === 0
    ? 0
    : occupied >= bitmapBits
      ? bitmapBits
      : Math.round(-bitmapBits * Math.log(1 - occupied / bitmapBits));
}
const round = (value: number) => Math.round(value * 100) / 100;

export function compareStatisticsValues(
  value: number | null,
  previousValue: number | null,
  comparisonAvailable = true,
): StatisticsComparableValue {
  if (value === null || previousValue === null || !comparisonAvailable)
    return {
      value,
      previousValue,
      absoluteChange: null,
      percentChange: null,
      comparisonStatus: "unavailable",
    };
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
const rate = (numerator: number, denominator: number) =>
  denominator > 0 ? round((numerator / denominator) * 100) : null;
const range = (start: number, count: number) =>
  Array.from({ length: count }, (_, index) => start + index * hourMs);
async function bitmapRows(
  redis: RedisClient,
  hours: number[],
  key: (hour: number) => string,
): Promise<Uint8Array[]> {
  return await Promise.all(
    hours.map(async (hour) => union([await redis.getBuffer(key(hour))])),
  );
}
async function bitmapUnion(
  redis: RedisClient,
  hours: number[],
  key: (hour: number) => string,
): Promise<Uint8Array> {
  return union(await bitmapRows(redis, hours, key));
}
function cohorts(history: Uint8Array, rows: Uint8Array[]) {
  let prior = union([history]);
  let unique = empty();
  let newVisitors = empty();
  let returning = empty();
  for (const row of rows) {
    unique = union([unique, row]);
    newVisitors = union([newVisitors, difference(row, prior)]);
    returning = union([returning, intersection(row, prior)]);
    prior = union([prior, row]);
  }
  return {
    unique: estimate(unique),
    newVisitors: estimate(newVisitors),
    returning: estimate(returning),
  };
}

const coveragePeriod = (
  first: number | null,
  start: number,
  end: number,
  requestedHours: number,
): StatisticsCoveragePeriod => {
  if (first === null || first >= end)
    return { status: "unavailable", coveredHours: 0, requestedHours };
  const coveredHours = Math.min(
    requestedHours,
    Math.max(0, Math.ceil((end - Math.max(start, first)) / hourMs)),
  );
  return {
    status: first <= start ? "complete" : "partial",
    coveredHours,
    requestedHours,
  };
};
async function coverage(
  redis: RedisClient,
  family: "traffic" | "sessions",
  inferred: number | null,
  currentStart: number,
  previousStart: number,
  end: number,
  hours: number,
): Promise<StatisticsCoverage> {
  const parsed = Number(await redis.get(coverageKey(family)));
  const stored = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  const first =
    stored === null
      ? inferred
      : inferred === null
        ? stored
        : Math.min(stored, inferred);
  return {
    firstKnownAt: first === null ? null : new Date(first).toISOString(),
    inferredFromLegacyData:
      inferred !== null && (stored === null || inferred < stored),
    current: coveragePeriod(first, currentStart, end, hours),
    previous: coveragePeriod(first, previousStart, currentStart, hours),
  };
}
const comparable = (
  current: number | null,
  previous: number | null,
  info: StatisticsCoverage,
) =>
  compareStatisticsValues(
    info.current.status === "unavailable" ? null : current,
    info.previous.status === "unavailable" ? null : previous,
    info.current.status === "complete" && info.previous.status === "complete",
  );

export async function getStatisticsReport(
  redis: RedisClient,
  subredditName: string,
  hours: 24 | 168,
  nowMs = Date.now(),
): Promise<StatisticsResponse> {
  const currentStart = hourStart(nowMs) - (hours - 1) * hourMs;
  const previousStart = currentStart - hours * hourMs;
  const retainedStart = hourStart(nowMs) - (retentionHours - 1) * hourMs;
  const currentHours = range(currentStart, hours);
  const previousHours = range(previousStart, hours);
  const historicalHours = range(
    retainedStart,
    Math.max(0, (previousStart - retainedStart) / hourMs),
  );
  const allHours = [...historicalHours, ...previousHours, ...currentHours];
  const [allRows, allVisitors] = await Promise.all([
    Promise.all(allHours.map((hour) => redis.hGetAll(countsKey(hour)))),
    bitmapRows(redis, allHours, visitorKey),
  ]);
  const offset = historicalHours.length;
  const previousRows = allRows.slice(offset, offset + hours);
  const currentRows = allRows.slice(offset + hours);
  const previousVisitors = allVisitors.slice(offset, offset + hours);
  const currentVisitors = allVisitors.slice(offset + hours);
  const previousCohorts = cohorts(
    union(allVisitors.slice(0, offset)),
    previousVisitors,
  );
  const currentCohorts = cohorts(
    union(allVisitors.slice(0, offset + hours)),
    currentVisitors,
  );
  const firstLegacyIndex = allRows.findIndex(
    (row, index) =>
      Object.keys(row).length > 0 || bitCount(allVisitors[index]!) > 0,
  );
  const trafficCoverage = await coverage(
    redis,
    "traffic",
    firstLegacyIndex < 0 ? null : allHours[firstLegacyIndex]!,
    currentStart,
    previousStart,
    nowMs,
    hours,
  );
  const sessionCoverage = await coverage(
    redis,
    "sessions",
    null,
    currentStart,
    previousStart,
    nowMs,
    hours,
  );

  const sessionPair = async (kind: SessionKind) => {
    const [current, previous] = await Promise.all([
      bitmapUnion(redis, currentHours, (hour) => sessionKey(kind, hour)),
      bitmapUnion(redis, previousHours, (hour) => sessionKey(kind, hour)),
    ]);
    return [estimate(current), estimate(previous)] as const;
  };
  const [
    sessions,
    subscribed,
    joinEligible,
    secondaryEligible,
    ctaOnlyEligible,
    interactionEligible,
    interactions,
    joinSessions,
    secondarySessions,
    ctaOnlySessions,
  ] = await Promise.all([
    sessionPair("all"),
    sessionPair("subscribed"),
    sessionPair("join_eligible"),
    sessionPair("secondary_eligible"),
    sessionPair("cta_only_eligible"),
    sessionPair("interaction_eligible"),
    sessionPair("interaction"),
    sessionPair("join_click"),
    sessionPair("secondary_click"),
    sessionPair("cta_only_click"),
  ]);
  const jc = sumField(currentRows, "join_clicks"),
    jp = sumField(previousRows, "join_clicks"),
    cc = sumField(currentRows, "join_confirmed"),
    cp = sumField(previousRows, "join_confirmed");
  const sc = sumField(currentRows, "secondary_cta_clicks"),
    sp = sumField(previousRows, "secondary_cta_clicks"),
    oc = sumField(currentRows, "cta_only_clicks"),
    op = sumField(previousRows, "cta_only_clicks");
  const ac = sumField(currentRows, "cta_clicks"),
    ap = sumField(previousRows, "cta_clicks");
  const labels = new Map<string, string>();
  for (const row of [...currentRows, ...previousRows])
    for (const [field, value] of Object.entries(row))
      if (field.startsWith("cta_label:")) labels.set(field.slice(10), value);
  const byLabel = await Promise.all(
    [...labels.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(async ([id, label]) => {
        const [current, previous] = await Promise.all([
          bitmapUnion(redis, currentHours, (hour) => ctaSessionKey(id, hour)),
          bitmapUnion(redis, previousHours, (hour) => ctaSessionKey(id, hour)),
        ]);
        return {
          label,
          clicks: comparable(
            sumField(currentRows, `secondary_cta_click:${id}`),
            sumField(previousRows, `secondary_cta_click:${id}`),
            sessionCoverage,
          ),
          uniqueSessions: comparable(
            estimate(current),
            estimate(previous),
            sessionCoverage,
          ),
        };
      }),
  );

  return {
    schemaVersion: 2,
    subreddit: { name: subredditName },
    period: {
      hours,
      generatedAt: new Date(nowMs).toISOString(),
      start: new Date(currentStart).toISOString(),
      end: new Date(nowMs).toISOString(),
      previousStart: new Date(previousStart).toISOString(),
      previousEnd: new Date(currentStart).toISOString(),
      bucketGranularitySeconds: 3600,
    },
    metrics: {
      traffic: {
        impressions: comparable(
          sumField(currentRows, "loads_total"),
          sumField(previousRows, "loads_total"),
          trafficCoverage,
        ),
        viewingSessions: comparable(sessions[0], sessions[1], sessionCoverage),
      },
      visitors: {
        unique: comparable(
          currentCohorts.unique,
          previousCohorts.unique,
          trafficCoverage,
        ),
        new: comparable(
          currentCohorts.newVisitors,
          previousCohorts.newVisitors,
          trafficCoverage,
        ),
        returning: comparable(
          currentCohorts.returning,
          previousCohorts.returning,
          trafficCoverage,
        ),
        returningRate: comparable(
          rate(currentCohorts.returning, currentCohorts.unique),
          rate(previousCohorts.returning, previousCohorts.unique),
          trafficCoverage,
        ),
      },
      membership: {
        appTrackedSubscribedSessions: comparable(
          subscribed[0],
          subscribed[1],
          sessionCoverage,
        ),
        joinEligibleSessions: comparable(
          joinEligible[0],
          joinEligible[1],
          sessionCoverage,
        ),
      },
      joins: {
        clicks: comparable(jc, jp, sessionCoverage),
        uniqueClickSessions: comparable(
          joinSessions[0],
          joinSessions[1],
          sessionCoverage,
        ),
        confirmed: comparable(cc, cp, sessionCoverage),
        clickSuccessRate: comparable(
          rate(cc, jc),
          rate(cp, jp),
          sessionCoverage,
        ),
        ctr: comparable(
          rate(joinSessions[0], joinEligible[0]),
          rate(joinSessions[1], joinEligible[1]),
          sessionCoverage,
        ),
      },
      ctas: {
        clicks: comparable(sc, sp, sessionCoverage),
        uniqueClickSessions: comparable(
          secondarySessions[0],
          secondarySessions[1],
          sessionCoverage,
        ),
        eligibleSessions: comparable(
          secondaryEligible[0],
          secondaryEligible[1],
          sessionCoverage,
        ),
        ctr: comparable(
          rate(secondarySessions[0], secondaryEligible[0]),
          rate(secondarySessions[1], secondaryEligible[1]),
          sessionCoverage,
        ),
        byLabel,
      },
      ctaOnly: {
        clicks: comparable(oc, op, sessionCoverage),
        uniqueClickSessions: comparable(
          ctaOnlySessions[0],
          ctaOnlySessions[1],
          sessionCoverage,
        ),
        eligibleSessions: comparable(
          ctaOnlyEligible[0],
          ctaOnlyEligible[1],
          sessionCoverage,
        ),
        ctr: comparable(
          rate(ctaOnlySessions[0], ctaOnlyEligible[0]),
          rate(ctaOnlySessions[1], ctaOnlyEligible[1]),
          sessionCoverage,
        ),
      },
      interactions: {
        uniqueSessions: comparable(
          interactions[0],
          interactions[1],
          sessionCoverage,
        ),
        eligibleSessions: comparable(
          interactionEligible[0],
          interactionEligible[1],
          sessionCoverage,
        ),
        ctr: comparable(
          rate(interactions[0], interactionEligible[0]),
          rate(interactions[1], interactionEligible[1]),
          sessionCoverage,
        ),
      },
      legacy: {
        unclassifiedCtaClicks: comparable(
          Math.max(0, ac - sc - oc),
          Math.max(0, ap - sp - op),
          trafficCoverage,
        ),
      },
    },
    coverage: {
      trafficAndVisitors: trafficCoverage,
      sessionsAndInteractions: sessionCoverage,
    },
    methodology: {
      formulas: {
        appImpressions:
          "Successful initializations, deduplicated by client-mount event ID.",
        viewingSessions:
          "Unique anonymous visitor and post combinations within each UTC hour.",
        joinClickSuccessRate: "Confirmed joins / raw Join clicks.",
        joinCtr: "Unique Join-click sessions / Join-eligible sessions.",
        secondaryCtaCtr:
          "Unique post-subscription CTA-click sessions / eligible app-tracked subscribed CTA sessions.",
        ctaOnlyCtr:
          "Unique CTA-only click sessions / eligible CTA-only sessions.",
        overallInteractionCtr:
          "Unique sessions with any tracked interaction / unique eligible interaction sessions.",
      },
      uniqueCounting:
        "Approximate linear-counting bitmaps aggregated into UTC hourly buckets.",
      newVisitorDefinition:
        "A visitor whose first observed session in retained history occurs in the selected period.",
      returningVisitorDefinition:
        "A visitor with a selected-period session after an earlier retained session; new and returning can overlap within one period.",
      anonymousIdentity:
        "Anonymous uniqueness is browser/device based and resets if local storage is cleared; raw identities are not persisted.",
      membership:
        "Membership means app-tracked subscription state, not verified complete Reddit community membership.",
      retentionDays: 30,
      sessionDefinition:
        "One anonymous visitor plus post per fixed UTC hour; different posts remain separate sessions.",
    },
  };
}
