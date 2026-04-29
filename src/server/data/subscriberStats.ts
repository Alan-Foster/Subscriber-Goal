import type { RedisClient } from '../types';
import type { BasicUserData } from './basicData';
import { postRecentSubscriberSuffix, subscriberGoalsKey } from './subGoalData';

export const subscriberStatsKey = 'subscriber_stats';
export const subscriberStatsByUserIdKey = 'subscriber_stats_by_user_id';
export const subscriberStatsMigrationStateKey = 'subscriber_stats_migration_state';
export const subscriberStatsMigrationVersion = 'user_id_hash_v1';

const migrationBatchSize = 25;
const migrationCooldownMinMs = 5 * 60 * 1000;
const migrationCooldownMaxMs = 15 * 60 * 1000;

export type SubscriberStats = {
  id: string;
  username: string;
  timestamp: number;
  subscribers: number;
};

export function isSubscriberStats(object: unknown): object is SubscriberStats {
  if (!object || typeof object !== 'object') {
    return false;
  }
  const subStats = object as SubscriberStats;
  return (
    typeof subStats.id === 'string' &&
    typeof subStats.username === 'string' &&
    typeof subStats.timestamp === 'number' &&
    typeof subStats.subscribers === 'number'
  );
}

const getMatchingSubscribers = async (
  redis: RedisClient,
  match: (member: string) => boolean
) => {
  const allSubscribers = await redis.zRange(subscriberStatsKey, 0, -1);
  return allSubscribers.filter((record) => match(record.member));
};

type ParsedSubscriberMember = {
  id: string;
  username: string;
  subscribers: number;
  timestamp?: number;
};

const parseSubscriberMember = (member: string): ParsedSubscriberMember | undefined => {
  const [id, username, subscribers, timestamp] = member.split(':');
  if (!id || !username || !subscribers) {
    return undefined;
  }
  const parsedSubscribers = parseInt(subscribers, 10);
  if (Number.isNaN(parsedSubscribers)) {
    return undefined;
  }
  return {
    id,
    username,
    subscribers: parsedSubscribers,
    ...(timestamp && !Number.isNaN(parseInt(timestamp, 10))
      ? { timestamp: parseInt(timestamp, 10) }
      : {}),
  };
};

const serializeSubscriberStats = (subStats: SubscriberStats): string =>
  `${subStats.id}:${subStats.username}:${subStats.subscribers}:${subStats.timestamp}`;

export async function getSubscriberStats(
  redis: RedisClient,
  userId: string
): Promise<SubscriberStats | undefined> {
  const indexedMember = await redis.hGet(subscriberStatsByUserIdKey, userId);
  if (indexedMember) {
    const parsed = parseSubscriberMember(indexedMember);
    if (parsed) {
      return {
        id: parsed.id,
        username: parsed.username,
        timestamp: parsed.timestamp ?? Date.now(),
        subscribers: parsed.subscribers,
      };
    }
    console.error(
      'Found malformed indexed subscriber stats record: ',
      JSON.stringify(indexedMember)
    );
  }
}

export async function isTrackedSubscriber(
  redis: RedisClient,
  userId: string
): Promise<boolean> {
  const subscriberStats = await getSubscriberStats(redis, userId);
  return subscriberStats !== undefined;
}

export async function setNewSubscriber(
  redis: RedisClient,
  postId: string,
  currentSubscribers: number,
  user: BasicUserData,
  shareUsername: boolean
): Promise<boolean> {
  const alreadySubscribed = await isTrackedSubscriber(redis, user.id);
  if (alreadySubscribed) {
    return false;
  }

  const now = Date.now();
  const indexed = await redis.hSetNX(
    subscriberStatsByUserIdKey,
    user.id,
    serializeSubscriberStats({
      id: user.id,
      username: user.username,
      subscribers: currentSubscribers,
      timestamp: now,
    })
  );
  if (indexed === 0) {
    return false;
  }

  await redis.hSet(subscriberGoalsKey, {
    [`${postId}${postRecentSubscriberSuffix}`]: shareUsername ? user.username : '',
  });
  await redis.zAdd(subscriberStatsKey, {
    member: `${user.id}:${user.username}:${currentSubscribers}`,
    score: now,
  });
  return true;
}

type SubscriberStatsMigrationStatus = 'pending' | 'running' | 'complete';

