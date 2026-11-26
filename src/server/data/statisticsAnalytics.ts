import { createHash, randomUUID } from "node:crypto";
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
const dedupeWindowHours = 48;
const bitmapBits = 16_384;
const bitmapBytes = bitmapBits / 8;
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
export type StatisticsExposure =
  | "join"
  | "secondary_cta"
  // A signed-in viewer who has not joined sees Join and the configured
  // follow-up CTA side by side on active regular and short goals.
  | "join_and_secondary_cta"
  | "cta_only"
  | "none";

const hourStart = (time: number) => Math.floor(time / hourMs) * hourMs;
const countsKey = (hour: number) => `statistics:v1:counts:${hour}`;
const visitorKey = (hour: number) => `statistics:v1:visitors:${hour}`;
const sessionKey = (kind: SessionKind, hour: number) =>
  `statistics:v2:sessions:${kind}:${hour}`;
const ctaSessionKey = (id: string, hour: number) =>
  `statistics:v2:cta-sessions:${id}:${hour}`;
type CoverageFamily = "traffic" | "sessions" | "ctr-invariants";
const coverageKey = (family: CoverageFamily) =>
  family === "ctr-invariants"
    ? "statistics:v3:coverage:ctr-invariants"
    : `statistics:v2:coverage:${family}`;

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
): Promise<boolean> {
  const [previous = 0] = await redis.bitfield(
    key,
    "set",
    "u1",
    hash32(identity) % bitmapBits,
    1,
  );
  await redis.expire(key, retentionSeconds);
  return previous === 0;
}
async function ensureCoverage(
  redis: RedisClient,
  family: CoverageFamily,
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
  const digest = createHash("sha256").update(eventId).digest("base64url");
  const key = `statistics:v2:dedupe:${type}:${digest}`;
  const expiresAt = now + dedupeWindowHours * hourMs;
  const token = `${expiresAt}:${randomUUID()}`;
  // Devvit rounds SET expiry down to whole seconds. Keep the stored claim
  // briefly past its logical deadline so it cannot disappear early.
  const expiration = new Date(expiresAt + 1000);
  // Old bitmaps expire on their original schedule. Their bits cannot identify
  // individual events, so pre-upgrade retries may count again during rollout.
  await redis.set(key, token, {
    nx: true,
    expiration,
  });
  const owner = await redis.get(key);
  if (owner === token) return true;
  const isLive = (value: string | undefined) =>
    !!value && Number(value.split(":", 1)[0]) > now;
  if (isLive(owner)) return false;

  // Replace a logically expired claim atomically if Redis still holds it,
  // or if it expired between the failed NX write and the ownership read.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const transaction = await redis.watch(key);
    let multiStarted = false;
    try {
      if (isLive(await redis.get(key))) {
        await transaction.unwatch();
        return false;
      }
      await transaction.multi();
      multiStarted = true;
      await transaction.set(key, token, { expiration });
      if ((await transaction.exec()).length > 0) return true;
    } catch (error) {
      try {
        await (multiStarted ? transaction.discard() : transaction.unwatch());
      } catch {
        // diagnostic-allow-silent: preserve the original claim error.
      }
      throw error;
    }
  }
  throw new Error("Statistics claim changed during every update attempt.");
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
  if (
    options.exposure === "join" ||
    options.exposure === "join_and_secondary_cta"
  )
    kinds.push("join_eligible");
  if (
    options.exposure === "secondary_cta" ||
    options.exposure === "join_and_secondary_cta"
  )
    kinds.push("secondary_eligible");
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
    ensureCoverage(redis, "ctr-invariants", now),
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
      "join_eligible",
      "interaction_eligible",
      "join_click",
      "interaction",
    ]),
    ensureCoverage(redis, "sessions", now),
    ensureCoverage(redis, "ctr-invariants", now),
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
  await recordStatisticsJoinClick(redis, {
    eventId: options.attemptId,
    postId: options.postId,
    ...(options.visitorIdentity
      ? { visitorIdentity: options.visitorIdentity }
      : {}),
    nowMs: now,
  });
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
    ensureCoverage(redis, "ctr-invariants", now),
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
      secondary ? "secondary_eligible" : "cta_only_eligible",
      "interaction_eligible",
      secondary ? "secondary_click" : "cta_only_click",
      "interaction",
    ]),
    ensureCoverage(redis, "sessions", now),
    ensureCoverage(redis, "ctr-invariants", now),
  ]);
  return true;
}

