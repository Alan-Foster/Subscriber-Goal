import type { RedisClient } from "../types";
import {
  postRecentSubscriberSuffix,
  recentSubscriberPostsByUsernameKey,
  subscriberGoalsKey,
} from "./subGoalData";
import {
  subscriberStatsByUserIdKey,
  subscriberStatsKey,
  subscriberStatsLegacyMembersByUserIdKey,
  subscriberStatsUsernameToUserIdKey,
  subscriberStatusByUserIdKey,
} from "./subscriberStats";
import {
  serializeSubscriptionAcceptanceEvidence,
  subscriptionAcceptanceKey,
} from "./subscriptionAttempt";
import { retiredSubscriberGoalKeyPrefix } from "../core/postRetirement";
import { logDiagnostic } from "../../shared/diagnostics";
import {
  subscriberTrackingGenerationKey,
  subscriberTrackingPendingByOperationKey,
  subscriberTrackingPendingByUserKey,
  subscriberTrackingQueueKey,
  subscriberTrackingUsernameToUserIdKey,
} from "./subscriberTrackingKeys";
export {
  subscriberTrackingPendingByOperationKey,
  subscriberTrackingPendingByUserKey,
  subscriberTrackingQueueKey,
  subscriberTrackingUsernameToUserIdKey,
} from "./subscriberTrackingKeys";

export type PendingSubscriberTracking = {
  operationId: string;
  userId: string;
  postId: string;
  username: string;
  subscribers: number;
  timestamp: number;
  shareUsername: boolean;
  erasureGeneration: string;
  phase: "pending" | "complete";
  attempts: number;
};

const normalizeUsername = (value: string): string => value.trim().toLowerCase();
const encode = (operation: PendingSubscriberTracking): string =>
  JSON.stringify(operation);
const decode = (
  raw: string | undefined,
): PendingSubscriberTracking | undefined => {
  if (!raw) return;
  try {
    const value = JSON.parse(raw) as Partial<PendingSubscriberTracking>;
    if (
      typeof value.operationId === "string" &&
      typeof value.userId === "string" &&
      typeof value.postId === "string" &&
      typeof value.username === "string" &&
      typeof value.subscribers === "number" &&
      typeof value.timestamp === "number" &&
      typeof value.shareUsername === "boolean" &&
      typeof value.erasureGeneration === "string" &&
      (value.phase === "pending" || value.phase === "complete") &&
      typeof value.attempts === "number"
    ) {
      return value as PendingSubscriberTracking;
    }
  } catch (error) {
    logDiagnostic(
      "warn",
      "persisted_json_invalid",
      { workflow: "subscriber_tracking", phase: "pending_decode" },
      error,
    );
    // The malformed entry remains in the queue for operator-visible retry.
  }
};

const parseList = (raw: string | undefined): string[] => {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch (error) {
    logDiagnostic(
      "warn",
      "persisted_json_invalid",
      { workflow: "subscriber_tracking", phase: "index_decode" },
      error,
    );
    return [];
  }
};

export async function getSubscriberTrackingGeneration(
  redis: RedisClient,
  userId: string,
): Promise<string> {
  return (await redis.get(subscriberTrackingGenerationKey(userId))) ?? "";
}

export async function getPendingSubscriberTracking(
  redis: RedisClient,
  userId: string,
): Promise<PendingSubscriberTracking | undefined> {
  const operationId = await redis.hGet(
    subscriberTrackingPendingByUserKey,
    userId,
  );
  return operationId
    ? decode(
        await redis.hGet(subscriberTrackingPendingByOperationKey, operationId),
      )
    : undefined;
}