type SubscriberStatsMigrationState = {
  version: string;
  status: SubscriberStatsMigrationStatus;
  cursor: number;
  nextRunAt: number;
  scannedTotal: number;
  migratedTotal: number;
  skippedMalformedTotal: number;
  skippedExistingTotal: number;
  lastRunAt: number;
};

type SubscriberStatsMigrationOptions = {
  nowMs?: number;
  batchSize?: number;
  cooldownMinMs?: number;
  cooldownMaxMs?: number;
};

const parseMigrationNumber = (
  value: string | undefined,
  fallback: number
): number => {
  if (value === undefined) {
    return fallback;
  }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const parseMigrationState = (
  raw: Record<string, string>
): SubscriberStatsMigrationState | undefined => {
  if (raw.version !== subscriberStatsMigrationVersion) {
    return;
  }
  const status =
    raw.status === 'pending' ||
    raw.status === 'running' ||
    raw.status === 'complete'
      ? raw.status
      : 'pending';
  return {
    version: raw.version,
    status,
    cursor: parseMigrationNumber(raw.cursor, 0),
    nextRunAt: parseMigrationNumber(raw.nextRunAt, 0),
    scannedTotal: parseMigrationNumber(raw.scannedTotal, 0),
    migratedTotal: parseMigrationNumber(raw.migratedTotal, 0),
    skippedMalformedTotal: parseMigrationNumber(raw.skippedMalformedTotal, 0),
    skippedExistingTotal: parseMigrationNumber(raw.skippedExistingTotal, 0),
    lastRunAt: parseMigrationNumber(raw.lastRunAt, 0),
  };
};

const serializeMigrationState = (
  state: SubscriberStatsMigrationState
): Record<string, string> => ({
  version: state.version,
  status: state.status,
  cursor: String(state.cursor),
  nextRunAt: String(state.nextRunAt),
  scannedTotal: String(state.scannedTotal),
  migratedTotal: String(state.migratedTotal),
  skippedMalformedTotal: String(state.skippedMalformedTotal),
  skippedExistingTotal: String(state.skippedExistingTotal),
  lastRunAt: String(state.lastRunAt),
});

const getRandomDelay = (minMs: number, maxMs: number): number => {
  if (maxMs <= minMs) {
    return minMs;
  }
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
};

export async function initializeSubscriberStatsMigration(
  redis: RedisClient,
  options: SubscriberStatsMigrationOptions = {}
): Promise<void> {
  const raw = await redis.hGetAll(subscriberStatsMigrationStateKey);
  const existing = parseMigrationState(raw);
  if (existing) {
    return;
  }

  const nowMs = options.nowMs ?? Date.now();
  const cooldownMinMs = options.cooldownMinMs ?? migrationCooldownMinMs;
  const cooldownMaxMs = options.cooldownMaxMs ?? migrationCooldownMaxMs;
  const state: SubscriberStatsMigrationState = {
    version: subscriberStatsMigrationVersion,
    status: 'pending',
    cursor: 0,
    nextRunAt: nowMs + getRandomDelay(cooldownMinMs, cooldownMaxMs),
    scannedTotal: 0,
    migratedTotal: 0,
    skippedMalformedTotal: 0,
    skippedExistingTotal: 0,
    lastRunAt: 0,
  };

  await redis.hSet(
    subscriberStatsMigrationStateKey,
    serializeMigrationState(state)
  );
  console.info(
    `[subscriberStatsMigration] initialized: status=${state.status} nextRunAt=${state.nextRunAt} version=${state.version}`
  );
}

export async function processSubscriberStatsMigrationBatch(
  redis: RedisClient,
  options: SubscriberStatsMigrationOptions = {}
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const batchSize = Math.max(1, options.batchSize ?? migrationBatchSize);
  const cooldownMinMs = options.cooldownMinMs ?? migrationCooldownMinMs;
  const cooldownMaxMs = options.cooldownMaxMs ?? migrationCooldownMaxMs;

  const raw = await redis.hGetAll(subscriberStatsMigrationStateKey);
  let state = parseMigrationState(raw);
  if (!state) {
    await initializeSubscriberStatsMigration(redis, {
      nowMs,
      cooldownMinMs,
      cooldownMaxMs,
    });
    state = parseMigrationState(
      await redis.hGetAll(subscriberStatsMigrationStateKey)
    );
  }
  if (!state || state.status === 'complete' || nowMs < state.nextRunAt) {
    return;
  }

  const oldTotal = await redis.zCard(subscriberStatsKey);
  const newTotalBefore = await redis.hLen(subscriberStatsByUserIdKey);
  console.info(
    `[subscriberStatsMigration] starting batch: oldTotal=${oldTotal} newTotal=${newTotalBefore} cursor=${state.cursor} status=${state.status}`
  );

  const result = await redis.zScan(
    subscriberStatsKey,
    state.cursor,
    undefined,
    batchSize
  );
  let migratedThisRun = 0;
  let skippedMalformed = 0;
  let skippedExisting = 0;

  for (const record of result.members) {
    const parsed = parseSubscriberMember(record.member);
    if (!parsed) {
      skippedMalformed += 1;
      continue;
    }

    const stored = await redis.hSetNX(
      subscriberStatsByUserIdKey,
      parsed.id,
      serializeSubscriberStats({
        id: parsed.id,
        username: parsed.username,
        subscribers: parsed.subscribers,
        timestamp: parsed.timestamp ?? record.score,
      })
    );
    if (stored === 1) {
      migratedThisRun += 1;
    } else {
      skippedExisting += 1;
    }
  }

  const scannedThisRun = result.members.length;
  const status: SubscriberStatsMigrationStatus =
    result.cursor === 0 ? 'complete' : 'running';
  const nextState: SubscriberStatsMigrationState = {
    ...state,
    status,
    cursor: result.cursor,
    nextRunAt:
      status === 'complete'
        ? nowMs
        : nowMs + getRandomDelay(cooldownMinMs, cooldownMaxMs),
    scannedTotal: state.scannedTotal + scannedThisRun,
    migratedTotal: state.migratedTotal + migratedThisRun,
    skippedMalformedTotal: state.skippedMalformedTotal + skippedMalformed,
    skippedExistingTotal: state.skippedExistingTotal + skippedExisting,
    lastRunAt: nowMs,
  };
  await redis.hSet(
    subscriberStatsMigrationStateKey,
    serializeMigrationState(nextState)
  );

  const newTotal = await redis.hLen(subscriberStatsByUserIdKey);
  const estimatedRemaining = Math.max(oldTotal - nextState.scannedTotal, 0);
  console.info(
    `[subscriberStatsMigration] batch complete: scanned=${scannedThisRun} migrated=${migratedThisRun} skippedMalformed=${skippedMalformed} skippedExisting=${skippedExisting} scannedTotal=${nextState.scannedTotal} oldTotal=${oldTotal} newTotal=${newTotal} estimatedRemaining=${estimatedRemaining} cursor=${nextState.cursor} status=${nextState.status}`
  );

  if (nextState.status === 'complete') {
    console.info(
      `[subscriberStatsMigration] complete: scanned=${nextState.scannedTotal} migrated=${nextState.migratedTotal} skippedMalformed=${nextState.skippedMalformedTotal} skippedExisting=${nextState.skippedExistingTotal} oldTotal=${oldTotal} newTotal=${newTotal}`
    );
  }
}

export async function untrackSubscriberById(
  redis: RedisClient,
  userId: string
): Promise<void> {
  await redis.hDel(subscriberStatsByUserIdKey, [userId]);
  const foundRecords = await getMatchingSubscribers(redis, (member) =>
    member.startsWith(`${userId}:`)
  );

  if (foundRecords.length > 0) {
    await redis.zRem(
      subscriberStatsKey,
      foundRecords.map((record) => record.member)
    );
  }
}

export async function untrackSubscriberByUsername(
  redis: RedisClient,
  username: string
): Promise<void> {
  const matchToken = `:${username}:`;
  const foundRecords = await getMatchingSubscribers(redis, (member) =>
    member.includes(matchToken)
  );

  if (foundRecords.length > 0) {
    const userIds = foundRecords
      .map((record) => parseSubscriberMember(record.member)?.id)
      .filter((id): id is string => Boolean(id));
    if (userIds.length > 0) {
      await redis.hDel(subscriberStatsByUserIdKey, userIds);
    }
    await redis.zRem(
      subscriberStatsKey,
      foundRecords.map((record) => record.member)
    );
  }
}
