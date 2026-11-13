import type { RedisClient } from "../types";
import {
  postRecentSubscriberOrderSuffix,
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
import {
  compareRecentSubscriberOrder,
  parseRecentSubscriberOrder,
  serializeRecentSubscriberOrder,
  type RecentSubscriberOrder,
} from "./recentSubscriberOrder";
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
type PendingUsernameOwnership = {
  userId: string;
  operationId?: string;
  erasureGeneration?: string;
};
const encodePendingUsernameOwnership = (
  operation: Pick<
    PendingSubscriberTracking,
    "userId" | "operationId" | "erasureGeneration"
  >,
): string =>
  JSON.stringify({
    userId: operation.userId,
    operationId: operation.operationId,
    erasureGeneration: operation.erasureGeneration,
  } satisfies PendingUsernameOwnership);
const decodePendingUsernameOwnership = (
  raw: string | undefined,
): PendingUsernameOwnership | undefined => {
  if (!raw) return;
  if (!raw.startsWith("{")) return { userId: raw };
  try {
    const value = JSON.parse(raw) as Partial<PendingUsernameOwnership>;
    if (typeof value.userId !== "string") return;
    return {
      userId: value.userId,
      ...(typeof value.operationId === "string"
        ? { operationId: value.operationId }
        : {}),
      ...(typeof value.erasureGeneration === "string"
        ? { erasureGeneration: value.erasureGeneration }
        : {}),
    };
  } catch (error) {
    logDiagnostic(
      "warn",
      "persisted_json_invalid",
      { workflow: "subscriber_tracking", phase: "pending_username_decode" },
      error,
    );
  }
};
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
        [normalizeUsername(input.username)]:
          encodePendingUsernameOwnership(operation),
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
      await tx.hSet(subscriberTrackingUsernameToUserIdKey, {
        [normalizeUsername(operation.username)]:
          encodePendingUsernameOwnership(operation),
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
    subscriberGoalsKey,
    retiredKey,
  );
  const [
    currentGeneration,
    currentOperationId,
    currentRaw,
    existingStats,
    retired,
    storedRecentOrderRaw,
    storedRecentSubscriber,
  ] = await Promise.all([
    redis.get(generation),
    redis.hGet(subscriberTrackingPendingByUserKey, operation.userId),
    redis.hGet(subscriberTrackingPendingByOperationKey, operation.operationId),
    redis.hGet(subscriberStatsByUserIdKey, operation.userId),
    redis.get(retiredKey),
    redis.hGet(
      subscriberGoalsKey,
      `${operation.postId}${postRecentSubscriberOrderSuffix}`,
    ),
    redis.hGet(
      subscriberGoalsKey,
      `${operation.postId}${postRecentSubscriberSuffix}`,
    ),
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
  const operationOrder: RecentSubscriberOrder = {
    timestamp: operation.timestamp,
    operationId: operation.operationId,
    userId: operation.userId,
    erasureGeneration: operation.erasureGeneration,
  };
  const storedRecentOrder = parseRecentSubscriberOrder(storedRecentOrderRaw);
  const shouldUpdateRecentSubscriber =
    !retired &&
    (!storedRecentOrder ||
      compareRecentSubscriberOrder(operationOrder, storedRecentOrder) >= 0);
  const nextRecentSubscriber = operation.shareUsername
    ? operation.username
    : "";
  const previousNormalized = normalizeUsername(storedRecentSubscriber ?? "");
  const affectedRecentUsernames = new Set(
    [previousNormalized, operation.shareUsername ? normalized : ""].filter(
      Boolean,
    ),
  );
  const recentIndexUpdates = new Map<string, string[]>();
  if (shouldUpdateRecentSubscriber) {
    for (const affectedUsername of affectedRecentUsernames) {
      const existingPosts = parseList(
        await redis.hGet(recentSubscriberPostsByUsernameKey, affectedUsername),
      );
      const withoutPost = existingPosts.filter(
        (postId) => postId !== operation.postId,
      );
      recentIndexUpdates.set(
        affectedUsername,
        operation.shareUsername && affectedUsername === normalized
          ? [...new Set([...withoutPost, operation.postId])]
          : withoutPost,
      );
    }
  }
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
  if (shouldUpdateRecentSubscriber) {
    await tx.hSet(subscriberGoalsKey, {
      [`${operation.postId}${postRecentSubscriberSuffix}`]:
        nextRecentSubscriber,
      [`${operation.postId}${postRecentSubscriberOrderSuffix}`]:
        serializeRecentSubscriberOrder(operationOrder),
    });
    for (const [affectedUsername, postIds] of recentIndexUpdates) {
      if (postIds.length > 0) {
        await tx.hSet(recentSubscriberPostsByUsernameKey, {
          [affectedUsername]: JSON.stringify(postIds),
        });
      } else {
        await tx.hDel(recentSubscriberPostsByUsernameKey, [affectedUsername]);
      }
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
    subscriberTrackingUsernameToUserIdKey,
  );
  const normalized = normalizeUsername(operation.username);
  const [currentOperationId, currentRaw, usernameOwnershipRaw] =
    await Promise.all([
      redis.hGet(subscriberTrackingPendingByUserKey, operation.userId),
      redis.hGet(
        subscriberTrackingPendingByOperationKey,
        operation.operationId,
      ),
      redis.hGet(subscriberTrackingUsernameToUserIdKey, normalized),
    ]);
  const current = decode(currentRaw);
  const usernameOwnership =
    decodePendingUsernameOwnership(usernameOwnershipRaw);
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
  if (
    usernameOwnership?.userId === operation.userId &&
    (!usernameOwnership.operationId ||
      usernameOwnership.operationId === operation.operationId)
  ) {
    await tx.hDel(subscriberTrackingUsernameToUserIdKey, [normalized]);
  }
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

async function removeUnusableQueueEntry(
  redis: RedisClient,
  operationId: string,
  expectedRaw: string | undefined,
): Promise<boolean> {
  for (let retry = 0; retry < 3; retry += 1) {
    const tx = await redis.watch(
      subscriberTrackingPendingByOperationKey,
      subscriberTrackingQueueKey,
    );
    const currentRaw = await redis.hGet(
      subscriberTrackingPendingByOperationKey,
      operationId,
    );
    if (currentRaw !== expectedRaw) {
      await tx.unwatch();
      return false;
    }
    await tx.multi();
    await tx.zRem(subscriberTrackingQueueKey, [operationId]);
    const result = await tx.exec();
    if (result.length > 0) return true;
  }
  throw new Error("subscriber_tracking_unusable_cleanup_conflict");
}

async function rescheduleSubscriberTracking(
  redis: RedisClient,
  operation: PendingSubscriberTracking,
  runAt: number,
): Promise<"rescheduled" | "invalidated"> {
  for (let retry = 0; retry < 3; retry += 1) {
    const generationKey = subscriberTrackingGenerationKey(operation.userId);
    const tx = await redis.watch(
      generationKey,
      subscriberTrackingPendingByUserKey,
      subscriberTrackingPendingByOperationKey,
      subscriberTrackingQueueKey,
    );
    const [generation, currentOperationId, currentRaw] = await Promise.all([
      redis.get(generationKey),
      redis.hGet(subscriberTrackingPendingByUserKey, operation.userId),
      redis.hGet(
        subscriberTrackingPendingByOperationKey,
        operation.operationId,
      ),
    ]);
    const current = decode(currentRaw);
    if (
      (generation ?? "") !== operation.erasureGeneration ||
      currentOperationId !== operation.operationId ||
      current?.operationId !== operation.operationId ||
      current.erasureGeneration !== operation.erasureGeneration
    ) {
      await tx.unwatch();
      return "invalidated";
    }
    const next = { ...current, attempts: current.attempts + 1 };
    await tx.multi();
    await tx.hSet(subscriberTrackingPendingByOperationKey, {
      [operation.operationId]: encode(next),
    });
    await tx.zAdd(subscriberTrackingQueueKey, {
      member: operation.operationId,
      score: runAt,
    });
    const result = await tx.exec();
    if (result.length > 0) return "rescheduled";
  }
  throw new Error("subscriber_tracking_reschedule_conflict");
}

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
    let raw: string | undefined;
    try {
      raw = await redis.hGet(
        subscriberTrackingPendingByOperationKey,
        entry.member,
      );
    } catch (error) {
      failed += 1;
      logDiagnostic(
        "warn",
        "subscriber_tracking_pending_read_failed",
        {
          workflow: "subscriber_tracking_repair",
          phase: "pending_read",
          operationId: entry.member,
        },
        error,
      );
      try {
        await redis.zAdd(subscriberTrackingQueueKey, {
          member: entry.member,
          score: nowMs + retryDelay(0),
        });
      } catch (deferError) {
        failedReschedule = true;
        logDiagnostic(
          "error",
          "subscriber_tracking_reschedule_failed",
          {
            workflow: "subscriber_tracking_repair",
            phase: "read_failure_defer",
            operationId: entry.member,
          },
          deferError,
        );
      }
      continue;
    }
    const operation = decode(raw);
    if (!operation) {
      try {
        await removeUnusableQueueEntry(redis, entry.member, raw);
        completed += 1;
        logDiagnostic("warn", "subscriber_tracking_unusable_removed", {
          workflow: "subscriber_tracking_repair",
          phase: raw === undefined ? "orphan" : "invalid_payload",
          operationId: entry.member,
        });
      } catch (error) {
        failed += 1;
        failedReschedule = true;
        logDiagnostic(
          "error",
          "subscriber_tracking_unusable_cleanup_failed",
          {
            workflow: "subscriber_tracking_repair",
            phase: raw === undefined ? "orphan" : "invalid_payload",
            operationId: entry.member,
          },
          error,
        );
      }
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
        else throw new Error("subscriber_tracking_cleanup_not_committed");
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
      try {
        const result = await rescheduleSubscriberTracking(
          redis,
          operation,
          nowMs + retryDelay(operation.attempts),
        );
        if (result === "invalidated") {
          await redis.zRem(subscriberTrackingQueueKey, [operation.operationId]);
          completed += 1;
        }
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

  for (let retry = 0; retry < 3; retry += 1) {
    const tx = await redis.watch(
      subscriberTrackingPendingByUserKey,
      subscriberTrackingPendingByOperationKey,
      subscriberTrackingQueueKey,
    );
    const operationId = await redis.hGet(
      subscriberTrackingPendingByUserKey,
      userId,
    );
    const operation = operationId
      ? decode(
          await redis.hGet(
            subscriberTrackingPendingByOperationKey,
            operationId,
          ),
        )
      : undefined;
    if (operation?.erasureGeneration === nextGeneration) {
      await tx.unwatch();
      break;
    }
    await tx.multi();
    if (operationId) {
      await tx.hDel(subscriberTrackingPendingByUserKey, [userId]);
      await tx.hDel(subscriberTrackingPendingByOperationKey, [operationId]);
      await tx.zRem(subscriberTrackingQueueKey, [operationId]);
    } else {
      // Keep a command in the transaction so an empty pending state is still
      // verified against a concurrent fresh join.
      await tx.hDel(subscriberTrackingPendingByUserKey, [userId]);
    }
    const result = await tx.exec();
    if (result.length > 0) break;
    if (retry === 2)
      throw new Error("subscriber_tracking_invalidation_conflict");
  }

  let cursor = 0;
  const usernameFields = new Set<string>();
  do {
    const page = await redis.hScan(
      subscriberTrackingUsernameToUserIdKey,
      cursor,
      undefined,
      100,
    );
    cursor = page.cursor;
    for (const { field, value } of page.fieldValues) {
      if (decodePendingUsernameOwnership(value)?.userId === userId) {
        usernameFields.add(field);
      }
    }
  } while (cursor !== 0);
  for (const field of usernameFields) {
    for (let retry = 0; retry < 3; retry += 1) {
      const tx = await redis.watch(subscriberTrackingUsernameToUserIdKey);
      const ownership = decodePendingUsernameOwnership(
        await redis.hGet(subscriberTrackingUsernameToUserIdKey, field),
      );
      if (
        ownership?.userId !== userId ||
        ownership.erasureGeneration === nextGeneration
      ) {
        await tx.unwatch();
        break;
      }
      await tx.multi();
      await tx.hDel(subscriberTrackingUsernameToUserIdKey, [field]);
      const result = await tx.exec();
      if (result.length > 0) break;
      if (retry === 2)
        throw new Error("subscriber_tracking_username_cleanup_conflict");
    }
  }
}

export async function findPendingSubscriberUserIdByUsername(
  redis: RedisClient,
  username: string,
): Promise<string | undefined> {
  return decodePendingUsernameOwnership(
    await redis.hGet(
      subscriberTrackingUsernameToUserIdKey,
      normalizeUsername(username),
    ),
  )?.userId;
}