export async function persistAcceptedSubscriberTracking(
  redis: RedisClient,
  input: Omit<
    PendingSubscriberTracking,
    "phase" | "attempts" | "erasureGeneration"
  > & {
    erasureGeneration: string;
    attemptId?: string;
  },
): Promise<{ operation: PendingSubscriberTracking; created: boolean }> {
  const evidence = input.attemptId
    ? serializeSubscriptionAcceptanceEvidence(
        input.postId,
        input.userId,
        input.timestamp,
      )
    : undefined;
  const evidenceKey = input.attemptId
    ? subscriptionAcceptanceKey(input.attemptId)
    : undefined;

  for (let retry = 0; retry < 3; retry += 1) {
    const watched = [
      subscriberTrackingGenerationKey(input.userId),
      subscriberTrackingPendingByUserKey,
      subscriberTrackingPendingByOperationKey,
      subscriberTrackingQueueKey,
      ...(evidenceKey ? [evidenceKey] : []),
    ];
    const tx = await redis.watch(...watched);
    const currentGeneration =
      (await redis.get(subscriberTrackingGenerationKey(input.userId))) ?? "";
    if (currentGeneration !== input.erasureGeneration) {
      await tx.unwatch();
      throw new Error("subscriber_tracking_invalidated_by_erasure");
    }

    const currentOperationId = await redis.hGet(
      subscriberTrackingPendingByUserKey,
      input.userId,
    );
    const existing = currentOperationId
      ? decode(
          await redis.hGet(
            subscriberTrackingPendingByOperationKey,
            currentOperationId,
          ),
        )
      : undefined;
    const operation: PendingSubscriberTracking =
      existing?.erasureGeneration === currentGeneration
        ? existing
        : {
            operationId: input.operationId,
            userId: input.userId,
            postId: input.postId,
            username: input.username,
            subscribers: input.subscribers,
            timestamp: input.timestamp,
            shareUsername: input.shareUsername,
            erasureGeneration: input.erasureGeneration,
            phase: "pending",
            attempts: 0,
          };
    const created = operation.operationId === input.operationId;

    await tx.multi();
    if (created) {
      await tx.hSet(subscriberTrackingPendingByUserKey, {
        [input.userId]: operation.operationId,
      });
      await tx.hSet(subscriberTrackingPendingByOperationKey, {
        [operation.operationId]: encode(operation),
      });
      await tx.hSet(subscriberTrackingUsernameToUserIdKey, {
        [normalizeUsername(input.username)]: input.userId,
      });
      await tx.zAdd(subscriberTrackingQueueKey, {
        member: operation.operationId,
        score: input.timestamp,
      });
    } else {
      // Re-assert both halves of discoverability without changing the winner's
      // payload or due time. This also gives EXEC an observable command when
      // an overlapping request has no attempt evidence to add.
      await tx.hSet(subscriberTrackingPendingByOperationKey, {
        [operation.operationId]: encode(operation),
      });
      await tx.zAdd(subscriberTrackingQueueKey, {
        member: operation.operationId,
        score: operation.timestamp,
      });
    }
    if (evidenceKey && evidence) {
      await tx.set(evidenceKey, evidence.value, {
        expiration: new Date(evidence.expiresAt),
      });
    }
    const result = await tx.exec();
    if (result.length > 0) return { operation, created };
  }
  throw new Error("subscriber_tracking_persistence_conflict");
}

const legacyMember = (operation: PendingSubscriberTracking): string =>
  `${operation.userId}:${operation.username}:${operation.subscribers}`;
const indexedMember = (operation: PendingSubscriberTracking): string =>
  `${legacyMember(operation)}:${operation.timestamp}`;