const parseCount = (value: string | undefined) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
};
const sumField = (rows: Record<string, string>[], field: string) =>
  rows.reduce((sum, row) => sum + parseCount(row[field]), 0);
const empty = (): Uint8Array => new Uint8Array(bitmapBytes);
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
function estimate(bitmap: Uint8Array): number | null {
  const occupied = bitCount(bitmap);
  return occupied === 0
    ? 0
    : occupied >= bitmapBits
      ? null
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
const rate = (numerator: number | null, denominator: number | null) =>
  numerator !== null && denominator !== null && denominator > 0
    ? round((numerator / denominator) * 100)
    : null;
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
async function hourlyEstimateSum(
  redis: RedisClient,
  hours: number[],
  key: (hour: number) => string,
): Promise<number | null> {
  let total = 0;
  for (const row of await bitmapRows(redis, hours, key)) {
    const value = estimate(row);
    if (value === null) return null;
    total += value;
  }
  return total;
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
  family: CoverageFamily,
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
  const windows = getStatisticsWindows(hours, nowMs);
  const { currentStart, previousStart } = windows;
  const traffic = await readStatisticsTraffic(redis, windows, hours);
  const coverage = await readStatisticsCoverage(
    redis,
    windows,
    traffic.firstObservedAt,
    nowMs,
    hours,
  );
  const { trafficCoverage, sessionCoverage, ctrCoverage } = coverage;
  const sessions = await readStatisticsSessions(redis, windows);
  const clicks = countStatisticsClicks(traffic);
  const byLabel = await readStatisticsCtaLabels(
    redis,
    windows,
    traffic,
    sessionCoverage,
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
      ...buildTrafficAndMembershipMetrics(traffic, sessions, coverage),
      ...buildJoinAndCtaMetrics(clicks, sessions, coverage, byLabel),
      ...buildInteractionAndLegacyMetrics(clicks, sessions, coverage),
    },
    coverage: {
      trafficAndVisitors: trafficCoverage,
      sessionsAndInteractions: sessionCoverage,
      ctrInvariants: ctrCoverage,
    },
    methodology: {
      formulas: {
        appImpressions:
          "Successful initializations, deduplicated by client-mount event ID for 48 hours.",
        viewingSessions:
          "Unique anonymous visitor and post combinations within each UTC hour.",
        joinClickSuccessRate: "Confirmed joins / raw Join clicks.",
        joinCtr: "Unique Join-click sessions / Join-eligible sessions.",
        secondaryCtaCtr:
          "Unique follow-up CTA-click sessions / sessions where the follow-up CTA was shown: app-tracked subscribers, plus signed-in viewers who have not joined on active regular and short goals. Logged-out viewers see sign-in buttons instead and are not counted. Short goals show the CTA before Join only on wider screens, so narrow-screen sessions of viewers who have not joined still count as eligible and can understate this rate.",
        ctaOnlyCtr:
          "Unique CTA-only click sessions / eligible CTA-only sessions.",
        overallInteractionCtr:
          "Unique sessions with any tracked interaction / unique eligible interaction sessions.",
      },
      uniqueCounting:
        "Approximate 16,384-bit linear-counting bitmaps aggregated into UTC hourly buckets; fully saturated buckets are reported as unavailable rather than capped.",
      newVisitorDefinition:
        "Deprecated compatibility field: a visitor whose first observed session in retained history occurs in the selected period; it can overlap Returning Visitors.",
      returningVisitorDefinition:
        "A visitor with a selected-period session after an earlier retained session; new and returning can overlap within one period.",
      anonymousIdentity:
        "Anonymous uniqueness is browser/device based and resets if local storage is cleared; raw identities are not persisted.",
      membership:
        "Membership means app-tracked subscription state, not verified complete Reddit community membership.",
      retentionDays: 30,
      dedupeWindowHours,
      approximationLimits:
        "Unique counts use one-hash linear counting. Accuracy degrades as a 16,384-bit hourly bucket fills, bitmap intersections remain collision-biased, and fully saturated buckets are unavailable.",
      sessionDefinition:
        "One anonymous visitor plus post per fixed UTC hour. Same-hour retries and remounts are deduplicated, separate hours and different posts count independently, and multiple genuine same-post openings within one hour cannot be distinguished.",
      ctrCoverageDefinition:
        "CTR denominator-repair invariants apply from coverage.ctrInvariants.firstKnownAt; earlier retained session data remains available but may have incomplete eligible-session denominators.",
    },
  };
}

