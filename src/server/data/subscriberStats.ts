import type { RedisClient } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";
import {
  eraseFromRecentSubscribers,
  findRecentSubscriberUserIdsByUsername,
} from "./subGoalData";
import { invalidateSubscriberTracking } from "./subscriberTracking";
import {
  subscriberStatsKey,
  subscriberStatsByUserIdKey,
  subscriberStatusByUserIdKey,
  subscriberStatsUsernameToUserIdKey,
  subscriberStatsLegacyMembersByUserIdKey,
} from "./subscriberStatsKeys";

export {
  subscriberStatsKey,
  subscriberStatsByUserIdKey,
  subscriberStatusByUserIdKey,
  subscriberStatsUsernameToUserIdKey,
  subscriberStatsLegacyMembersByUserIdKey,
} from "./subscriberStatsKeys";

export const subscriberStatsErasedUserIdsKey =
  "subscriber_stats_erased_user_ids";
export type SubscriberStats = {
  id: string;
  username: string;
  timestamp: number;
  subscribers: number;
};

type ParsedSubscriberMember = {
  id: string;
  username: string;
  subscribers: number;
  timestamp?: number;
};

const parseSubscriberMember = (
  member: string,
): ParsedSubscriberMember | undefined => {
  const [id, username, subscribers, timestamp] = member.split(":");
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

const serializeLegacySubscriberMember = (subStats: SubscriberStats): string =>
  `${subStats.id}:${subStats.username}:${subStats.subscribers}`;

const normalizeUsername = (username: string): string =>
  username.trim().toLowerCase();

const parseStringList = (raw: string | undefined): string[] => {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logDiagnostic("warn", "persisted_json_invalid", {
        workflow: "subscriber_stats",
        phase: "legacy_index_schema",
      });
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch (error) {
    logDiagnostic(
      "warn",
      "persisted_json_invalid",
      { workflow: "subscriber_stats", phase: "legacy_index_decode" },
      error,
    );
    return [];
  }
};

const deleteSubscriberIndexes = async (
  redis: RedisClient,
  userId: string,
  usernames: string[],
): Promise<void> => {
  await redis.hDel(subscriberStatsByUserIdKey, [userId]);
  await redis.hDel(subscriberStatusByUserIdKey, [userId]);
  await redis.hDel(subscriberStatsLegacyMembersByUserIdKey, [userId]);
  const normalizedUsernames = [
    ...new Set(
      usernames
        .map((username) => normalizeUsername(username))
        .filter((username) => username.length > 0),
    ),
  ];
  if (normalizedUsernames.length > 0) {
    await redis.hDel(subscriberStatsUsernameToUserIdKey, [
      ...normalizedUsernames,
    ]);
  }
};

export type SubscriberErasureResult = {
  status: "complete" | "partial";
  userIds: string[];
};

export async function getSubscriberStats(
  redis: RedisClient,
  userId: string,
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
    logDiagnostic("warn", "persisted_json_invalid", {
      workflow: "subscriber_stats",
      phase: "indexed_record_schema",
    });
  }
}

export async function isTrackedSubscriber(
  redis: RedisClient,
  userId: string,
): Promise<boolean> {
  const status = await redis.hGet(subscriberStatusByUserIdKey, userId);
  if (status === "1") {
    return true;
  }
  const subscriberStats = await getSubscriberStats(redis, userId);
  return subscriberStats !== undefined;
}

export async function untrackSubscriberById(
  redis: RedisClient,
  userId: string,
  knownUsername?: string,
): Promise<SubscriberErasureResult> {
  // Every caller, including local username recovery, must fence stale work
  // before deleting any of the evidence needed to retry an erasure.
  await invalidateSubscriberTracking(redis, userId);
  const indexedRecord = await redis.hGet(subscriberStatsByUserIdKey, userId);
  const parsed = indexedRecord
    ? parseSubscriberMember(indexedRecord)
    : undefined;

  const legacyMembers = parseStringList(
    await redis.hGet(subscriberStatsLegacyMembersByUserIdKey, userId),
  );
  let cursor = 0;
  do {
    const result = await redis.zScan(
      subscriberStatsKey,
      cursor,
      undefined,
      100,
    );
    cursor = result.cursor;
    legacyMembers.push(
      ...result.members
        .filter((member) => parseSubscriberMember(member.member)?.id === userId)
        .map((member) => member.member),
    );
  } while (cursor !== 0);

  if (parsed) {
    legacyMembers.push(
      serializeLegacySubscriberMember({
        id: parsed.id,
        username: parsed.username,
        subscribers: parsed.subscribers,
        timestamp: parsed.timestamp ?? Date.now(),
      }),
    );
  }
  const uniqueLegacyMembers = [...new Set(legacyMembers)];
  if (uniqueLegacyMembers.length > 0) {
    await redis.zRem(subscriberStatsKey, uniqueLegacyMembers);
  }
  const usernamesToDelete = [
    ...(parsed ? [parsed.username] : []),
    ...(knownUsername ? [knownUsername] : []),
    ...uniqueLegacyMembers
      .map((member) => parseSubscriberMember(member)?.username)
      .filter((username): username is string => Boolean(username)),
  ];
  for (const username of usernamesToDelete) {
    await eraseFromRecentSubscribers(redis, username, userId);
  }
  await deleteSubscriberIndexes(redis, userId, usernamesToDelete);
  await redis.hDel(subscriberStatsErasedUserIdsKey, [userId]);
  return { status: "complete", userIds: [userId] };
}

export async function untrackSubscriberByUsername(
  redis: RedisClient,
  username: string,
): Promise<SubscriberErasureResult> {
  const normalized = normalizeUsername(username);
  const userId = await redis.hGet(
    subscriberStatsUsernameToUserIdKey,
    normalized,
  );
  if (userId) {
    return await untrackSubscriberById(redis, userId, username);
  }

  const matchingUserIds = new Set<string>(
    await findRecentSubscriberUserIdsByUsername(redis, username),
  );
  let hashCursor = 0;
  do {
    const page = await redis.hScan(
      subscriberStatsByUserIdKey,
      hashCursor,
      undefined,
      100,
    );
    hashCursor = page.cursor;
    for (const { field, value } of page.fieldValues) {
      if (parseSubscriberMember(value)?.username.toLowerCase() === normalized) {
        matchingUserIds.add(field);
      }
    }
  } while (hashCursor !== 0);

  let legacyCursor = 0;
  do {
    const page = await redis.zScan(
      subscriberStatsKey,
      legacyCursor,
      undefined,
      100,
    );
    legacyCursor = page.cursor;
    for (const { member } of page.members) {
      const parsed = parseSubscriberMember(member);
      if (parsed?.username.toLowerCase() === normalized) {
        matchingUserIds.add(parsed.id);
      }
    }
  } while (legacyCursor !== 0);

  if (matchingUserIds.size === 0) {
    return { status: "partial", userIds: [] };
  }
  for (const matchingUserId of matchingUserIds) {
    await untrackSubscriberById(redis, matchingUserId, username);
  }
  return { status: "complete", userIds: [...matchingUserIds] };
}
