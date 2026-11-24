import { type ServerAppSettings } from "../settings";
import {
  getCrosspostPendingByRevisionKey,
  getCrosspostPendingByTimeKey,
  processedRevisionsByTimeKey,
  processedRevisionsKey,
  removeProcessedRevisions,
} from "../data/crosspostData";
import { type LinkId, type RedisClient } from "../types";
import {
  updateCrosspostMappings,
  writeCrosspostMapping,
} from "../data/crosspostMappings";
import { cleanupCrosspostMappings } from "./mappingCleanup";

export const crosspostBookkeepingCleanupLastRunKey =
  "crosspostBookkeepingCleanupLastRun";
const processedRevisionRetentionMs = 30 * 24 * 60 * 60 * 1000;
const processedRevisionMaxEntries = 10_000;
const crosspostCleanupMinIntervalMs = 6 * 60 * 60 * 1000;

export const crosspostHourlyCreationHistoryKeyPrefix =
  "crosspostHourlyCreationHistory";
const crosspostHourlyWindowMs = 60 * 60 * 1000;
const crosspostSourceCreateCooldownKeyPrefix = "crosspostSourceCreateCooldown";
const crosspostSourceCreateCooldownTtlMs = 60 * 60 * 1000;
const crosspostTerminalRevisionKeyPrefix = "crosspostTerminalRevision";
const crosspostTerminalRevisionTtlMs = 30 * 24 * 60 * 60 * 1000;
const crosspostUnexpectedRevisionLogKeyPrefix =
  "crosspostUnexpectedRevisionLog";
const crosspostUnexpectedRevisionLogTtlMs = 24 * 60 * 60 * 1000;
const crosspostCreateInFlightKeyPrefix = "crosspostCreateInFlight";
export const crosspostCreateInFlightTtlMs = 90 * 1000;

type CrosspostBookkeepingCleanupOptions = {
  retentionMs?: number;
  maxEntries?: number;
  minIntervalMs?: number;
  nowMs?: number;
};