function getStatisticsWindows(hours: 24 | 168, nowMs: number) {
  const currentStart = hourStart(nowMs) - (hours - 1) * hourMs;
  const previousStart = currentStart - hours * hourMs;
  const retainedStart = hourStart(nowMs) - (retentionHours - 1) * hourMs;
  const currentHours = range(currentStart, hours);
  const previousHours = range(previousStart, hours);
  const historicalHours = range(
    retainedStart,
    Math.max(0, (previousStart - retainedStart) / hourMs),
  );
  return {
    currentStart,
    previousStart,
    currentHours,
    previousHours,
    historicalHours,
  };
}

type StatisticsWindows = ReturnType<typeof getStatisticsWindows>;

async function readStatisticsTraffic(
  redis: RedisClient,
  { currentHours, previousHours, historicalHours }: StatisticsWindows,
  hours: 24 | 168,
) {
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
  return {
    currentRows,
    previousRows,
    currentCohorts,
    previousCohorts,
    firstObservedAt: firstLegacyIndex < 0 ? null : allHours[firstLegacyIndex]!,
  };
}

type StatisticsTraffic = Awaited<ReturnType<typeof readStatisticsTraffic>>;

async function readStatisticsCoverage(
  redis: RedisClient,
  { currentStart, previousStart }: StatisticsWindows,
  firstObservedAt: number | null,
  nowMs: number,
  hours: 24 | 168,
) {
  const trafficCoverage = await coverage(
    redis,
    "traffic",
    firstObservedAt,
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
  const ctrCoverage = await coverage(
    redis,
    "ctr-invariants",
    null,
    currentStart,
    previousStart,
    nowMs,
    hours,
  );
  return { trafficCoverage, sessionCoverage, ctrCoverage };
}

type StatisticsReportCoverage = Awaited<
  ReturnType<typeof readStatisticsCoverage>
>;

async function readStatisticsSessions(
  redis: RedisClient,
  { currentHours, previousHours }: StatisticsWindows,
) {
  const sessionPair = async (kind: SessionKind) => {
    const [current, previous] = await Promise.all([
      hourlyEstimateSum(redis, currentHours, (hour) => sessionKey(kind, hour)),
      hourlyEstimateSum(redis, previousHours, (hour) => sessionKey(kind, hour)),
    ]);
    return [current, previous] as const;
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
  return {
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
  };
}

type StatisticsSessions = Awaited<ReturnType<typeof readStatisticsSessions>>;

function countStatisticsClicks({
  currentRows,
  previousRows,
}: StatisticsTraffic) {
  const sumPeriod = (field: string) =>
    [sumField(currentRows, field), sumField(previousRows, field)] as const;
  return {
    joinClicks: sumPeriod("join_clicks"),
    joinConfirmations: sumPeriod("join_confirmed"),
    secondaryCtaClicks: sumPeriod("secondary_cta_clicks"),
    ctaOnlyClicks: sumPeriod("cta_only_clicks"),
    ctaClicks: sumPeriod("cta_clicks"),
  };
}

type StatisticsClickCounts = ReturnType<typeof countStatisticsClicks>;

async function readStatisticsCtaLabels(
  redis: RedisClient,
  { currentHours, previousHours }: StatisticsWindows,
  { currentRows, previousRows }: StatisticsTraffic,
  sessionCoverage: StatisticsCoverage,
): Promise<StatisticsResponse["metrics"]["ctas"]["byLabel"]> {
  const labels = new Map<string, string>();
  for (const row of [...currentRows, ...previousRows])
    for (const [field, value] of Object.entries(row))
      if (field.startsWith("cta_label:")) labels.set(field.slice(10), value);
  return Promise.all(
    [...labels.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(async ([id, label]) => {
        const [current, previous] = await Promise.all([
          hourlyEstimateSum(redis, currentHours, (hour) =>
            ctaSessionKey(id, hour),
          ),
          hourlyEstimateSum(redis, previousHours, (hour) =>
            ctaSessionKey(id, hour),
          ),
        ]);
        return {
          label,
          clicks: comparable(
            sumField(currentRows, `secondary_cta_click:${id}`),
            sumField(previousRows, `secondary_cta_click:${id}`),
            sessionCoverage,
          ),
          uniqueSessions: comparable(current, previous, sessionCoverage),
        };
      }),
  );
}

function buildTrafficAndMembershipMetrics(
  {
    currentRows,
    previousRows,
    currentCohorts,
    previousCohorts,
  }: StatisticsTraffic,
  { sessions, subscribed, joinEligible }: StatisticsSessions,
  { trafficCoverage, sessionCoverage }: StatisticsReportCoverage,
): Pick<StatisticsResponse["metrics"], "traffic" | "visitors" | "membership"> {
  return {
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
  };
}

function buildJoinAndCtaMetrics(
  {
    joinClicks,
    joinConfirmations,
    secondaryCtaClicks,
    ctaOnlyClicks,
  }: StatisticsClickCounts,
  {
    joinSessions,
    joinEligible,
    secondarySessions,
    secondaryEligible,
    ctaOnlySessions,
    ctaOnlyEligible,
  }: StatisticsSessions,
  { sessionCoverage, ctrCoverage }: StatisticsReportCoverage,
  byLabel: StatisticsResponse["metrics"]["ctas"]["byLabel"],
): Pick<StatisticsResponse["metrics"], "joins" | "ctas" | "ctaOnly"> {
  return {
    joins: {
      clicks: comparable(...joinClicks, sessionCoverage),
      uniqueClickSessions: comparable(
        joinSessions[0],
        joinSessions[1],
        sessionCoverage,
      ),
      confirmed: comparable(...joinConfirmations, sessionCoverage),
      clickSuccessRate: comparable(
        rate(joinConfirmations[0], joinClicks[0]),
        rate(joinConfirmations[1], joinClicks[1]),
        sessionCoverage,
      ),
      ctr: comparable(
        rate(joinSessions[0], joinEligible[0]),
        rate(joinSessions[1], joinEligible[1]),
        ctrCoverage,
      ),
    },
    ctas: {
      clicks: comparable(...secondaryCtaClicks, sessionCoverage),
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
        ctrCoverage,
      ),
      byLabel,
    },
    ctaOnly: {
      clicks: comparable(...ctaOnlyClicks, sessionCoverage),
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
        ctrCoverage,
      ),
    },
  };
}

function buildInteractionAndLegacyMetrics(
  { secondaryCtaClicks, ctaOnlyClicks, ctaClicks }: StatisticsClickCounts,
  { interactions, interactionEligible }: StatisticsSessions,
  { sessionCoverage, ctrCoverage, trafficCoverage }: StatisticsReportCoverage,
): Pick<StatisticsResponse["metrics"], "interactions" | "legacy"> {
  return {
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
        ctrCoverage,
      ),
    },
    legacy: {
      unclassifiedCtaClicks: comparable(
        Math.max(0, ctaClicks[0] - secondaryCtaClicks[0] - ctaOnlyClicks[0]),
        Math.max(0, ctaClicks[1] - secondaryCtaClicks[1] - ctaOnlyClicks[1]),
        trafficCoverage,
      ),
    },
  };
}