export async function applySubscriberTracking(
  redis: RedisClient,
  operation: PendingSubscriberTracking,
): Promise<"applied" | "complete" | "obsolete" | "invalidated"> {
  if (operation.phase === "complete") return "complete";
  const generation = subscriberTrackingGenerationKey(operation.userId);
  const retiredKey = `${retiredSubscriberGoalKeyPrefix}:${operation.postId}`;
  const normalized = normalizeUsername(operation.username);
  const tx = await redis.watch(
    generation,
    subscriberTrackingPendingByUserKey,
    subscriberTrackingPendingByOperationKey,
    subscriberStatsByUserIdKey,
    subscriberStatsLegacyMembersByUserIdKey,
    recentSubscriberPostsByUsernameKey,
    retiredKey,
  );
  const [
    currentGeneration,
    currentOperationId,
    currentRaw,
    existingStats,
    retired,
  ] = await Promise.all([
    redis.get(generation),
    redis.hGet(subscriberTrackingPendingByUserKey, operation.userId),
    redis.hGet(subscriberTrackingPendingByOperationKey, operation.operationId),
    redis.hGet(subscriberStatsByUserIdKey, operation.userId),
    redis.get(retiredKey),
  ]);
  const current = decode(currentRaw);
  if (
    (currentGeneration ?? "") !== operation.erasureGeneration ||
    currentOperationId !== operation.operationId ||
    !current
  ) {
    await tx.unwatch();
    return "invalidated";
  }
  if (current.phase === "complete") {
    await tx.unwatch();
    return "complete";
  }
  if (existingStats && existingStats !== indexedMember(operation)) {
    const completed = { ...current, phase: "complete" as const };
    await tx.multi();
    await tx.hSet(subscriberTrackingPendingByOperationKey, {
      [operation.operationId]: encode(completed),
    });
    const result = await tx.exec();
    if (result.length === 0)
      throw new Error("subscriber_tracking_apply_conflict");
    return "obsolete";
  }

  const member = legacyMember(operation);
  const legacyMembers = [
    ...new Set([
      ...parseList(
        await redis.hGet(
          subscriberStatsLegacyMembersByUserIdKey,
          operation.userId,
        ),
      ),
      member,
    ]),
  ];
  const recentPosts = [
    ...new Set([
      ...parseList(
        await redis.hGet(recentSubscriberPostsByUsernameKey, normalized),
      ),
      operation.postId,
    ]),
  ];
  const completed = { ...current, phase: "complete" as const };
  await tx.multi();
  if (!existingStats) {
    await tx.hSet(subscriberStatsByUserIdKey, {
      [operation.userId]: indexedMember(operation),
    });
  }
  await tx.hSet(subscriberStatusByUserIdKey, { [operation.userId]: "1" });
  await tx.hSet(subscriberStatsUsernameToUserIdKey, {
    [normalized]: operation.userId,
  });
  await tx.hSet(subscriberStatsLegacyMembersByUserIdKey, {
    [operation.userId]: JSON.stringify(legacyMembers),
  });
  await tx.zAdd(subscriberStatsKey, {
    member,
    score: operation.timestamp,
  });
  if (!retired) {
    await tx.hSet(subscriberGoalsKey, {
      [`${operation.postId}${postRecentSubscriberSuffix}`]:
        operation.shareUsername ? operation.username : "",
    });
    if (operation.shareUsername) {
      await tx.hSet(recentSubscriberPostsByUsernameKey, {
        [normalized]: JSON.stringify(recentPosts),
      });
    }
  }
  await tx.hSet(subscriberTrackingPendingByOperationKey, {
    [operation.operationId]: encode(completed),
  });
  const result = await tx.exec();
  if (result.length === 0)
    throw new Error("subscriber_tracking_apply_conflict");
  return "applied";
}

export async function cleanupSubscriberTracking(
  redis: RedisClient,
  operation: PendingSubscriberTracking,
): Promise<boolean> {
  const tx = await redis.watch(
    subscriberTrackingPendingByUserKey,
    subscriberTrackingPendingByOperationKey,
    subscriberTrackingQueueKey,
  );
  const [currentOperationId, currentRaw] = await Promise.all([
    redis.hGet(subscriberTrackingPendingByUserKey, operation.userId),
    redis.hGet(subscriberTrackingPendingByOperationKey, operation.operationId),
  ]);
  const current = decode(currentRaw);
  if (
    currentOperationId !== operation.operationId ||
    current?.operationId !== operation.operationId ||
    current.phase !== "complete"
  ) {
    await tx.unwatch();
    return false;
  }
  await tx.multi();
  await tx.hDel(subscriberTrackingPendingByUserKey, [operation.userId]);
  await tx.hDel(subscriberTrackingPendingByOperationKey, [
    operation.operationId,
  ]);
  await tx.zRem(subscriberTrackingQueueKey, [operation.operationId]);
  const result = await tx.exec();
  return result.length > 0;
}

const retryDelay = (attempts: number): number =>
  attempts === 0
    ? 60_000
    : attempts === 1
      ? 5 * 60_000
      : attempts === 2
        ? 15 * 60_000
        : 60 * 60_000;

const subscriberTrackingRepairCursorKey =
  "subscriber_tracking_repair_cursor_v1";