export const toNormalizedSubredditName = (value: string): string =>
  value.trim().replace(/^r\//i, "").toLowerCase();

export const getCrosspostAuthoritySubreddit = (
  appSettings: ServerAppSettings,
): string =>
  toNormalizedSubredditName(
    appSettings.crosspostAuthoritySubreddit || appSettings.promoSubreddit,
  );

export const isCrosspostAuthorityInstall = (
  appSettings: ServerAppSettings,
  subredditName: string,
): boolean =>
  toNormalizedSubredditName(subredditName) ===
  getCrosspostAuthoritySubreddit(appSettings);

export async function finalizeCrosspostPersistenceAtomic(params: {
  redisClient: RedisClient;
  targetSubreddit: string;
  sourcePostId: LinkId;
  crosspostId: LinkId;
  revisionId: string;
}): Promise<void> {
  const {
    redisClient,
    targetSubreddit,
    sourcePostId,
    crosspostId,
    revisionId,
  } = params;
  const pendingRevisionKey = getCrosspostPendingByRevisionKey(targetSubreddit);
  const pendingTimeKey = getCrosspostPendingByTimeKey(targetSubreddit);
  const terminalKey = getTerminalRevisionKey(revisionId);

  const now = Date.now();
  await updateCrosspostMappings(
    redisClient,
    () => async (tx) => {
      await tx.set(terminalKey, "1", {
        expiration: new Date(now + crosspostTerminalRevisionTtlMs),
      });
      await writeCrosspostMapping(tx, sourcePostId, crosspostId, now);
      await tx.hDel(pendingRevisionKey, [revisionId]);
      await tx.zRem(pendingTimeKey, [revisionId]);
    },
    [terminalKey, pendingRevisionKey, pendingTimeKey],
  );
}

const getSourceCreateCooldownKey = (sourcePostId: LinkId): string =>
  `${crosspostSourceCreateCooldownKeyPrefix}:${sourcePostId}`;

export async function hasSourceCreateCooldown(
  redisClient: Pick<RedisClient, "get">,
  sourcePostId: LinkId,
): Promise<boolean> {
  const value = await redisClient.get(getSourceCreateCooldownKey(sourcePostId));
  return value === "1";
}

export async function setSourceCreateCooldown(
  redisClient: Pick<RedisClient, "set">,
  sourcePostId: LinkId,
): Promise<void> {
  await redisClient.set(getSourceCreateCooldownKey(sourcePostId), "1", {
    expiration: new Date(Date.now() + crosspostSourceCreateCooldownTtlMs),
  });
}

const getTerminalRevisionKey = (revisionId: string): string =>
  `${crosspostTerminalRevisionKeyPrefix}:${revisionId}`;

const getUnexpectedRevisionLogKey = (
  revisionId: string,
  category: string,
): string =>
  `${crosspostUnexpectedRevisionLogKeyPrefix}:${category}:${revisionId}`;

export async function shouldLogUnexpectedRevision(
  redisClient: Pick<RedisClient, "get" | "set">,
  revisionId: string,
  category: string,
): Promise<boolean> {
  const key = getUnexpectedRevisionLogKey(revisionId, category);
  const existing = await redisClient.get(key);
  if (existing === "1") {
    return false;
  }
  await redisClient.set(key, "1", {
    nx: true,
    expiration: new Date(Date.now() + crosspostUnexpectedRevisionLogTtlMs),
  });
  return (await redisClient.get(key)) === "1";
}

export async function isTerminalRevisionMarked(
  redisClient: Pick<RedisClient, "get">,
  revisionId: string,
): Promise<boolean> {
  const value = await redisClient.get(getTerminalRevisionKey(revisionId));
  return value === "1";
}

export const getCrosspostCreateInFlightKey = (sourcePostId: LinkId): string =>
  `${crosspostCreateInFlightKeyPrefix}:${sourcePostId}`;

export async function isSourceCreateInFlight(
  redisClient: Pick<RedisClient, "get">,
  sourcePostId: LinkId,
): Promise<boolean> {
  return Boolean(
    await redisClient.get(getCrosspostCreateInFlightKey(sourcePostId)),
  );
}

export async function getCurrentHourlyCrosspostCount(
  redisClient: Pick<RedisClient, "zRange" | "zRem">,
  historyKey: string,
  nowMs: number,
): Promise<number> {
  const entries = await redisClient.zRange(historyKey, 0, -1);
  const cutoffMs = nowMs - crosspostHourlyWindowMs;
  const staleMembers = entries
    .filter((entry) => Number(entry.score) < cutoffMs)
    .map((entry) => entry.member);
  if (staleMembers.length > 0) {
    await redisClient.zRem(historyKey, staleMembers);
  }
  return entries.length - staleMembers.length;
}

export async function recordCrosspostCreation(
  redisClient: Pick<RedisClient, "zAdd">,
  historyKey: string,
  revisionId: string,
  nowMs: number,
): Promise<void> {
  const member = `${nowMs}:${revisionId}:${Math.random().toString(36).slice(2)}`;
  await redisClient.zAdd(historyKey, { member, score: nowMs });
}

export async function cleanupCrosspostBookkeeping(
  redisClient: RedisClient,
  options: CrosspostBookkeepingCleanupOptions = {},
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const retentionMs = options.retentionMs ?? processedRevisionRetentionMs;
  const maxEntries = options.maxEntries ?? processedRevisionMaxEntries;
  const minIntervalMs = options.minIntervalMs ?? crosspostCleanupMinIntervalMs;
  const cutoffMs = nowMs - retentionMs;

  const lastRunRaw = await redisClient.get(
    crosspostBookkeepingCleanupLastRunKey,
  );
  const lastRunMs = lastRunRaw ? Number.parseInt(lastRunRaw, 10) : 0;
  if (
    !Number.isNaN(lastRunMs) &&
    lastRunMs > 0 &&
    nowMs - lastRunMs < minIntervalMs
  ) {
    await cleanupCrosspostMappings(redisClient, nowMs, false);
    return;
  }
  await cleanProcessedRevisionIndex(redisClient, nowMs, cutoffMs, maxEntries);
  await cleanupCrosspostMappings(redisClient, nowMs, true);
  await redisClient.set(
    crosspostBookkeepingCleanupLastRunKey,
    nowMs.toString(),
  );
}

async function cleanProcessedRevisionIndex(
  redisClient: RedisClient,
  nowMs: number,
  cutoffMs: number,
  maxEntries: number,
): Promise<void> {
  const revisionIndexEntries = await redisClient.zRange(
    processedRevisionsByTimeKey,
    0,
    -1,
  );
  const indexedRevisions = revisionIndexEntries
    .map((entry) => ({ member: entry.member, score: Number(entry.score) }))
    .filter((entry) => entry.member && !Number.isNaN(entry.score))
    .sort((a, b) => a.score - b.score);
  const processedRevisionHash = await redisClient.hGetAll(
    processedRevisionsKey,
  );
  const hashRevisionIds = new Set(Object.keys(processedRevisionHash));
  const indexedRevisionIds = new Set(
    indexedRevisions.map((entry) => entry.member),
  );
  const processedRevisionIdsToRemove = new Set<string>();
  const processedRevisionIdsToIndex: string[] = [];

  for (const indexedRevisionId of indexedRevisionIds) {
    if (!hashRevisionIds.has(indexedRevisionId)) {
      processedRevisionIdsToRemove.add(indexedRevisionId);
    }
  }

  for (const hashRevisionId of hashRevisionIds) {
    if (!indexedRevisionIds.has(hashRevisionId)) {
      processedRevisionIdsToIndex.push(hashRevisionId);
    }
  }

  if (processedRevisionIdsToIndex.length > 0) {
    const toIndex = processedRevisionIdsToIndex.map((revisionId) => ({
      member: revisionId,
      score: nowMs,
    }));
    await redisClient.zAdd(processedRevisionsByTimeKey, ...toIndex);
  }

  const effectiveIndexedRevisions = [
    ...indexedRevisions.filter(
      (entry) => !processedRevisionIdsToRemove.has(entry.member),
    ),
    ...processedRevisionIdsToIndex.map((revisionId) => ({
      member: revisionId,
      score: nowMs,
    })),
  ].sort((a, b) => a.score - b.score);

  for (const entry of effectiveIndexedRevisions) {
    if (entry.score < cutoffMs) {
      processedRevisionIdsToRemove.add(entry.member);
    }
  }

  const retainedIndexedRevisions = effectiveIndexedRevisions.filter(
    (entry) => !processedRevisionIdsToRemove.has(entry.member),
  );
  const excessCount = retainedIndexedRevisions.length - maxEntries;
  if (excessCount > 0) {
    for (let i = 0; i < excessCount; i += 1) {
      const entry = retainedIndexedRevisions[i];
      if (entry) {
        processedRevisionIdsToRemove.add(entry.member);
      }
    }
  }

  if (processedRevisionIdsToRemove.size > 0) {
    await removeProcessedRevisions(redisClient, [
      ...processedRevisionIdsToRemove,
    ]);
  }
}