export async function processSubscriberTrackingRepairs(
  redis: RedisClient,
  options: { nowMs?: number; batchSize?: number } = {},
): Promise<{ read: number; completed: number; failed: number }> {
  const nowMs = options.nowMs ?? Date.now();
  const batchSize = Math.max(1, options.batchSize ?? 25);
  const offset = parseInt(
    (await redis.get(subscriberTrackingRepairCursorKey)) ?? "0",
    10,
  );
  const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
  const entries = await redis.zRange(
    subscriberTrackingQueueKey,
    safeOffset,
    safeOffset + batchSize - 1,
  );
  if (entries.length === 0 && safeOffset > 0) {
    await redis.set(subscriberTrackingRepairCursorKey, "0");
  }
  let completed = 0;
  let failed = 0;
  let failedReschedule = false;
  for (const entry of entries) {
    if (entry.score > nowMs) continue;
    const operation = decode(
      await redis.hGet(subscriberTrackingPendingByOperationKey, entry.member),
    );
    if (!operation) {
      failed += 1;
      continue;
    }
    try {
      const result = await applySubscriberTracking(redis, operation);
      if (
        result === "applied" ||
        result === "complete" ||
        result === "obsolete"
      ) {
        const latest = decode(
          await redis.hGet(
            subscriberTrackingPendingByOperationKey,
            operation.operationId,
          ),
        ) ?? { ...operation, phase: "complete" as const };
        if (await cleanupSubscriberTracking(redis, latest)) completed += 1;
      } else if (result === "invalidated") {
        await redis.zRem(subscriberTrackingQueueKey, [operation.operationId]);
        completed += 1;
      }
    } catch (error) {
      failed += 1;
      logDiagnostic(
        "warn",
        "subscriber_tracking_repair_failed",
        {
          workflow: "subscriber_tracking_repair",
          phase: "apply_or_cleanup",
          operationId: operation.operationId,
        },
        error,
      );
      const latest =
        decode(
          await redis.hGet(
            subscriberTrackingPendingByOperationKey,
            operation.operationId,
          ),
        ) ?? operation;
      const next = { ...latest, attempts: latest.attempts + 1 };
      try {
        await redis.hSet(subscriberTrackingPendingByOperationKey, {
          [operation.operationId]: encode(next),
        });
        await redis.zAdd(subscriberTrackingQueueKey, {
          member: operation.operationId,
          score: nowMs + retryDelay(operation.attempts),
        });
      } catch (rescheduleError) {
        // The old due queue member remains discoverable if rescheduling fails.
        failedReschedule = true;
        logDiagnostic(
          "error",
          "subscriber_tracking_reschedule_failed",
          {
            workflow: "subscriber_tracking_repair",
            phase: "reschedule",
            operationId: operation.operationId,
          },
          rescheduleError,
        );
      }
    }
  }
  await redis.set(
    subscriberTrackingRepairCursorKey,
    failedReschedule && entries.length === batchSize
      ? String(safeOffset + entries.length)
      : "0",
  );
  return { read: entries.length, completed, failed };
}

export async function invalidateSubscriberTracking(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  const nextGeneration = crypto.randomUUID();
  await redis.set(subscriberTrackingGenerationKey(userId), nextGeneration);
  const operationId = await redis.hGet(
    subscriberTrackingPendingByUserKey,
    userId,
  );
  if (!operationId) return;
  const operation = decode(
    await redis.hGet(subscriberTrackingPendingByOperationKey, operationId),
  );
  await redis.hDel(subscriberTrackingPendingByUserKey, [userId]);
  await redis.hDel(subscriberTrackingPendingByOperationKey, [operationId]);
  await redis.zRem(subscriberTrackingQueueKey, [operationId]);
  if (operation) {
    await redis.hDel(subscriberTrackingUsernameToUserIdKey, [
      normalizeUsername(operation.username),
    ]);
  }
}

export async function findPendingSubscriberUserIdByUsername(
  redis: RedisClient,
  username: string,
): Promise<string | undefined> {
  return await redis.hGet(
    subscriberTrackingUsernameToUserIdKey,
    normalizeUsername(username),
  );
}
