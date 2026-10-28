import { logDiagnostic } from "../../shared/diagnostics";
import type { RedditClient, RedisClient, SubredditId } from "../types";

export const inviteNewSubsHostSubreddit = "subscriber_goal_dev";
export const inviteNewSubsControlWikiPage = "invite-new-subs";
export const inviteNewSubsMessageWikiPage = "invite-new-subs-message";
export const inviteNewSubsDataWikiPage = "invite-new-subs-data";
export const inviteNewSubsWikiVersion = "v1" as const;
export const inviteNewSubsDataWikiVersion = "v1" as const;
export const inviteNewSubsDeliveryJobName = "invite-new-subs-delivery-job";
export const inviteNewSubsReportJobName = "invite-new-subs-report-job";
export const inviteNewSubsSubject = "Tool for Growing your New Subreddit";
export const inviteNewSubsReportRecipient = "Alan-Foster";
export const inviteNewSubsReportSubject = "New Subreddit DM Report — 12 Hours";
export const inviteNewSubsStartupTestSubreddit = "SubGoal";
export const inviteNewSubsRetentionSeconds = 7 * 24 * 60 * 60;
export const inviteNewSubsRecipientCooldownSeconds = 30 * 24 * 60 * 60;
export const inviteNewSubsReportWindowMs = 12 * 60 * 60 * 1000;
export const inviteNewSubsDeliverySpacingMs = 15_000;
export const inviteNewSubsMaximumQueueDepth = 16;
export const inviteNewSubsMessageSchemaVersion = 1;
export const inviteNewSubsSchemaVersion = 2;
export const inviteNewSubsSource = "reddit/subreddits/new";
export const inviteNewSubsMaximumBatchSize = 25;

const inviteNewSubsGateStateKey = "invite_new_subs:gate_state:v1";
const inviteNewSubsBatchIdentityKey = "invite_new_subs:batch_identity:v1";
const inviteNewSubsSeenKeyPrefix = "invite_new_subs:seen:v2";
const inviteNewSubsDeliveryClaimKeyPrefix = "invite_new_subs:delivery_claim:v2";
const inviteNewSubsOverloadDeliveryClaimKeyPrefix =
  "invite_new_subs:overload_delivery_claim:v1";
const inviteNewSubsStartupScheduleKeyPrefix =
  "invite_new_subs:startup_schedule:v1";
const inviteNewSubsStartupDeliveryClaimKeyPrefix =
  "invite_new_subs:startup_delivery_claim:v1";
const inviteNewSubsPublisherSessionKeyPrefix =
  "invite_new_subs:publisher_session:v1";
const inviteNewSubsRecipientCooldownKeyPrefix =
  "invite_new_subs:recipient_cooldown:v1";
const inviteNewSubsDeliveryMetricsKey = "invite_new_subs:delivery_metrics:v1";
const inviteNewSubsTemplateSequenceKey = "invite_new_subs:template_sequence:v1";
const inviteNewSubsQueueKey = "invite_new_subs:delivery_queue:v1";
const inviteNewSubsQueueLockKey = "invite_new_subs:delivery_queue_lock:v1";
const inviteNewSubsFullBatchPendingKey =
  "invite_new_subs:full_batch_pending:v1";
const inviteNewSubsFullBatchMarkerKeyPrefix =
  "invite_new_subs:full_batch_marker:v1";
const inviteNewSubsQueueLockMs = 5 * 60 * 1000;
const inviteNewSubsQueueStaleMs = 10 * 60 * 1000;
const inviteNewSubsReportLockKeyPrefix = "invite_new_subs:report_lock:v1";
const inviteNewSubsReportSentKeyPrefix = "invite_new_subs:report_sent:v1";
const inviteNewSubsReportLockMs = 5 * 60 * 1000;
const inviteNewSubsReportSentRetentionSeconds = 30 * 24 * 60 * 60;
const subredditIdPattern = /^t5_[a-z0-9]+$/i;
const displayNamePattern = /^[a-z0-9_]+$/i;
const publisherSessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const utcIsoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const templateIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const supportedTemplatePlaceholders = new Set([
  "{{topModerator}}",
  "{{subredditName}}",
  "{{isNsfw}}",
]);

export type InviteNewSubsDiscoveryRecord = {
  id: SubredditId;
  displayName: string;
  subredditType: string;
  over18: boolean;
  subscribers: number;
  createdUtc: number;
  url: string;
};

type InviteNewSubsDiscoveryBatchBase = {
  source: typeof inviteNewSubsSource;
  generatedAt: string;
  subreddits: InviteNewSubsDiscoveryRecord[];
};

export type InviteNewSubsDiscoveryBatch = InviteNewSubsDiscoveryBatchBase &
  (
    | { schemaVersion: 1 }
    | {
        schemaVersion: 2;
        publisherSessionId: string;
        publisherStartedAt: string;
      }
  );

export type InviteNewSubsStatus =
  | "baseline"
  | "processing"
  | "lookup_failed"
  | "not_public"
  | "no_moderator"
  | "queued"
  | "schedule_failed"
  | "rate_limited"
  | "cooldown_suppressed"
  | "messaged"
  | "dm_failed";

export type InviteNewSubsDeliveryJob = {
  subredditId: SubredditId;
  subredditName: string;
  topModerator: string;
  isNsfw: boolean;
  renderedMessage: string;
  templateId?: string;
  deliveryKind?: "overload_test" | "startup_test" | "full_batch_test";
  overloadEventId?: string;
  startupSessionId?: string;
  fullBatchEventId?: string;
  fullBatchSignature?: string;
  queueEntryId?: string;
};

export type InviteNewSubsMessageTemplate = {
  id: string;
  body: string;
};

export type InviteNewSubsMessageConfig = {
  schemaVersion: typeof inviteNewSubsMessageSchemaVersion;
  templates: InviteNewSubsMessageTemplate[];
};

type InviteNewSubsTemplateSelection = InviteNewSubsMessageTemplate & {
  sequence: number;
};

type InviteNewSubsRecord = {
  status: InviteNewSubsStatus;
  subredditId: SubredditId;
  subredditName: string;
  updatedAt: number;
  topModerator?: string;
  isNsfw?: boolean;
  error?: string;
};

type InviteNewSubsBatchClassification = {
  batchSize: number;
  unseen: number;
  baselineRecords: number;
  allIdsAreAbsent: boolean;
  createdLast60Seconds: number;
  newestAgeSeconds: number;
  oldestAgeSeconds: number;
  requiresBaseline: boolean;
  baselineReason: InviteNewSubsBaselineReason;
  fullBatchAllUnseen: boolean;
  publisherSessionStatus: InviteNewSubsPublisherSessionStatus;
  startupTestEligible: boolean;
};

type InviteNewSubsBaselineReason =
  | "publisher_startup"
  | "full_batch_all_unseen"
  | "gate_reenabled"
  | "same_batch_state_loss"
  | "legacy_all_unseen"
  | "none";

type InviteNewSubsPublisherSessionStatus =
  | "legacy"
  | "new"
  | "pending"
  | "scheduled"
  | "not_eligible";

type InviteNewSubsPublisherSessionState = {
  status: "pending" | "scheduled" | "not_eligible";
  sessionId: string;
  publisherStartedAt: string;
  startupEventId?: string;
  initialBatchIdentity: string;
  claimToken: string;
  updatedAt: number;
};

type SchedulerRunClient = {
  runJob(job: {
    name: string;
    data: InviteNewSubsDeliveryJob;
    runAt: Date;
  }): Promise<string>;
};

type InviteNewSubsQueueEntry = {
  queueEntryId: string;
  scheduledAt: number;
};

type InviteNewSubsQueueScheduleResult =
  | {
      status: "queued";
      queueEntryId: string;
      queuePosition: number;
      scheduledAt: Date;
    }
  | { status: "full" };

type InviteNewSubsQueueContext = {
  depthBefore: number;
  entries: InviteNewSubsQueueEntry[];
  schedule(
    job: InviteNewSubsDeliveryJob,
  ): Promise<InviteNewSubsQueueScheduleResult>;
};

type InviteNewSubsFullBatchEvent = {
  signature: string;
  eventId: string;
  createdAt: number;
};

type InviteNewSubsBatchIdentity = {
  version: 2;
  schemaVersion: 1 | 2;
  publisherSessionId: string;
  orderedSubredditIds: string[];
};

type InviteNewSubsRedisTransaction = {
  multi(): Promise<void>;
  unwatch(): Promise<unknown>;
  discard(): Promise<unknown>;
  set(
    key: string,
    value: string,
    options?: { nx?: boolean; expiration?: Date },
  ): Promise<unknown>;
  zAdd(
    key: string,
    ...entries: Array<{ member: string; score: number }>
  ): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  exec(): Promise<unknown[] | null>;
};

type InviteNewSubsTransactionalRedis = RedisClient & {
  watch(...keys: string[]): Promise<InviteNewSubsRedisTransaction>;
};

type InviteNewSubsCompareAndSetResult = {
  updated: boolean;
};

export type InviteNewSubsPollResult = {
  status:
    | "wrong_subreddit"
    | "disabled"
    | "gate_unavailable"
    | "template_unavailable"
    | "data_unavailable"
    | "invalid_data"
    | "baseline"
    | "unchanged"
    | "processed";
  discovered: number;
  queued: number;
  skipped: number;
  rateLimited?: number;
  startupTestStatus?: "queued" | "already_scheduled" | "failed";
  startupFailureReason?: InviteNewSubsStartupFailureReason;
};

export type InviteNewSubsStartupFailureReason =
  | "marker_unavailable"
  | "subreddit_lookup_failed"
  | "unsupported_subreddit_type"
  | "moderator_lookup_failed"
  | "no_moderator"
  | "template_selection_failed"
  | "queue_full"
  | "schedule_failed";

type InviteNewSubsStartupScheduleResult =
  | { status: "queued" }
  | { status: "already_scheduled"; confirmed: boolean }
  | { status: "failed"; reason: InviteNewSubsStartupFailureReason };

export type InviteNewSubsDeliveryResult =
  | "invalid"
  | "duplicate"
  | "recipient_cooldown"
  | "messaged"
  | "dm_failed";

type InviteNewSubsDeliveryOutcome = "success" | "failure";

type InviteNewSubsDeliveryMetric = {
  eventId: string;
  outcome: InviteNewSubsDeliveryOutcome;
};

export type InviteNewSubsReportResult = {
  status: "sent" | "already_sent" | "disabled";
  windowStart: number;
  windowEnd: number;
  total: number;
  successful: number;
  failed: number;
};

async function withInviteNewSubsQueue<T>({
  redis,
  scheduler,
  nowMs,
  run,
}: {
  redis: RedisClient;
  scheduler: SchedulerRunClient;
  nowMs: number;
  run: (queue: InviteNewSubsQueueContext) => Promise<T>;
}): Promise<T | undefined> {
  const lockToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(inviteNewSubsQueueLockKey, lockToken, {
    nx: true,
    expiration: new Date(nowMs + inviteNewSubsQueueLockMs),
  });
  if ((await redis.get(inviteNewSubsQueueLockKey)) !== lockToken) {
    logDiagnostic("info", "invite_new_subs_queue_lock_busy", {
      workflow: "invite_new_subs",
      phase: "queue_lock",
    });
    return undefined;
  }

  try {
    const stored = await redis.zRange(inviteNewSubsQueueKey, 0, -1);
    const staleCutoff = nowMs - inviteNewSubsQueueStaleMs;
    const staleMembers = stored
      .filter(({ score }) => Number(score) < staleCutoff)
      .map(({ member }) => member);
    if (staleMembers.length > 0) {
      await redis.zRem(inviteNewSubsQueueKey, staleMembers);
      logDiagnostic("warn", "invite_new_subs_queue_stale_entries_removed", {
        workflow: "invite_new_subs",
        phase: "queue_recovery",
        staleCount: staleMembers.length,
      });
    }
    const staleSet = new Set(staleMembers);
    const entries: InviteNewSubsQueueEntry[] = stored
      .filter(({ member }) => !staleSet.has(member))
      .map(({ member, score }) => ({
        queueEntryId: member,
        scheduledAt: Number(score),
      }))
      .filter(({ scheduledAt }) => Number.isFinite(scheduledAt))
      .sort((left, right) => left.scheduledAt - right.scheduledAt);
    const depthBefore = entries.length;
    const queue: InviteNewSubsQueueContext = {
      depthBefore,
      entries,
      schedule: async (job) => {
        if (entries.length >= inviteNewSubsMaximumQueueDepth) {
          return { status: "full" };
        }
        const previous = entries.at(-1);
        const scheduledAtMs = previous
          ? Math.max(
              nowMs,
              previous.scheduledAt + inviteNewSubsDeliverySpacingMs,
            )
          : nowMs;
        const queueEntryId = `${nowMs}:${Math.random().toString(36).slice(2)}`;
        await redis.zAdd(inviteNewSubsQueueKey, {
          member: queueEntryId,
          score: scheduledAtMs,
        });
        await redis.expire(
          inviteNewSubsQueueKey,
          inviteNewSubsRetentionSeconds,
        );
        const scheduledAt = new Date(scheduledAtMs);
        try {
          await scheduler.runJob({
            name: inviteNewSubsDeliveryJobName,
            data: { ...job, queueEntryId },
            runAt: scheduledAt,
          });
        } catch (error) {
          await redis.zRem(inviteNewSubsQueueKey, [queueEntryId]);
          throw error;
        }
        entries.push({ queueEntryId, scheduledAt: scheduledAtMs });
        return {
          status: "queued",
          queueEntryId,
          queuePosition: entries.length,
          scheduledAt,
        };
      },
    };
    logDiagnostic("info", "invite_new_subs_queue_opened", {
      workflow: "invite_new_subs",
      phase: "queue_capacity",
      queueDepthBefore: depthBefore,
      queueCapacity: inviteNewSubsMaximumQueueDepth,
      queueSlotsAvailable: Math.max(
        0,
        inviteNewSubsMaximumQueueDepth - depthBefore,
      ),
    });
    return await run(queue);
  } finally {
    if ((await redis.get(inviteNewSubsQueueLockKey)) === lockToken) {
      await redis.del(inviteNewSubsQueueLockKey);
    }
  }
}

async function compareAndSetInviteNewSubsValue({
  redis,
  key,
  createNextValue,
  expiration,
}: {
  redis: RedisClient;
  key: string;
  createNextValue: (current: string | undefined) => string | undefined;
  expiration: Date;
}): Promise<InviteNewSubsCompareAndSetResult> {
  const transactionalRedis = redis as InviteNewSubsTransactionalRedis;
  if (typeof transactionalRedis.watch !== "function") {
    throw new Error("Invitation state transitions require Redis WATCH.");
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const transaction = await transactionalRedis.watch(key);
    const current = await redis.get(key);
    const next = createNextValue(current);
    if (next === undefined) {
      await transaction.unwatch();
      return { updated: false };
    }
    try {
      await transaction.multi();
      await transaction.set(key, next, { expiration });
      const result = await transaction.exec();
      if (result !== null) return { updated: true };
    } catch (error) {
      try {
        await transaction.discard();
      } catch {
        // diagnostic-allow-silent: the original transaction error is authoritative.
      }
      throw error;
    }
    logDiagnostic("warn", "invite_new_subs_state_transition_retried", {
      workflow: "invite_new_subs",
      phase: "state_transition",
      key,
      attempt,
    });
  }
  throw new Error(`Invitation state transition was aborted for ${key}.`);
}

function createFullBatchSignature(batch: InviteNewSubsDiscoveryBatch): string {
  return batch.subreddits
    .map((candidate) => candidate.id.toLowerCase())
    .join(",");
}

function createInviteNewSubsFullBatchEvent(
  batch: InviteNewSubsDiscoveryBatch,
  nowMs: number,
): InviteNewSubsFullBatchEvent {
  const signature = createFullBatchSignature(batch);
  return {
    signature,
    eventId: batch.generatedAt,
    createdAt: nowMs,
  };
}

async function persistInviteNewSubsBaselineAtomic({
  redis,
  batch,
  batchIdentity,
  publisherSession,
  fullBatchAllUnseen,
  nowMs,
}: {
  redis: RedisClient;
  batch: InviteNewSubsDiscoveryBatch;
  batchIdentity: string;
  publisherSession: InviteNewSubsPublisherSessionResolution;
  fullBatchAllUnseen: boolean;
  nowMs: number;
}): Promise<InviteNewSubsFullBatchEvent | undefined> {
  const transactionalRedis = redis as InviteNewSubsTransactionalRedis;
  if (typeof transactionalRedis.watch !== "function") {
    throw new Error("Invitation baseline persistence requires Redis WATCH.");
  }
  const event = fullBatchAllUnseen
    ? createInviteNewSubsFullBatchEvent(batch, nowMs)
    : undefined;
  const markerKey = event
    ? `${inviteNewSubsFullBatchMarkerKeyPrefix}:${encodeURIComponent(event.signature)}`
    : undefined;
  const sessionState =
    fullBatchAllUnseen && publisherSession.state?.status === "pending"
      ? {
          ...publisherSession.state,
          status: "scheduled" as const,
          updatedAt: nowMs,
        }
      : undefined;
  const watchedKeys = [
    inviteNewSubsBatchIdentityKey,
    inviteNewSubsGateStateKey,
    ...batch.subreddits.map((candidate) => inviteNewSubsSeenKey(candidate.id)),
    ...(markerKey ? [markerKey, inviteNewSubsFullBatchPendingKey] : []),
    ...(sessionState
      ? [inviteNewSubsPublisherSessionKey(sessionState.sessionId)]
      : []),
  ];

  try {
    let committed = false;
    for (let attempt = 1; attempt <= 3 && !committed; attempt += 1) {
      const transaction = await transactionalRedis.watch(...watchedKeys);
      await transaction.multi();
      for (const candidate of batch.subreddits) {
        const record: InviteNewSubsRecord = {
          status: "baseline",
          subredditId: candidate.id,
          subredditName: candidate.displayName,
          updatedAt: nowMs,
          isNsfw: candidate.over18,
        };
        await transaction.set(
          inviteNewSubsSeenKey(candidate.id),
          JSON.stringify(record),
          { expiration: expirationDate(nowMs) },
        );
      }
      await transaction.set(inviteNewSubsBatchIdentityKey, batchIdentity, {
        expiration: expirationDate(nowMs),
      });
      await transaction.set(inviteNewSubsGateStateKey, "enabled");
      if (event && markerKey) {
        await transaction.set(markerKey, `pending:${event.eventId}`, {
          nx: true,
          expiration: expirationDate(nowMs),
        });
        await transaction.zAdd(inviteNewSubsFullBatchPendingKey, {
          member: JSON.stringify(event),
          score: nowMs,
        });
        await transaction.expire(
          inviteNewSubsFullBatchPendingKey,
          inviteNewSubsRetentionSeconds,
        );
      }
      if (sessionState) {
        await transaction.set(
          inviteNewSubsPublisherSessionKey(sessionState.sessionId),
          JSON.stringify(sessionState),
          { expiration: expirationDate(nowMs) },
        );
      }
      const result = await transaction.exec();
      committed = result !== null;
      if (!committed) {
        logDiagnostic("warn", "invite_new_subs_baseline_transaction_retried", {
          workflow: "invite_new_subs",
          phase: "baseline_persistence",
          attempt,
          batchSize: batch.subreddits.length,
          generatedAt: batch.generatedAt,
        });
      }
    }
    if (!committed) {
      throw new Error("Invitation baseline transaction was aborted.");
    }
  } catch (error) {
    logDiagnostic(
      "error",
      "invite_new_subs_baseline_transaction_failed",
      {
        workflow: "invite_new_subs",
        phase: "baseline_persistence",
        batchSize: batch.subreddits.length,
        fullBatchAllUnseen,
        generatedAt: batch.generatedAt,
      },
      error,
    );
    throw error;
  }

  if (event) {
    logDiagnostic("info", "invite_new_subs_full_batch_test_pending", {
      workflow: "invite_new_subs",
      phase: "full_batch_alert",
      fullBatchEventId: event.eventId,
      batchSize: batch.subreddits.length,
    });
  }
  return event;
}

function parseInviteNewSubsFullBatchEvent(
  value: string,
): InviteNewSubsFullBatchEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      typeof parsed.signature !== "string" ||
      !parsed.signature ||
      typeof parsed.eventId !== "string" ||
      !utcIsoPattern.test(parsed.eventId) ||
      typeof parsed.createdAt !== "number"
    ) {
      return undefined;
    }
    return parsed as InviteNewSubsFullBatchEvent;
  } catch {
    // diagnostic-allow-silent: malformed pending entries are discarded by the caller.
    return undefined;
  }
}

function isInviteNewSubsFullBatchTerminalMarker(
  marker: string | undefined,
): boolean {
  return (
    marker?.startsWith("scheduled:") === true ||
    marker?.startsWith("delivered:") === true ||
    marker?.startsWith("failed:") === true
  );
}

async function recoverInviteNewSubsFullBatchPendingEvent({
  redis,
  batch,
  baselineRecords,
  nowMs,
}: {
  redis: RedisClient;
  batch: InviteNewSubsDiscoveryBatch;
  baselineRecords: number;
  nowMs: number;
}): Promise<void> {
  if (
    batch.subreddits.length !== inviteNewSubsMaximumBatchSize ||
    baselineRecords !== inviteNewSubsMaximumBatchSize
  ) {
    return;
  }
  const signature = createFullBatchSignature(batch);
  const markerKey = `${inviteNewSubsFullBatchMarkerKeyPrefix}:${encodeURIComponent(signature)}`;
  const marker = await redis.get(markerKey);
  if (!marker || isInviteNewSubsFullBatchTerminalMarker(marker)) return;
  const pending = await redis.zRange(inviteNewSubsFullBatchPendingKey, 0, -1);
  if (
    pending.some(
      ({ member }) =>
        parseInviteNewSubsFullBatchEvent(member)?.signature === signature,
    )
  ) {
    return;
  }
  const event = createInviteNewSubsFullBatchEvent(batch, nowMs);
  await redis.zAdd(inviteNewSubsFullBatchPendingKey, {
    member: JSON.stringify(event),
    score: nowMs,
  });
  await redis.expire(
    inviteNewSubsFullBatchPendingKey,
    inviteNewSubsRetentionSeconds,
  );
  logDiagnostic("warn", "invite_new_subs_full_batch_pending_recovered", {
    workflow: "invite_new_subs",
    phase: "full_batch_recovery",
    fullBatchEventId: event.eventId,
    markerState: marker.startsWith("pending:") ? "pending" : "legacy",
    batchSize: batch.subreddits.length,
  });
}

function isInviteNewSubsFullBatchSignature(value: string): boolean {
  const ids = value.split(",");
  return (
    ids.length === inviteNewSubsMaximumBatchSize &&
    new Set(ids).size === inviteNewSubsMaximumBatchSize &&
    ids.every((id) => subredditIdPattern.test(id))
  );
}

async function recordInviteNewSubsFullBatchDeliveryState(
  redis: RedisClient,
  job: InviteNewSubsDeliveryJob,
  state: "delivered" | "failed",
  nowMs: number,
): Promise<void> {
  if (
    job.deliveryKind !== "full_batch_test" ||
    !job.fullBatchSignature ||
    !job.fullBatchEventId
  ) {
    return;
  }
  const markerKey = `${inviteNewSubsFullBatchMarkerKeyPrefix}:${encodeURIComponent(job.fullBatchSignature)}`;
  try {
    await redis.set(markerKey, `${state}:${job.fullBatchEventId}`, {
      expiration: expirationDate(nowMs),
    });
    logDiagnostic(
      state === "delivered" ? "info" : "warn",
      `invite_new_subs_full_batch_test_${state}`,
      {
        workflow: "invite_new_subs",
        phase: "delivery",
        fullBatchEventId: job.fullBatchEventId,
        subredditId: job.subredditId,
        subredditName: job.subredditName,
        recipientUsername: normalizeRedditUsername(
          job.topModerator,
        ).toLowerCase(),
      },
    );
  } catch (error) {
    logDiagnostic(
      "warn",
      "invite_new_subs_full_batch_test_state_write_failed",
      {
        workflow: "invite_new_subs",
        phase: "delivery_persistence",
        fullBatchEventId: job.fullBatchEventId,
        deliveryState: state,
      },
      error,
    );
  }
}

async function markInviteNewSubsFullBatchScheduled(
  redis: RedisClient,
  event: InviteNewSubsFullBatchEvent,
  nowMs: number,
): Promise<boolean> {
  const markerKey = `${inviteNewSubsFullBatchMarkerKeyPrefix}:${encodeURIComponent(event.signature)}`;
  let observedState = "missing";
  const result = await compareAndSetInviteNewSubsValue({
    redis,
    key: markerKey,
    expiration: expirationDate(nowMs),
    createNextValue: (current) => {
      observedState = current?.split(":", 1)[0] ?? "missing";
      if (!current || isInviteNewSubsFullBatchTerminalMarker(current)) {
        return undefined;
      }
      return `scheduled:${event.eventId}`;
    },
  });
  if (!result.updated) {
    logDiagnostic("info", "invite_new_subs_state_transition_skipped", {
      workflow: "invite_new_subs",
      phase: "full_batch_alert",
      fullBatchEventId: event.eventId,
      attemptedStatus: "scheduled",
      observedStatus: observedState,
      reason: "newer_state_preserved",
    });
  }
  return result.updated;
}

export const isInviteNewSubsHost = (
  subredditName: string | undefined,
): boolean =>
  normalizeSubredditName(subredditName ?? "") === inviteNewSubsHostSubreddit;

export async function processInviteNewSubsPoll({
  reddit,
  redis,
  scheduler,
  subredditName,
  now = Date.now,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  scheduler: SchedulerRunClient;
  subredditName: string | undefined;
  now?: () => number;
}): Promise<InviteNewSubsPollResult> {
  const emptyResult = { discovered: 0, queued: 0, skipped: 0 };
  if (!isInviteNewSubsHost(subredditName)) {
    return { status: "wrong_subreddit", ...emptyResult };
  }

  let controlPage: Awaited<ReturnType<RedditClient["getWikiPage"]>>;
  try {
    controlPage = await reddit.getWikiPage(
      inviteNewSubsHostSubreddit,
      inviteNewSubsControlWikiPage,
      { wikiVersion: inviteNewSubsWikiVersion },
    );
    if (typeof controlPage.content !== "string") {
      throw new Error("Invitation control wiki page returned no content.");
    }
  } catch (error) {
    logDiagnostic(
      "warn",
      "invite_new_subs_gate_unavailable",
      {
        workflow: "invite_new_subs",
        phase: "gate_read",
        subredditName: inviteNewSubsHostSubreddit,
        pageName: inviteNewSubsControlWikiPage,
        wikiVersion: inviteNewSubsWikiVersion,
      },
      error,
    );
    return { status: "gate_unavailable", ...emptyResult };
  }

  const normalizedControlContent = controlPage.content.trim();
  const enabled = normalizedControlContent === "enabled";
  logDiagnostic("info", "invite_new_subs_gate_evaluated", {
    workflow: "invite_new_subs",
    phase: "gate_read",
    subredditName: inviteNewSubsHostSubreddit,
    pageName: inviteNewSubsControlWikiPage,
    wikiVersion: controlPage.wikiVersion,
    normalizedValue: normalizedControlContent,
    enabled,
    revisionId: controlPage.revisionId,
    revisionDate: controlPage.revisionDate.toISOString(),
  });

  if (!enabled) {
    await redis.set(inviteNewSubsGateStateKey, "disabled");
    logDiagnostic("info", "invite_new_subs_disabled", {
      workflow: "invite_new_subs",
      phase: "gate_read",
    });
    return { status: "disabled", ...emptyResult };
  }

  let templatePage: Awaited<ReturnType<RedditClient["getWikiPage"]>>;
  try {
    templatePage = await reddit.getWikiPage(
      inviteNewSubsHostSubreddit,
      inviteNewSubsMessageWikiPage,
      { wikiVersion: inviteNewSubsWikiVersion },
    );
    if (typeof templatePage.content !== "string") {
      throw new Error("Invitation message wiki page returned no content.");
    }
  } catch (error) {
    logDiagnostic(
      "warn",
      "invite_new_subs_template_unavailable",
      {
        workflow: "invite_new_subs",
        phase: "template_read",
        subredditName: inviteNewSubsHostSubreddit,
        pageName: inviteNewSubsMessageWikiPage,
        requestedWikiVersion: inviteNewSubsWikiVersion,
        failureStage: "wiki_read",
      },
      error,
    );
    return completeInviteNewSubsPoll({
      status: "template_unavailable",
      ...emptyResult,
    });
  }

  const templateContent = templatePage.content.trim();
  let messageConfig: InviteNewSubsMessageConfig;
  try {
    messageConfig = parseInviteNewSubsMessageConfig(templateContent);
  } catch (error) {
    logDiagnostic(
      "warn",
      "invite_new_subs_template_unavailable",
      {
        workflow: "invite_new_subs",
        phase: "template_validation",
        subredditName: inviteNewSubsHostSubreddit,
        pageName: inviteNewSubsMessageWikiPage,
        requestedWikiVersion: inviteNewSubsWikiVersion,
        returnedWikiVersion: templatePage.wikiVersion,
        revisionId: templatePage.revisionId,
        revisionDate: templatePage.revisionDate.toISOString(),
        contentLength: templatePage.content.length,
        failureStage: "json_validation",
      },
      error,
    );
    return completeInviteNewSubsPoll({
      status: "template_unavailable",
      ...emptyResult,
    });
  }

  logDiagnostic("info", "invite_new_subs_template_loaded", {
    workflow: "invite_new_subs",
    phase: "template_read",
    subredditName: inviteNewSubsHostSubreddit,
    pageName: inviteNewSubsMessageWikiPage,
    requestedWikiVersion: inviteNewSubsWikiVersion,
    returnedWikiVersion: templatePage.wikiVersion,
    revisionId: templatePage.revisionId,
    revisionDate: templatePage.revisionDate.toISOString(),
    contentLength: templatePage.content.length,
    templateCount: messageConfig.templates.length,
  });

  let dataContent: string;
  try {
    const dataPage = await reddit.getWikiPage(
      inviteNewSubsHostSubreddit,
      inviteNewSubsDataWikiPage,
      { wikiVersion: inviteNewSubsDataWikiVersion },
    );
    if (typeof dataPage.content !== "string") {
      throw new Error("Invitation data wiki page returned no content.");
    }
    dataContent = dataPage.content;
    logDiagnostic("info", "invite_new_subs_data_fetched", {
      workflow: "invite_new_subs",
      phase: "data_read",
      subredditName: inviteNewSubsHostSubreddit,
      pageName: inviteNewSubsDataWikiPage,
      wikiVersion: dataPage.wikiVersion,
      revisionId: dataPage.revisionId,
      revisionDate: dataPage.revisionDate.toISOString(),
    });
  } catch (error) {
    logDiagnostic(
      "warn",
      "invite_new_subs_data_unavailable",
      {
        workflow: "invite_new_subs",
        phase: "data_read",
        subredditName: inviteNewSubsHostSubreddit,
        pageName: inviteNewSubsDataWikiPage,
        wikiVersion: inviteNewSubsDataWikiVersion,
      },
      error,
    );
    return completeInviteNewSubsPoll({
      status: "data_unavailable",
      ...emptyResult,
    });
  }

  let batch: InviteNewSubsDiscoveryBatch;
  try {
    batch = parseInviteNewSubsDiscoveryBatch(dataContent);
  } catch (error) {
    logDiagnostic(
      "warn",
      "invite_new_subs_data_invalid",
      {
        workflow: "invite_new_subs",
        phase: "data_validation",
        pageName: inviteNewSubsDataWikiPage,
        wikiVersion: inviteNewSubsDataWikiVersion,
      },
      error,
    );
    return completeInviteNewSubsPoll({
      status: "invalid_data",
      ...emptyResult,
    });
  }

  const nowMs = now();
  const batchIdentity = createBatchIdentity(batch);
  const previousGateState = await redis.get(inviteNewSubsGateStateKey);
  const previousBatchIdentity = await redis.get(inviteNewSubsBatchIdentityKey);
  const previousBatchMatch = batchIdentitiesMatch(
    previousBatchIdentity,
    batchIdentity,
  );
  if (previousBatchMatch.legacy) {
    logDiagnostic("info", "invite_new_subs_legacy_batch_identity_normalized", {
      workflow: "invite_new_subs",
      phase: "batch_identity",
      matched: previousBatchMatch.matches,
    });
    if (previousBatchMatch.matches) {
      await writeBatchIdentity(redis, batchIdentity, nowMs);
    }
  }

  const existingRecords = await Promise.all(
    batch.subreddits.map((candidate) =>
      redis.get(inviteNewSubsSeenKey(candidate.id)),
    ),
  );
  const parsedRecords = existingRecords.map(parseInviteNewSubsRecord);
  const unseen = existingRecords.filter(
    (record) => record === undefined,
  ).length;
  const baselineRecords = parsedRecords.filter(
    (record) => record?.status === "baseline",
  ).length;
  const allIdsAreAbsent = unseen === batch.subreddits.length;
  const fullBatchAllUnseen =
    batch.subreddits.length === inviteNewSubsMaximumBatchSize &&
    unseen === inviteNewSubsMaximumBatchSize;
  const freshness = classifyInviteNewSubsFreshness(batch);
  const publisherSession = await resolveInviteNewSubsPublisherSession({
    redis,
    batch,
    batchIdentity,
    unseen,
    nowMs,
  });
  const initialIneligibleBatch =
    publisherSession.state?.status === "not_eligible" &&
    batchIdentitiesMatch(
      publisherSession.state.initialBatchIdentity,
      batchIdentity,
    ).matches;
  const initialPublisherBatch =
    publisherSession.state?.status === "pending" &&
    batchIdentitiesMatch(
      publisherSession.state.initialBatchIdentity,
      batchIdentity,
    ).matches &&
    allIdsAreAbsent;
  const unchanged =
    previousGateState === "enabled" && previousBatchMatch.matches;
  let baselineReason: InviteNewSubsBaselineReason = "none";
  if (fullBatchAllUnseen) {
    baselineReason = "full_batch_all_unseen";
  } else if (previousGateState === "disabled") {
    baselineReason = "gate_reenabled";
  } else if (initialPublisherBatch) {
    baselineReason = "publisher_startup";
  } else if (allIdsAreAbsent && unchanged) {
    baselineReason = "same_batch_state_loss";
  } else if (batch.schemaVersion === 1 && allIdsAreAbsent) {
    baselineReason = "legacy_all_unseen";
  } else if (previousGateState !== "enabled" && !initialIneligibleBatch) {
    baselineReason = "gate_reenabled";
  }
  const requiresBaseline = baselineReason !== "none";
  const classification: InviteNewSubsBatchClassification = {
    batchSize: batch.subreddits.length,
    unseen,
    baselineRecords,
    allIdsAreAbsent,
    ...freshness,
    requiresBaseline,
    baselineReason,
    fullBatchAllUnseen,
    publisherSessionStatus: publisherSession.status,
    startupTestEligible: publisherSession.startupTestEligible,
  };
  logDiagnostic("info", "invite_new_subs_batch_classified", {
    workflow: "invite_new_subs",
    phase: "batch_classification",
    fetched: batch.subreddits.length,
    generatedAt: batch.generatedAt,
    schemaVersion: batch.schemaVersion,
    ...(batch.schemaVersion === 2
      ? {
          publisherSessionId: batch.publisherSessionId,
          publisherStartedAt: batch.publisherStartedAt,
        }
      : {}),
    ...classification,
  });
  await recoverInviteNewSubsFullBatchPendingEvent({
    redis,
    batch,
    baselineRecords,
    nowMs,
  });
  if (unchanged && !requiresBaseline) {
    const queueWork = await withInviteNewSubsQueue({
      redis,
      scheduler,
      nowMs,
      run: async (queue) => {
        const fullBatchQueued = await drainInviteNewSubsFullBatchTests({
          reddit,
          redis,
          messageConfig,
          queue,
          nowMs,
        });
        const startupTestResult = await runPendingInviteNewSubsStartupTest({
          reddit,
          redis,
          queue,
          messageConfig,
          publisherSession,
          nowMs,
        });
        return { fullBatchQueued, startupTestResult };
      },
    });
    const startupTestResult = queueWork?.startupTestResult;
    return completeInviteNewSubsPoll(
      {
        status: "unchanged",
        ...emptyResult,
        queued:
          (queueWork?.fullBatchQueued ?? 0) +
          (startupTestResult?.status === "queued" ? 1 : 0),
        ...startupPollResult(startupTestResult),
      },
      batch,
      classification,
    );
  }

  if (requiresBaseline) {
    await persistInviteNewSubsBaselineAtomic({
      redis,
      batch,
      batchIdentity,
      publisherSession,
      fullBatchAllUnseen,
      nowMs,
    });
    const queueWork = await withInviteNewSubsQueue({
      redis,
      scheduler,
      nowMs,
      run: async (queue) => {
        const fullBatchQueued = await drainInviteNewSubsFullBatchTests({
          reddit,
          redis,
          messageConfig,
          queue,
          nowMs,
        });
        const startupTestResult = fullBatchAllUnseen
          ? undefined
          : await runPendingInviteNewSubsStartupTest({
              reddit,
              redis,
              queue,
              messageConfig,
              publisherSession,
              nowMs,
            });
        return { fullBatchQueued, startupTestResult };
      },
    });
    const startupTestResult = queueWork?.startupTestResult;
    logDiagnostic("info", "invite_new_subs_baseline_created", {
      workflow: "invite_new_subs",
      phase: "baseline",
      baselineCount: batch.subreddits.length,
      baselineReason,
      generatedAt: batch.generatedAt,
    });
    return completeInviteNewSubsPoll(
      {
        status: "baseline",
        discovered: batch.subreddits.length,
        queued:
          (queueWork?.fullBatchQueued ?? 0) +
          (startupTestResult?.status === "queued" ? 1 : 0),
        skipped: batch.subreddits.length,
        ...startupPollResult(startupTestResult),
      },
      batch,
      classification,
    );
  }

  const queueWork = await withInviteNewSubsQueue({
    redis,
    scheduler,
    nowMs,
    run: async (queue) => {
      let queued = await drainInviteNewSubsFullBatchTests({
        reddit,
        redis,
        messageConfig,
        queue,
        nowMs,
      });
      const startupTestResult = await runPendingInviteNewSubsStartupTest({
        reddit,
        redis,
        queue,
        messageConfig,
        publisherSession,
        nowMs,
      });
      if (startupTestResult?.status === "queued") queued += 1;
      let discovered = 0;
      let skipped = 0;
      let rateLimited = 0;
      for (const candidate of [...batch.subreddits].sort(
        (left, right) =>
          left.createdUtc - right.createdUtc ||
          left.id.localeCompare(right.id, "en", { sensitivity: "base" }),
      )) {
        const reserved = await reserveInviteNewSubsRecord(
          redis,
          candidate,
          nowMs,
        );
        if (!reserved) continue;
        discovered += 1;

        if (candidate.subredditType !== "public") {
          skipped += 1;
          await updateInviteNewSubsRecord(redis, candidate.id, nowMs, {
            status: "not_public",
            isNsfw: candidate.over18,
          });
          logInviteNewSubsSkip(candidate, "not_public");
          continue;
        }

        let subreddit: Awaited<ReturnType<RedditClient["getSubredditByName"]>>;
        try {
          subreddit = await reddit.getSubredditByName(candidate.displayName);
        } catch (error) {
          // diagnostic-allow-silent: logInviteNewSubsSkip reports the lookup failure below.
          skipped += 1;
          await updateInviteNewSubsRecord(redis, candidate.id, nowMs, {
            status: "lookup_failed",
            error: errorMessage(error),
          });
          logInviteNewSubsSkip(candidate, "lookup_failed", error);
          continue;
        }

        if (subreddit.type !== "public") {
          skipped += 1;
          await updateInviteNewSubsRecord(redis, candidate.id, nowMs, {
            status: "not_public",
            isNsfw: subreddit.nsfw,
          });
          logInviteNewSubsSkip(candidate, "not_public");
          continue;
        }

        let topModerator: string | undefined;
        try {
          const moderators = await reddit
            .getModerators({ subredditName: subreddit.name, limit: 1 })
            .get(1);
          topModerator = moderators[0]?.username?.trim();
        } catch (error) {
          // diagnostic-allow-silent: logInviteNewSubsSkip reports the moderator failure below.
          skipped += 1;
          await updateInviteNewSubsRecord(redis, candidate.id, nowMs, {
            status: "lookup_failed",
            isNsfw: subreddit.nsfw,
            error: errorMessage(error),
          });
          logInviteNewSubsSkip(candidate, "moderator_lookup_failed", error);
          continue;
        }
        if (!topModerator) {
          skipped += 1;
          await updateInviteNewSubsRecord(redis, candidate.id, nowMs, {
            status: "no_moderator",
            isNsfw: subreddit.nsfw,
          });
          logInviteNewSubsSkip(candidate, "no_moderator");
          continue;
        }

        if (queue.entries.length >= inviteNewSubsMaximumQueueDepth) {
          skipped += 1;
          rateLimited += 1;
          await updateInviteNewSubsRecord(redis, candidate.id, nowMs, {
            status: "rate_limited",
            topModerator,
            isNsfw: subreddit.nsfw,
          });
          logDiagnostic("info", "invite_new_subs_candidate_rate_limited", {
            workflow: "invite_new_subs",
            phase: "queue_capacity",
            subredditId: candidate.id,
            subredditName: subreddit.name,
            createdUtc: candidate.createdUtc,
            queueCapacity: inviteNewSubsMaximumQueueDepth,
            queueDepth: queue.entries.length,
          });
          continue;
        }

        let templateSelection: InviteNewSubsTemplateSelection;
        try {
          templateSelection = await reserveInviteNewSubsTemplate(
            redis,
            messageConfig,
          );
        } catch (error) {
          // diagnostic-allow-silent: logInviteNewSubsSkip reports the template failure below.
          skipped += 1;
          await updateInviteNewSubsRecord(redis, candidate.id, nowMs, {
            status: "schedule_failed",
            topModerator,
            isNsfw: subreddit.nsfw,
            error: errorMessage(error),
          });
          logInviteNewSubsSkip(
            candidate,
            "template_selection_failed",
            error,
            "template_selection",
          );
          continue;
        }

        const job: InviteNewSubsDeliveryJob = {
          subredditId: candidate.id,
          subredditName: subreddit.name,
          topModerator,
          isNsfw: subreddit.nsfw,
          renderedMessage: renderInviteNewSubsMessage(templateSelection.body, {
            subredditName: subreddit.name,
            topModerator,
            isNsfw: subreddit.nsfw,
          }),
          templateId: templateSelection.id,
        };
        let queueResult: InviteNewSubsQueueScheduleResult;
        try {
          queueResult = await queue.schedule(job);
        } catch (error) {
          // diagnostic-allow-silent: logInviteNewSubsSkip reports the scheduler failure below.
          skipped += 1;
          await updateInviteNewSubsRecord(redis, candidate.id, nowMs, {
            status: "schedule_failed",
            topModerator,
            isNsfw: subreddit.nsfw,
            error: errorMessage(error),
          });
          logInviteNewSubsSkip(candidate, "schedule_failed", error, "schedule");
          continue;
        }
        if (queueResult.status === "full") {
          skipped += 1;
          rateLimited += 1;
          await updateInviteNewSubsRecord(redis, candidate.id, nowMs, {
            status: "rate_limited",
            topModerator,
            isNsfw: subreddit.nsfw,
          });
          continue;
        }

        queued += 1;
        await markInviteNewSubsRecordQueued(
          redis,
          candidate.id,
          nowMs,
          topModerator,
          subreddit.nsfw,
        );
        logDiagnostic("info", "invite_new_subs_delivery_queued", {
          workflow: "invite_new_subs",
          phase: "schedule",
          subredditId: candidate.id,
          subredditName: subreddit.name,
          templateId: templateSelection.id,
          templateSequence: templateSelection.sequence,
          queueEntryId: queueResult.queueEntryId,
          queuePosition: queueResult.queuePosition,
          scheduledAt: queueResult.scheduledAt.toISOString(),
        });
      }

      if (rateLimited > 0) {
        logDiagnostic("info", "invite_new_subs_queue_capacity_reached", {
          workflow: "invite_new_subs",
          phase: "queue_capacity",
          queueCapacity: inviteNewSubsMaximumQueueDepth,
          queueDepth: queue.entries.length,
          queued,
          overflowCount: rateLimited,
        });
      }
      return {
        discovered,
        queued,
        skipped,
        rateLimited,
        startupTestResult,
      };
    },
  });

  if (queueWork !== undefined) {
    await writeBatchIdentity(redis, batchIdentity, nowMs);
    await redis.set(inviteNewSubsGateStateKey, "enabled");
  }
  const processed = queueWork ?? {
    discovered: 0,
    queued: 0,
    skipped: 0,
    rateLimited: 0,
    startupTestResult: undefined,
  };
  return completeInviteNewSubsPoll(
    {
      status: "processed",
      discovered: processed.discovered,
      queued: processed.queued,
      skipped: processed.skipped,
      ...(processed.rateLimited > 0
        ? { rateLimited: processed.rateLimited }
        : {}),
      ...startupPollResult(processed.startupTestResult),
    },
    batch,
    classification,
  );
}

type InviteNewSubsPublisherSessionResolution = {
  status: InviteNewSubsPublisherSessionStatus;
  state?: InviteNewSubsPublisherSessionState;
  startupTestEligible: boolean;
};

async function resolveInviteNewSubsPublisherSession({
  redis,
  batch,
  batchIdentity,
  unseen,
  nowMs,
}: {
  redis: RedisClient;
  batch: InviteNewSubsDiscoveryBatch;
  batchIdentity: string;
  unseen: number;
  nowMs: number;
}): Promise<InviteNewSubsPublisherSessionResolution> {
  if (batch.schemaVersion === 1) {
    return { status: "legacy", startupTestEligible: false };
  }

  const key = inviteNewSubsPublisherSessionKey(batch.publisherSessionId);
  const existing = parseInviteNewSubsPublisherSessionState(
    await redis.get(key),
  );
  if (existing) {
    const initialIdentityMatch = batchIdentitiesMatch(
      existing.initialBatchIdentity,
      batchIdentity,
    );
    if (initialIdentityMatch.legacy && initialIdentityMatch.matches) {
      await writeInviteNewSubsPublisherSessionState(
        redis,
        { ...existing, initialBatchIdentity: batchIdentity, updatedAt: nowMs },
        nowMs,
      );
      logDiagnostic(
        "info",
        "invite_new_subs_legacy_session_identity_normalized",
        {
          workflow: "invite_new_subs",
          phase: "publisher_session",
          publisherSessionId: existing.sessionId,
        },
      );
      existing.initialBatchIdentity = batchIdentity;
      existing.updatedAt = nowMs;
    }
    return {
      status: existing.status,
      state: existing,
      startupTestEligible: existing.status === "pending",
    };
  }

  const eligible =
    unseen === batch.subreddits.length &&
    (batch.subreddits.length === 10 ||
      batch.subreddits.length === inviteNewSubsMaximumBatchSize);
  const claimToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  const candidate: InviteNewSubsPublisherSessionState = {
    status: eligible ? "pending" : "not_eligible",
    sessionId: batch.publisherSessionId,
    publisherStartedAt: batch.publisherStartedAt,
    ...(eligible ? { startupEventId: batch.generatedAt } : {}),
    initialBatchIdentity: batchIdentity,
    claimToken,
    updatedAt: nowMs,
  };
  const serialized = JSON.stringify(candidate);
  await redis.set(key, serialized, {
    nx: true,
    expiration: expirationDate(nowMs),
  });
  const storedValue = await redis.get(key);
  const stored = parseInviteNewSubsPublisherSessionState(storedValue);
  if (!stored) {
    throw new Error("Unable to persist PRAW publisher session state.");
  }
  const created = storedValue === serialized;
  logDiagnostic("info", "invite_new_subs_publisher_session_observed", {
    workflow: "invite_new_subs",
    phase: "publisher_session",
    publisherSessionId: batch.publisherSessionId,
    publisherStartedAt: batch.publisherStartedAt,
    publisherSessionStatus: created ? "new" : stored.status,
    startupTestEligible: stored.status === "pending",
    initialUnseen: unseen,
  });
  return {
    status: created ? "new" : stored.status,
    state: stored,
    startupTestEligible: stored.status === "pending",
  };
}

async function runPendingInviteNewSubsStartupTest({
  reddit,
  redis,
  queue,
  messageConfig,
  publisherSession,
  nowMs,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  queue: InviteNewSubsQueueContext;
  messageConfig: InviteNewSubsMessageConfig;
  publisherSession: InviteNewSubsPublisherSessionResolution;
  nowMs: number;
}): Promise<InviteNewSubsStartupScheduleResult | undefined> {
  const state = publisherSession.state;
  if (!state || state.status !== "pending" || !state.startupEventId) {
    return undefined;
  }
  const result = await scheduleInviteNewSubsStartupTest({
    reddit,
    redis,
    queue,
    messageConfig,
    startupEventId: state.startupEventId,
    publisherSessionId: state.sessionId,
    nowMs,
  });
  if (
    result.status === "queued" ||
    (result.status === "already_scheduled" && result.confirmed)
  ) {
    await writeInviteNewSubsPublisherSessionState(
      redis,
      {
        ...state,
        status: "scheduled",
        updatedAt: nowMs,
      },
      nowMs,
    );
  }
  return result;
}

async function scheduleInviteNewSubsStartupTest({
  reddit,
  redis,
  queue,
  messageConfig,
  startupEventId,
  publisherSessionId,
  nowMs,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  queue: InviteNewSubsQueueContext;
  messageConfig: InviteNewSubsMessageConfig;
  startupEventId: string;
  publisherSessionId: string;
  nowMs: number;
}): Promise<InviteNewSubsStartupScheduleResult> {
  const markerKey = `${inviteNewSubsStartupScheduleKeyPrefix}:${encodeURIComponent(publisherSessionId)}`;
  const markerToken = `${startupEventId}:${Math.random().toString(36).slice(2)}`;
  try {
    await redis.set(markerKey, markerToken, {
      nx: true,
      expiration: expirationDate(nowMs),
    });
    const storedMarker = await redis.get(markerKey);
    if (storedMarker !== markerToken) {
      logDiagnostic("info", "invite_new_subs_startup_test_already_scheduled", {
        workflow: "invite_new_subs",
        phase: "schedule_claim",
        startupEventId,
        publisherSessionId,
      });
      return {
        status: "already_scheduled",
        confirmed: storedMarker?.startsWith("scheduled:") === true,
      };
    }
  } catch (error) {
    // diagnostic-allow-silent: the startup-test failure helper emits the structured diagnostic.
    logInviteNewSubsStartupTestFailure(
      startupEventId,
      publisherSessionId,
      "marker_unavailable",
      error,
    );
    return { status: "failed", reason: "marker_unavailable" };
  }

  logDiagnostic("info", "invite_new_subs_startup_test_started", {
    workflow: "invite_new_subs",
    phase: "schedule_claim",
    startupEventId,
    publisherSessionId,
  });

  const fail = async (
    reason: InviteNewSubsStartupFailureReason,
    error?: unknown,
    context: Record<string, unknown> = {},
  ): Promise<InviteNewSubsStartupScheduleResult> => {
    logInviteNewSubsStartupTestFailure(
      startupEventId,
      publisherSessionId,
      reason,
      error,
      context,
    );
    try {
      if ((await redis.get(markerKey)) === markerToken) {
        await redis.del(markerKey);
      }
    } catch (releaseError) {
      logDiagnostic(
        "warn",
        "invite_new_subs_startup_marker_release_failed",
        {
          workflow: "invite_new_subs",
          phase: "schedule_claim_release",
          startupEventId,
          publisherSessionId,
          failureReason: reason,
        },
        releaseError,
      );
    }
    return { status: "failed", reason };
  };

  let subreddit: Awaited<ReturnType<RedditClient["getSubredditByName"]>>;
  try {
    subreddit = await reddit.getSubredditByName(
      inviteNewSubsStartupTestSubreddit,
    );
  } catch (error) {
    // diagnostic-allow-silent: fail logs the stage and releases the scheduling marker.
    return fail("subreddit_lookup_failed", error);
  }

  logDiagnostic("info", "invite_new_subs_startup_test_subreddit_resolved", {
    workflow: "invite_new_subs",
    phase: "subreddit_lookup",
    startupEventId,
    publisherSessionId,
    subredditId: subreddit.id,
    subredditName: subreddit.name,
    subredditType: subreddit.type,
    isNsfw: subreddit.nsfw,
  });

  if (subreddit.type !== "public" && subreddit.type !== "restricted") {
    return fail("unsupported_subreddit_type", undefined, {
      subredditId: subreddit.id,
      resolvedSubredditName: subreddit.name,
      subredditType: subreddit.type,
      isNsfw: subreddit.nsfw,
    });
  }

  let topModerator: string | undefined;
  try {
    const moderators = await reddit
      .getModerators({ subredditName: subreddit.name, limit: 1 })
      .get(1);
    topModerator = moderators[0]?.username?.trim();
  } catch (error) {
    // diagnostic-allow-silent: fail logs the stage and releases the scheduling marker.
    return fail("moderator_lookup_failed", error, {
      subredditId: subreddit.id,
      resolvedSubredditName: subreddit.name,
      subredditType: subreddit.type,
    });
  }
  if (!topModerator) {
    return fail("no_moderator", undefined, {
      subredditId: subreddit.id,
      resolvedSubredditName: subreddit.name,
      subredditType: subreddit.type,
    });
  }

  logDiagnostic("info", "invite_new_subs_startup_test_moderator_resolved", {
    workflow: "invite_new_subs",
    phase: "moderator_lookup",
    startupEventId,
    publisherSessionId,
    subredditId: subreddit.id,
    subredditName: subreddit.name,
    subredditType: subreddit.type,
    topModerator,
  });

  let templateSelection: InviteNewSubsTemplateSelection;
  try {
    templateSelection = await reserveInviteNewSubsTemplate(
      redis,
      messageConfig,
    );
  } catch (error) {
    // diagnostic-allow-silent: fail logs the template-selection stage and releases the startup marker.
    return fail("template_selection_failed", error, {
      subredditId: subreddit.id,
      resolvedSubredditName: subreddit.name,
      subredditType: subreddit.type,
      topModerator,
    });
  }

  const job: InviteNewSubsDeliveryJob = {
    subredditId: subreddit.id as SubredditId,
    subredditName: subreddit.name,
    topModerator,
    isNsfw: subreddit.nsfw,
    renderedMessage: renderInviteNewSubsMessage(templateSelection.body, {
      subredditName: subreddit.name,
      topModerator,
      isNsfw: subreddit.nsfw,
    }),
    templateId: templateSelection.id,
    deliveryKind: "startup_test",
    startupSessionId: publisherSessionId,
  };
  let queueResult: InviteNewSubsQueueScheduleResult;
  try {
    queueResult = await queue.schedule(job);
  } catch (error) {
    // diagnostic-allow-silent: fail logs the stage and releases the scheduling marker.
    return fail("schedule_failed", error, {
      subredditId: subreddit.id,
      resolvedSubredditName: subreddit.name,
      subredditType: subreddit.type,
      topModerator,
    });
  }
  if (queueResult.status === "full") {
    return fail("queue_full", undefined, {
      subredditId: subreddit.id,
      resolvedSubredditName: subreddit.name,
      subredditType: subreddit.type,
      topModerator,
    });
  }

  logDiagnostic("info", "invite_new_subs_startup_test_queued", {
    workflow: "invite_new_subs",
    phase: "schedule",
    startupEventId,
    publisherSessionId,
    subredditId: subreddit.id,
    subredditName: subreddit.name,
    subredditType: subreddit.type,
    recipientUsername: normalizeRedditUsername(topModerator).toLowerCase(),
    templateId: templateSelection.id,
    templateSequence: templateSelection.sequence,
    queueEntryId: queueResult.queueEntryId,
    queuePosition: queueResult.queuePosition,
    scheduledAt: queueResult.scheduledAt.toISOString(),
  });
  try {
    await redis.set(markerKey, `scheduled:${startupEventId}`, {
      expiration: expirationDate(nowMs),
    });
  } catch (error) {
    logDiagnostic(
      "warn",
      "invite_new_subs_startup_marker_finalize_failed",
      {
        workflow: "invite_new_subs",
        phase: "schedule_claim_finalize",
        startupEventId,
        publisherSessionId,
      },
      error,
    );
  }
  return { status: "queued" };
}

function logInviteNewSubsStartupTestFailure(
  startupEventId: string,
  publisherSessionId: string,
  reason: InviteNewSubsStartupFailureReason,
  error?: unknown,
  context: Record<string, unknown> = {},
): void {
  logDiagnostic(
    "warn",
    "invite_new_subs_startup_test_failed",
    {
      workflow: "invite_new_subs",
      phase: "schedule",
      startupEventId,
      publisherSessionId,
      subredditName: inviteNewSubsStartupTestSubreddit,
      reason,
      ...context,
    },
    error,
  );
}

async function drainInviteNewSubsFullBatchTests({
  reddit,
  redis,
  messageConfig,
  queue,
  nowMs,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  messageConfig: InviteNewSubsMessageConfig;
  queue: InviteNewSubsQueueContext;
  nowMs: number;
}): Promise<number> {
  const pending = await redis.zRange(inviteNewSubsFullBatchPendingKey, 0, -1);
  let queued = 0;
  for (const entry of pending) {
    const event = parseInviteNewSubsFullBatchEvent(entry.member);
    if (!event) {
      await redis.zRem(inviteNewSubsFullBatchPendingKey, [entry.member]);
      continue;
    }
    const markerKey = `${inviteNewSubsFullBatchMarkerKeyPrefix}:${encodeURIComponent(event.signature)}`;
    const marker = await redis.get(markerKey);
    if (
      marker?.startsWith("scheduled:") ||
      marker?.startsWith("delivered:") ||
      marker?.startsWith("failed:")
    ) {
      await redis.zRem(inviteNewSubsFullBatchPendingKey, [entry.member]);
      logDiagnostic(
        "info",
        "invite_new_subs_full_batch_test_already_scheduled",
        {
          workflow: "invite_new_subs",
          phase: "full_batch_alert",
          fullBatchEventId: event.eventId,
          fullBatchTestStatus: marker.split(":", 1)[0],
        },
      );
      continue;
    }
    if (queue.entries.length >= inviteNewSubsMaximumQueueDepth) {
      logDiagnostic("info", "invite_new_subs_full_batch_test_pending", {
        workflow: "invite_new_subs",
        phase: "queue_capacity",
        fullBatchEventId: event.eventId,
        fullBatchTestStatus: "pending",
        reason: "queue_full",
        queueCapacity: inviteNewSubsMaximumQueueDepth,
        queueDepth: queue.entries.length,
      });
      break;
    }

    let subreddit: Awaited<ReturnType<RedditClient["getSubredditByName"]>>;
    try {
      subreddit = await reddit.getSubredditByName(
        inviteNewSubsStartupTestSubreddit,
      );
    } catch (error) {
      logDiagnostic(
        "warn",
        "invite_new_subs_full_batch_test_failed",
        {
          workflow: "invite_new_subs",
          phase: "subreddit_lookup",
          fullBatchEventId: event.eventId,
          reason: "subreddit_lookup_failed",
        },
        error,
      );
      continue;
    }
    if (subreddit.type !== "public" && subreddit.type !== "restricted") {
      logDiagnostic("warn", "invite_new_subs_full_batch_test_failed", {
        workflow: "invite_new_subs",
        phase: "subreddit_lookup",
        fullBatchEventId: event.eventId,
        subredditType: subreddit.type,
        reason: "unsupported_subreddit_type",
      });
      continue;
    }
    let topModerator: string | undefined;
    try {
      const moderators = await reddit
        .getModerators({ subredditName: subreddit.name, limit: 1 })
        .get(1);
      topModerator = moderators[0]?.username?.trim();
    } catch (error) {
      logDiagnostic(
        "warn",
        "invite_new_subs_full_batch_test_failed",
        {
          workflow: "invite_new_subs",
          phase: "moderator_lookup",
          fullBatchEventId: event.eventId,
          reason: "moderator_lookup_failed",
        },
        error,
      );
      continue;
    }
    if (!topModerator) {
      logDiagnostic("warn", "invite_new_subs_full_batch_test_failed", {
        workflow: "invite_new_subs",
        phase: "moderator_lookup",
        fullBatchEventId: event.eventId,
        reason: "no_moderator",
      });
      continue;
    }
    let templateSelection: InviteNewSubsTemplateSelection;
    try {
      templateSelection = await reserveInviteNewSubsTemplate(
        redis,
        messageConfig,
      );
    } catch (error) {
      logDiagnostic(
        "warn",
        "invite_new_subs_full_batch_test_failed",
        {
          workflow: "invite_new_subs",
          phase: "template_selection",
          fullBatchEventId: event.eventId,
          reason: "template_selection_failed",
        },
        error,
      );
      continue;
    }
    const job: InviteNewSubsDeliveryJob = {
      subredditId: subreddit.id as SubredditId,
      subredditName: subreddit.name,
      topModerator,
      isNsfw: subreddit.nsfw,
      renderedMessage: renderInviteNewSubsMessage(templateSelection.body, {
        subredditName: subreddit.name,
        topModerator,
        isNsfw: subreddit.nsfw,
      }),
      templateId: templateSelection.id,
      deliveryKind: "full_batch_test",
      fullBatchEventId: event.eventId,
      fullBatchSignature: event.signature,
    };
    let queueResult: InviteNewSubsQueueScheduleResult;
    try {
      queueResult = await queue.schedule(job);
    } catch (error) {
      logDiagnostic(
        "warn",
        "invite_new_subs_full_batch_test_failed",
        {
          workflow: "invite_new_subs",
          phase: "schedule",
          fullBatchEventId: event.eventId,
          reason: "schedule_failed",
        },
        error,
      );
      continue;
    }
    if (queueResult.status === "full") {
      logDiagnostic("info", "invite_new_subs_full_batch_test_pending", {
        workflow: "invite_new_subs",
        phase: "queue_capacity",
        fullBatchEventId: event.eventId,
        fullBatchTestStatus: "pending",
        reason: "queue_full",
        queueCapacity: inviteNewSubsMaximumQueueDepth,
        queueDepth: queue.entries.length,
      });
      break;
    }
    queued += 1;
    await markInviteNewSubsFullBatchScheduled(redis, event, nowMs);
    await redis.zRem(inviteNewSubsFullBatchPendingKey, [entry.member]);
    logDiagnostic("info", "invite_new_subs_full_batch_test_queued", {
      workflow: "invite_new_subs",
      phase: "schedule",
      fullBatchEventId: event.eventId,
      subredditId: subreddit.id,
      subredditName: subreddit.name,
      recipientUsername: normalizeRedditUsername(topModerator).toLowerCase(),
      templateId: templateSelection.id,
      templateSequence: templateSelection.sequence,
      queueEntryId: queueResult.queueEntryId,
      queuePosition: queueResult.queuePosition,
      scheduledAt: queueResult.scheduledAt.toISOString(),
    });
  }
  return queued;
}

export async function processInviteNewSubsDelivery({
  reddit,
  redis,
  job,
  now = Date.now,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  job: unknown;
  now?: () => number;
}): Promise<InviteNewSubsDeliveryResult> {
  if (!isInviteNewSubsDeliveryJob(job)) {
    if (
      isRecord(job) &&
      typeof job.queueEntryId === "string" &&
      /^[a-z0-9:._-]+$/i.test(job.queueEntryId)
    ) {
      try {
        await redis.zRem(inviteNewSubsQueueKey, [job.queueEntryId]);
        logDiagnostic("info", "invite_new_subs_invalid_queue_entry_released", {
          workflow: "invite_new_subs",
          phase: "queue_completion",
          queueEntryId: job.queueEntryId,
          terminalResult: "invalid",
        });
      } catch (error) {
        logDiagnostic(
          "warn",
          "invite_new_subs_queue_entry_release_failed",
          {
            workflow: "invite_new_subs",
            phase: "queue_completion",
            queueEntryId: job.queueEntryId,
            terminalResult: "invalid",
          },
          error,
        );
      }
    }
    return "invalid";
  }

  try {
    const nowMs = now();
    const isDiagnosticTest =
      job.deliveryKind === "overload_test" ||
      job.deliveryKind === "startup_test" ||
      job.deliveryKind === "full_batch_test";
    const claimKey =
      job.deliveryKind === "overload_test"
        ? `${inviteNewSubsOverloadDeliveryClaimKeyPrefix}:${encodeURIComponent(job.overloadEventId!)}`
        : job.deliveryKind === "startup_test"
          ? `${inviteNewSubsStartupDeliveryClaimKeyPrefix}:${encodeURIComponent(job.startupSessionId!)}`
          : job.deliveryKind === "full_batch_test"
            ? `${inviteNewSubsOverloadDeliveryClaimKeyPrefix}:full_batch:${encodeURIComponent(job.fullBatchSignature!)}`
            : `${inviteNewSubsDeliveryClaimKeyPrefix}:${job.subredditId.toLowerCase()}`;
    const claimToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
    await redis.set(claimKey, claimToken, {
      nx: true,
      expiration: expirationDate(nowMs),
    });
    if ((await redis.get(claimKey)) !== claimToken) return "duplicate";

    const recipient = normalizeRedditUsername(job.topModerator);
    if (!isDiagnosticTest) {
      const recipientCooldownKey = inviteNewSubsRecipientCooldownKey(recipient);
      const recipientClaim = JSON.stringify({
        token: `${nowMs}:${Math.random().toString(36).slice(2)}`,
        username: recipient.toLowerCase(),
        subredditId: job.subredditId,
        claimedAt: nowMs,
      });
      await redis.set(recipientCooldownKey, recipientClaim, {
        nx: true,
        expiration: recipientCooldownExpirationDate(nowMs),
      });
      if ((await redis.get(recipientCooldownKey)) !== recipientClaim) {
        await updateInviteNewSubsRecord(redis, job.subredditId, nowMs, {
          status: "cooldown_suppressed",
          topModerator: job.topModerator,
          isNsfw: job.isNsfw,
        });
        logDiagnostic("info", "invite_new_subs_recipient_cooldown_suppressed", {
          workflow: "invite_new_subs",
          phase: "delivery",
          subredditId: job.subredditId,
          subredditName: job.subredditName,
          recipientUsername: recipient.toLowerCase(),
        });
        return "recipient_cooldown";
      }
    }

    let deliveryError: unknown;
    try {
      await reddit.sendPrivateMessage({
        to: recipient,
        subject: inviteNewSubsSubject,
        text: job.renderedMessage,
      });
    } catch (error) {
      // diagnostic-allow-silent: the failure is persisted and reported after metrics recording below.
      deliveryError = error;
    }

    const completedAt = now();
    await recordInviteNewSubsDeliveryMetric({
      redis,
      eventId: claimToken,
      outcome: deliveryError === undefined ? "success" : "failure",
      completedAt,
    });

    if (deliveryError === undefined) {
      await recordInviteNewSubsFullBatchDeliveryState(
        redis,
        job,
        "delivered",
        completedAt,
      );
      if (!isDiagnosticTest) {
        try {
          await updateInviteNewSubsRecord(redis, job.subredditId, completedAt, {
            status: "messaged",
            topModerator: job.topModerator,
            isNsfw: job.isNsfw,
          });
        } catch (error) {
          logDiagnostic(
            "warn",
            "invite_new_subs_delivery_state_write_failed",
            {
              workflow: "invite_new_subs",
              phase: "delivery_persistence",
              subredditId: job.subredditId,
              subredditName: job.subredditName,
              deliveryOutcome: "success",
            },
            error,
          );
        }
      }
      logDiagnostic("info", "invite_new_subs_dm_sent", {
        workflow: "invite_new_subs",
        phase: "delivery",
        subredditId: job.subredditId,
        subredditName: job.subredditName,
        recipientUsername: recipient,
        deliveryKind: job.deliveryKind ?? "standard",
        ...(job.templateId ? { templateId: job.templateId } : {}),
      });
      return "messaged";
    }

    if (!isDiagnosticTest) {
      try {
        await updateInviteNewSubsRecord(redis, job.subredditId, completedAt, {
          status: "dm_failed",
          topModerator: job.topModerator,
          isNsfw: job.isNsfw,
          error: errorMessage(deliveryError),
        });
      } catch (error) {
        logDiagnostic(
          "warn",
          "invite_new_subs_delivery_state_write_failed",
          {
            workflow: "invite_new_subs",
            phase: "delivery_persistence",
            subredditId: job.subredditId,
            subredditName: job.subredditName,
            deliveryOutcome: "failure",
          },
          error,
        );
      }
    }
    await recordInviteNewSubsFullBatchDeliveryState(
      redis,
      job,
      "failed",
      completedAt,
    );
    logDiagnostic(
      "warn",
      "invite_new_subs_dm_failed",
      {
        workflow: "invite_new_subs",
        phase: "delivery",
        subredditId: job.subredditId,
        subredditName: job.subredditName,
        deliveryKind: job.deliveryKind ?? "standard",
        ...(job.templateId ? { templateId: job.templateId } : {}),
      },
      deliveryError,
    );
    return "dm_failed";
  } finally {
    if (job.queueEntryId) {
      try {
        await redis.zRem(inviteNewSubsQueueKey, [job.queueEntryId]);
        logDiagnostic("info", "invite_new_subs_queue_entry_released", {
          workflow: "invite_new_subs",
          phase: "queue_completion",
          queueEntryId: job.queueEntryId,
          subredditId: job.subredditId,
          subredditName: job.subredditName,
        });
      } catch (error) {
        logDiagnostic(
          "warn",
          "invite_new_subs_queue_entry_release_failed",
          {
            workflow: "invite_new_subs",
            phase: "queue_completion",
            queueEntryId: job.queueEntryId,
            subredditId: job.subredditId,
            subredditName: job.subredditName,
          },
          error,
        );
      }
    }
  }
}

export async function processInviteNewSubsReport({
  reddit,
  redis,
  subredditName = inviteNewSubsHostSubreddit,
  now = Date.now,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  subredditName?: string;
  now?: () => number;
}): Promise<InviteNewSubsReportResult> {
  const nowMs = now();
  const windowEnd =
    Math.floor(nowMs / inviteNewSubsReportWindowMs) *
    inviteNewSubsReportWindowMs;
  const windowStart = windowEnd - inviteNewSubsReportWindowMs;
  const emptyCounts = { total: 0, successful: 0, failed: 0 };

  if (!isInviteNewSubsHost(subredditName)) {
    logDiagnostic("info", "invite_new_subs_report_wrong_subreddit", {
      workflow: "invite_new_subs_report",
      phase: "host_validation",
      windowStart,
      windowEnd,
      subredditName: subredditName ?? "unknown",
    });
    return { status: "disabled", windowStart, windowEnd, ...emptyCounts };
  }

  let gateContent: string;
  try {
    const gatePage = await reddit.getWikiPage(
      inviteNewSubsHostSubreddit,
      inviteNewSubsControlWikiPage,
      { wikiVersion: inviteNewSubsWikiVersion },
    );
    if (typeof gatePage.content !== "string") {
      throw new Error("Invitation control wiki page returned no content.");
    }
    gateContent = gatePage.content.trim();
  } catch (error) {
    logDiagnostic(
      "warn",
      "invite_new_subs_report_gate_unavailable",
      {
        workflow: "invite_new_subs_report",
        phase: "gate_read",
        windowStart,
        windowEnd,
        pageName: inviteNewSubsControlWikiPage,
        wikiVersion: inviteNewSubsWikiVersion,
      },
      error,
    );
    throw error;
  }

  if (gateContent !== "enabled") {
    logDiagnostic("info", "invite_new_subs_report_disabled", {
      workflow: "invite_new_subs_report",
      phase: "gate_read",
      windowStart,
      windowEnd,
      normalizedValue: gateContent,
    });
    return { status: "disabled", windowStart, windowEnd, ...emptyCounts };
  }

  const sentKey = inviteNewSubsReportSentKey(windowEnd);
  if (await redis.get(sentKey)) {
    logInviteNewSubsReportDuplicate(windowStart, windowEnd, "sent_marker");
    return { status: "already_sent", windowStart, windowEnd, ...emptyCounts };
  }

  const lockKey = inviteNewSubsReportLockKey(windowEnd);
  const lockToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(lockKey, lockToken, {
    nx: true,
    expiration: new Date(nowMs + inviteNewSubsReportLockMs),
  });
  if ((await redis.get(lockKey)) !== lockToken) {
    logInviteNewSubsReportDuplicate(windowStart, windowEnd, "lock_busy");
    return { status: "already_sent", windowStart, windowEnd, ...emptyCounts };
  }

  try {
    if (await redis.get(sentKey)) {
      logInviteNewSubsReportDuplicate(windowStart, windowEnd, "sent_marker");
      return {
        status: "already_sent",
        windowStart,
        windowEnd,
        ...emptyCounts,
      };
    }

    const counts = await getInviteNewSubsDeliveryCounts(
      redis,
      windowStart,
      windowEnd,
      nowMs,
    );
    await reddit.sendPrivateMessage({
      to: inviteNewSubsReportRecipient,
      subject: inviteNewSubsReportSubject,
      text: renderInviteNewSubsReport({ windowStart, windowEnd, ...counts }),
    });
    await redis.set(sentKey, String(nowMs), {
      expiration: new Date(
        nowMs + inviteNewSubsReportSentRetentionSeconds * 1000,
      ),
    });
    logDiagnostic("info", "invite_new_subs_report_sent", {
      workflow: "invite_new_subs_report",
      phase: "delivery",
      windowStart,
      windowEnd,
      ...counts,
    });
    return { status: "sent", windowStart, windowEnd, ...counts };
  } catch (error) {
    logDiagnostic(
      "warn",
      "invite_new_subs_report_failed",
      {
        workflow: "invite_new_subs_report",
        phase: "delivery",
        windowStart,
        windowEnd,
      },
      error,
    );
    throw error;
  } finally {
    try {
      if ((await redis.get(lockKey)) === lockToken) await redis.del(lockKey);
    } catch (error) {
      logDiagnostic(
        "warn",
        "invite_new_subs_report_lock_release_failed",
        {
          workflow: "invite_new_subs_report",
          phase: "lock_release",
          windowStart,
          windowEnd,
        },
        error,
      );
    }
  }
}

export function parseInviteNewSubsMessageConfig(
  content: string,
): InviteNewSubsMessageConfig {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    // diagnostic-allow-silent: the poller logs the parse error with wiki revision context.
    throw new Error(
      `Invitation message configuration must be valid JSON: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(value)) {
    throw new Error("Invitation message configuration must be an object.");
  }
  if (value.schemaVersion !== inviteNewSubsMessageSchemaVersion) {
    throw new Error("Unsupported invitation message schema version.");
  }
  if (!Array.isArray(value.templates) || value.templates.length !== 5) {
    throw new Error(
      "Invitation message configuration must contain exactly five templates.",
    );
  }

  const ids = new Set<string>();
  const templates = value.templates.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`Invitation template ${index + 1} must be an object.`);
    }
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const body =
      typeof candidate.body === "string" ? candidate.body.trim() : "";
    if (!templateIdPattern.test(id)) {
      throw new Error(`Invitation template ${index + 1} has an invalid id.`);
    }
    if (ids.has(id)) {
      throw new Error(`Invitation template id ${id} is duplicated.`);
    }
    ids.add(id);
    if (!body) {
      throw new Error(`Invitation template ${id} has an empty body.`);
    }
    const placeholders = body.match(/{{[^{}]*}}/g) ?? [];
    const unsupported = placeholders.find(
      (placeholder) => !supportedTemplatePlaceholders.has(placeholder),
    );
    const withoutSupportedPlaceholders = [
      ...supportedTemplatePlaceholders,
    ].reduce((text, placeholder) => text.replaceAll(placeholder, ""), body);
    if (
      unsupported !== undefined ||
      withoutSupportedPlaceholders.includes("{{") ||
      withoutSupportedPlaceholders.includes("}}")
    ) {
      throw new Error(
        `Invitation template ${id} contains an unsupported placeholder.`,
      );
    }
    return { id, body };
  });

  return { schemaVersion: inviteNewSubsMessageSchemaVersion, templates };
}

async function reserveInviteNewSubsTemplate(
  redis: RedisClient,
  config: InviteNewSubsMessageConfig,
): Promise<InviteNewSubsTemplateSelection> {
  const sequence = await redis.incrBy(inviteNewSubsTemplateSequenceKey, 1);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("Unable to reserve the invitation template sequence.");
  }
  const template = config.templates[(sequence - 1) % config.templates.length];
  if (!template) {
    throw new Error("Unable to select an invitation message template.");
  }
  return { ...template, sequence };
}

export function parseInviteNewSubsDiscoveryBatch(
  content: string,
): InviteNewSubsDiscoveryBatch {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    // diagnostic-allow-silent: the caller reports this validation failure with page context.
    throw new Error("Discovery wiki content is not valid JSON.");
  }
  if (!isRecord(value)) throw new Error("Discovery data must be an object.");
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    throw new Error("Discovery data has an unsupported schema version.");
  }
  if (value.source !== inviteNewSubsSource) {
    throw new Error("Discovery data has an unsupported source.");
  }
  if (
    typeof value.generatedAt !== "string" ||
    !utcIsoPattern.test(value.generatedAt) ||
    !Number.isFinite(Date.parse(value.generatedAt))
  ) {
    throw new Error("Discovery data has an invalid generatedAt timestamp.");
  }
  if (value.schemaVersion === 2) {
    if (
      typeof value.publisherSessionId !== "string" ||
      !publisherSessionIdPattern.test(value.publisherSessionId)
    ) {
      throw new Error("Discovery data has an invalid publisherSessionId.");
    }
    if (
      typeof value.publisherStartedAt !== "string" ||
      !utcIsoPattern.test(value.publisherStartedAt) ||
      !Number.isFinite(Date.parse(value.publisherStartedAt)) ||
      Date.parse(value.publisherStartedAt) > Date.parse(value.generatedAt)
    ) {
      throw new Error(
        "Discovery data has an invalid publisherStartedAt timestamp.",
      );
    }
  }
  if (
    !Array.isArray(value.subreddits) ||
    value.subreddits.length === 0 ||
    value.subreddits.length > inviteNewSubsMaximumBatchSize
  ) {
    throw new Error("Discovery data must contain between 1 and 25 subreddits.");
  }

  const seenIds = new Set<string>();
  const subreddits = value.subreddits.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`Discovery subreddit ${index} must be an object.`);
    }
    const id = candidate.id;
    const displayName = candidate.displayName;
    const subredditType = candidate.subredditType;
    const over18 = candidate.over18;
    const subscribers = candidate.subscribers;
    const createdUtc = candidate.createdUtc;
    const url = candidate.url;
    if (typeof id !== "string" || !subredditIdPattern.test(id)) {
      throw new Error(`Discovery subreddit ${index} has an invalid ID.`);
    }
    const normalizedId = id.toLowerCase();
    if (seenIds.has(normalizedId)) {
      throw new Error("Discovery data contains duplicate subreddit IDs.");
    }
    seenIds.add(normalizedId);
    if (
      typeof displayName !== "string" ||
      !displayNamePattern.test(displayName)
    ) {
      throw new Error(`Discovery subreddit ${id} has an invalid display name.`);
    }
    if (typeof subredditType !== "string" || !subredditType.trim()) {
      throw new Error(`Discovery subreddit ${id} has an invalid type.`);
    }
    if (typeof over18 !== "boolean") {
      throw new Error(`Discovery subreddit ${id} has an invalid over18 value.`);
    }
    if (!Number.isInteger(subscribers) || (subscribers as number) < 0) {
      throw new Error(`Discovery subreddit ${id} has invalid subscribers.`);
    }
    if (
      typeof createdUtc !== "number" ||
      !Number.isFinite(createdUtc) ||
      createdUtc < 0
    ) {
      throw new Error(`Discovery subreddit ${id} has an invalid createdUtc.`);
    }
    if (url !== `/r/${displayName}/`) {
      throw new Error(`Discovery subreddit ${id} has an invalid URL.`);
    }
    return {
      id: id as SubredditId,
      displayName,
      subredditType: subredditType.trim(),
      over18,
      subscribers: subscribers as number,
      createdUtc,
      url,
    };
  });

  const common: InviteNewSubsDiscoveryBatchBase = {
    source: inviteNewSubsSource,
    generatedAt: value.generatedAt,
    subreddits,
  };
  return value.schemaVersion === 2
    ? {
        schemaVersion: 2,
        ...common,
        publisherSessionId: value.publisherSessionId as string,
        publisherStartedAt: value.publisherStartedAt as string,
      }
    : { schemaVersion: 1, ...common };
}

export function isInviteNewSubsDeliveryJob(
  value: unknown,
): value is InviteNewSubsDeliveryJob {
  if (!isRecord(value)) return false;
  const hasValidDeliveryIdentity =
    (value.deliveryKind === undefined &&
      value.overloadEventId === undefined &&
      value.startupSessionId === undefined &&
      value.fullBatchEventId === undefined &&
      value.fullBatchSignature === undefined) ||
    (value.deliveryKind === "overload_test" &&
      typeof value.overloadEventId === "string" &&
      utcIsoPattern.test(value.overloadEventId) &&
      Number.isFinite(Date.parse(value.overloadEventId)) &&
      value.startupSessionId === undefined &&
      value.fullBatchEventId === undefined &&
      value.fullBatchSignature === undefined) ||
    (value.deliveryKind === "startup_test" &&
      typeof value.startupSessionId === "string" &&
      publisherSessionIdPattern.test(value.startupSessionId) &&
      value.overloadEventId === undefined &&
      value.fullBatchEventId === undefined &&
      value.fullBatchSignature === undefined) ||
    (value.deliveryKind === "full_batch_test" &&
      typeof value.fullBatchEventId === "string" &&
      utcIsoPattern.test(value.fullBatchEventId) &&
      Number.isFinite(Date.parse(value.fullBatchEventId)) &&
      typeof value.fullBatchSignature === "string" &&
      isInviteNewSubsFullBatchSignature(value.fullBatchSignature) &&
      value.overloadEventId === undefined &&
      value.startupSessionId === undefined);
  return (
    hasValidDeliveryIdentity &&
    (value.queueEntryId === undefined ||
      (typeof value.queueEntryId === "string" &&
        /^[a-z0-9:._-]+$/i.test(value.queueEntryId))) &&
    (value.templateId === undefined ||
      (typeof value.templateId === "string" &&
        templateIdPattern.test(value.templateId))) &&
    typeof value.subredditId === "string" &&
    subredditIdPattern.test(value.subredditId) &&
    typeof value.subredditName === "string" &&
    normalizeSubredditName(value.subredditName).length > 0 &&
    typeof value.topModerator === "string" &&
    normalizeRedditUsername(value.topModerator).length > 0 &&
    typeof value.isNsfw === "boolean" &&
    typeof value.renderedMessage === "string" &&
    value.renderedMessage.trim().length > 0
  );
}

export function renderInviteNewSubsMessage(
  template: string,
  data: Pick<
    InviteNewSubsDeliveryJob,
    "subredditName" | "topModerator" | "isNsfw"
  >,
): string {
  return template
    .replaceAll("{{subredditName}}", data.subredditName)
    .replaceAll("{{topModerator}}", data.topModerator)
    .replaceAll("{{isNsfw}}", data.isNsfw ? "yes" : "no");
}

function createBatchIdentity(batch: InviteNewSubsDiscoveryBatch): string {
  const identity: InviteNewSubsBatchIdentity = {
    version: 2,
    schemaVersion: batch.schemaVersion,
    publisherSessionId:
      batch.schemaVersion === 2 ? batch.publisherSessionId : "legacy",
    orderedSubredditIds: batch.subreddits.map((candidate) =>
      candidate.id.toLowerCase(),
    ),
  };
  return JSON.stringify(identity);
}

function parseBatchIdentity(value: string): {
  identity?: InviteNewSubsBatchIdentity;
  legacy: boolean;
} {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      isRecord(parsed) &&
      parsed.version === 2 &&
      (parsed.schemaVersion === 1 || parsed.schemaVersion === 2) &&
      typeof parsed.publisherSessionId === "string" &&
      Array.isArray(parsed.orderedSubredditIds) &&
      parsed.orderedSubredditIds.length > 0 &&
      parsed.orderedSubredditIds.every(
        (id) => typeof id === "string" && subredditIdPattern.test(id),
      )
    ) {
      return {
        identity: parsed as InviteNewSubsBatchIdentity,
        legacy: false,
      };
    }
    if (
      Array.isArray(parsed) &&
      (parsed[0] === 1 || parsed[0] === 2) &&
      typeof parsed[1] === "string" &&
      typeof parsed[2] === "string" &&
      parsed.length > 3 &&
      parsed
        .slice(3)
        .every((id) => typeof id === "string" && subredditIdPattern.test(id))
    ) {
      return {
        identity: {
          version: 2,
          schemaVersion: parsed[0],
          publisherSessionId: parsed[1],
          orderedSubredditIds: parsed.slice(3) as string[],
        },
        legacy: true,
      };
    }
  } catch {
    // diagnostic-allow-silent: an invalid cached identity cannot match a batch.
  }
  return { legacy: false };
}

function batchIdentitiesMatch(
  left: string | undefined,
  right: string,
): { matches: boolean; legacy: boolean } {
  if (!left) return { matches: false, legacy: false };
  const parsedLeft = parseBatchIdentity(left);
  const parsedRight = parseBatchIdentity(right);
  return {
    matches:
      parsedLeft.identity !== undefined &&
      parsedRight.identity !== undefined &&
      JSON.stringify(parsedLeft.identity) ===
        JSON.stringify(parsedRight.identity),
    legacy: parsedLeft.legacy,
  };
}

function classifyInviteNewSubsFreshness(
  batch: InviteNewSubsDiscoveryBatch,
): Pick<
  InviteNewSubsBatchClassification,
  "createdLast60Seconds" | "newestAgeSeconds" | "oldestAgeSeconds"
> {
  const generatedAtSeconds = Date.parse(batch.generatedAt) / 1000;
  const ages = batch.subreddits.map(
    (candidate) => generatedAtSeconds - candidate.createdUtc,
  );
  return {
    createdLast60Seconds: ages.filter((age) => age >= -1 && age <= 60).length,
    newestAgeSeconds: Math.min(...ages),
    oldestAgeSeconds: Math.max(...ages),
  };
}

function startupPollResult(
  result: InviteNewSubsStartupScheduleResult | undefined,
): Pick<InviteNewSubsPollResult, "startupTestStatus" | "startupFailureReason"> {
  if (!result) return {};
  return result.status === "failed"
    ? {
        startupTestStatus: result.status,
        startupFailureReason: result.reason,
      }
    : { startupTestStatus: result.status };
}

function normalizeSubredditName(value: string): string {
  return value.trim().replace(/^r\//i, "").toLowerCase();
}

function normalizeRedditUsername(value: string): string {
  return value.trim().replace(/^u\//i, "");
}

function inviteNewSubsSeenKey(subredditId: SubredditId): string {
  return `${inviteNewSubsSeenKeyPrefix}:${subredditId.toLowerCase()}`;
}

function inviteNewSubsPublisherSessionKey(sessionId: string): string {
  return `${inviteNewSubsPublisherSessionKeyPrefix}:${encodeURIComponent(sessionId)}`;
}

function expirationDate(nowMs: number): Date {
  return new Date(nowMs + inviteNewSubsRetentionSeconds * 1000);
}

function inviteNewSubsRecipientCooldownKey(username: string): string {
  return `${inviteNewSubsRecipientCooldownKeyPrefix}:${encodeURIComponent(username.toLowerCase())}`;
}

function recipientCooldownExpirationDate(nowMs: number): Date {
  return new Date(nowMs + inviteNewSubsRecipientCooldownSeconds * 1000);
}

function inviteNewSubsReportLockKey(windowEnd: number): string {
  return `${inviteNewSubsReportLockKeyPrefix}:${windowEnd}`;
}

function inviteNewSubsReportSentKey(windowEnd: number): string {
  return `${inviteNewSubsReportSentKeyPrefix}:${windowEnd}`;
}

async function recordInviteNewSubsDeliveryMetric({
  redis,
  eventId,
  outcome,
  completedAt,
}: {
  redis: RedisClient;
  eventId: string;
  outcome: InviteNewSubsDeliveryOutcome;
  completedAt: number;
}): Promise<void> {
  const metric: InviteNewSubsDeliveryMetric = { eventId, outcome };
  try {
    await redis.zAdd(inviteNewSubsDeliveryMetricsKey, {
      member: JSON.stringify(metric),
      score: completedAt,
    });
    await redis.expire(
      inviteNewSubsDeliveryMetricsKey,
      inviteNewSubsRetentionSeconds,
    );
  } catch (error) {
    logDiagnostic(
      "warn",
      "invite_new_subs_metric_persistence_failed",
      {
        workflow: "invite_new_subs",
        phase: "delivery_metrics",
        eventId,
        outcome,
        completedAt,
      },
      error,
    );
  }
}

async function getInviteNewSubsDeliveryCounts(
  redis: RedisClient,
  windowStart: number,
  windowEnd: number,
  nowMs: number,
): Promise<{ total: number; successful: number; failed: number }> {
  const entries = await redis.zRange(inviteNewSubsDeliveryMetricsKey, 0, -1);
  let successful = 0;
  let failed = 0;
  const staleMembers: string[] = [];
  const retentionCutoff = nowMs - inviteNewSubsRetentionSeconds * 1000;

  for (const entry of entries) {
    const score = Number(entry.score);
    if (!Number.isFinite(score)) continue;
    if (score < retentionCutoff) staleMembers.push(entry.member);
    if (score < windowStart || score >= windowEnd) continue;
    const metric = parseInviteNewSubsDeliveryMetric(entry.member);
    if (metric?.outcome === "success") successful += 1;
    else if (metric?.outcome === "failure") failed += 1;
  }

  if (staleMembers.length > 0) {
    try {
      await redis.zRem(inviteNewSubsDeliveryMetricsKey, staleMembers);
    } catch (error) {
      logDiagnostic(
        "warn",
        "invite_new_subs_metric_cleanup_failed",
        {
          workflow: "invite_new_subs_report",
          phase: "metric_cleanup",
          staleCount: staleMembers.length,
        },
        error,
      );
    }
  }

  return { total: successful + failed, successful, failed };
}

function parseInviteNewSubsDeliveryMetric(
  value: string,
): InviteNewSubsDeliveryMetric | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return undefined;
    if (
      typeof parsed.eventId !== "string" ||
      (parsed.outcome !== "success" && parsed.outcome !== "failure")
    ) {
      return undefined;
    }
    return {
      eventId: parsed.eventId,
      outcome: parsed.outcome,
    };
  } catch {
    // diagnostic-allow-silent: malformed metrics are ignored by reporting.
    return undefined;
  }
}

function renderInviteNewSubsReport({
  windowStart,
  windowEnd,
  total,
  successful,
  failed,
}: {
  windowStart: number;
  windowEnd: number;
  total: number;
  successful: number;
  failed: number;
}): string {
  return [
    "New-subreddit DM report",
    "",
    `Window start: ${new Date(windowStart).toISOString()}`,
    `Window end: ${new Date(windowEnd).toISOString()}`,
    `Total attempted: ${total}`,
    `Successful: ${successful}`,
    `Failed: ${failed}`,
  ].join("\n");
}

function logInviteNewSubsReportDuplicate(
  windowStart: number,
  windowEnd: number,
  reason: "sent_marker" | "lock_busy",
): void {
  logDiagnostic("info", "invite_new_subs_report_duplicate_suppressed", {
    workflow: "invite_new_subs_report",
    phase: "idempotency",
    windowStart,
    windowEnd,
    reason,
  });
}

async function reserveInviteNewSubsRecord(
  redis: RedisClient,
  candidate: InviteNewSubsDiscoveryRecord,
  nowMs: number,
): Promise<boolean> {
  const key = inviteNewSubsSeenKey(candidate.id);
  const reservationToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  const record: InviteNewSubsRecord & { reservationToken: string } = {
    status: "processing",
    subredditId: candidate.id,
    subredditName: candidate.displayName,
    updatedAt: nowMs,
    isNsfw: candidate.over18,
    reservationToken,
  };
  const serialized = JSON.stringify(record);
  await redis.set(key, serialized, {
    nx: true,
    expiration: expirationDate(nowMs),
  });
  return (await redis.get(key)) === serialized;
}

async function writeInviteNewSubsRecord(
  redis: RedisClient,
  record: InviteNewSubsRecord,
  nowMs: number,
): Promise<void> {
  await redis.set(
    inviteNewSubsSeenKey(record.subredditId),
    JSON.stringify(record),
    {
      expiration: expirationDate(nowMs),
    },
  );
}

async function updateInviteNewSubsRecord(
  redis: RedisClient,
  subredditId: SubredditId,
  nowMs: number,
  update: Pick<InviteNewSubsRecord, "status"> &
    Partial<Pick<InviteNewSubsRecord, "topModerator" | "isNsfw" | "error">>,
): Promise<void> {
  const key = inviteNewSubsSeenKey(subredditId);
  const current = parseInviteNewSubsRecord(await redis.get(key));
  if (!current) {
    throw new Error(`Missing invite-new-subs record for ${subredditId}.`);
  }
  await writeInviteNewSubsRecord(
    redis,
    {
      status: update.status,
      subredditId,
      subredditName: current.subredditName,
      updatedAt: nowMs,
      ...(update.topModerator ? { topModerator: update.topModerator } : {}),
      ...(update.isNsfw !== undefined ? { isNsfw: update.isNsfw } : {}),
      ...(update.error ? { error: update.error } : {}),
    },
    nowMs,
  );
}

async function markInviteNewSubsRecordQueued(
  redis: RedisClient,
  subredditId: SubredditId,
  nowMs: number,
  topModerator: string,
  isNsfw: boolean,
): Promise<boolean> {
  let observedStatus: InviteNewSubsStatus | "missing" = "missing";
  const result = await compareAndSetInviteNewSubsValue({
    redis,
    key: inviteNewSubsSeenKey(subredditId),
    expiration: expirationDate(nowMs),
    createNextValue: (currentValue) => {
      const current = parseInviteNewSubsRecord(currentValue);
      observedStatus = current?.status ?? "missing";
      if (!current || current.status !== "processing") return undefined;
      const next: InviteNewSubsRecord = {
        status: "queued",
        subredditId,
        subredditName: current.subredditName,
        updatedAt: nowMs,
        topModerator,
        isNsfw,
      };
      return JSON.stringify(next);
    },
  });
  if (!result.updated) {
    logDiagnostic("info", "invite_new_subs_state_transition_skipped", {
      workflow: "invite_new_subs",
      phase: "schedule_persistence",
      subredditId,
      attemptedStatus: "queued",
      observedStatus,
      reason: "newer_state_preserved",
    });
  }
  return result.updated;
}

async function writeBatchIdentity(
  redis: RedisClient,
  identity: string,
  nowMs: number,
): Promise<void> {
  await redis.set(inviteNewSubsBatchIdentityKey, identity, {
    expiration: expirationDate(nowMs),
  });
}

async function writeInviteNewSubsPublisherSessionState(
  redis: RedisClient,
  state: InviteNewSubsPublisherSessionState,
  nowMs: number,
): Promise<void> {
  await redis.set(
    inviteNewSubsPublisherSessionKey(state.sessionId),
    JSON.stringify(state),
    { expiration: expirationDate(nowMs) },
  );
}

function parseInviteNewSubsPublisherSessionState(
  value: string | undefined,
): InviteNewSubsPublisherSessionState | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      (parsed.status !== "pending" &&
        parsed.status !== "scheduled" &&
        parsed.status !== "not_eligible") ||
      typeof parsed.sessionId !== "string" ||
      !publisherSessionIdPattern.test(parsed.sessionId) ||
      typeof parsed.publisherStartedAt !== "string" ||
      !utcIsoPattern.test(parsed.publisherStartedAt) ||
      typeof parsed.initialBatchIdentity !== "string" ||
      typeof parsed.claimToken !== "string" ||
      typeof parsed.updatedAt !== "number" ||
      (parsed.startupEventId !== undefined &&
        (typeof parsed.startupEventId !== "string" ||
          !utcIsoPattern.test(parsed.startupEventId)))
    ) {
      return undefined;
    }
    return parsed as InviteNewSubsPublisherSessionState;
  } catch {
    // diagnostic-allow-silent: malformed session state is treated as absent.
    return undefined;
  }
}

function parseInviteNewSubsRecord(
  value: string | undefined,
): InviteNewSubsRecord | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return undefined;
    if (
      typeof parsed.status !== "string" ||
      typeof parsed.subredditId !== "string" ||
      !subredditIdPattern.test(parsed.subredditId) ||
      typeof parsed.subredditName !== "string" ||
      typeof parsed.updatedAt !== "number"
    ) {
      return undefined;
    }
    return parsed as InviteNewSubsRecord;
  } catch {
    // diagnostic-allow-silent: malformed cached state is treated as absent.
    return undefined;
  }
}

function completeInviteNewSubsPoll(
  result: InviteNewSubsPollResult,
  batch?: InviteNewSubsDiscoveryBatch,
  classification?: InviteNewSubsBatchClassification,
): InviteNewSubsPollResult {
  logDiagnostic("info", "invite_new_subs_poll_completed", {
    workflow: "invite_new_subs",
    resultStatus: result.status,
    fetched: batch?.subreddits.length ?? 0,
    new: result.discovered,
    queued: result.queued,
    skipped: result.skipped,
    rateLimited: result.rateLimited ?? 0,
    ...(classification
      ? {
          batchSize: classification.batchSize,
          unseen: classification.unseen,
          allIdsAreAbsent: classification.allIdsAreAbsent,
          fullBatchAllUnseen: classification.fullBatchAllUnseen,
          createdLast60Seconds: classification.createdLast60Seconds,
          baselineReason: classification.baselineReason,
        }
      : {}),
    ...(classification
      ? {
          publisherSessionStatus: classification.publisherSessionStatus,
          startupTestEligible: classification.startupTestEligible,
        }
      : {}),
    ...(result.startupTestStatus
      ? { startupTestStatus: result.startupTestStatus }
      : {}),
    ...(result.startupFailureReason
      ? { startupFailureReason: result.startupFailureReason }
      : {}),
    ...(batch
      ? {
          generatedAt: batch.generatedAt,
          ...(batch.schemaVersion === 2
            ? {
                publisherSessionId: batch.publisherSessionId,
                publisherStartedAt: batch.publisherStartedAt,
              }
            : {}),
        }
      : {}),
  });
  return result;
}

function logInviteNewSubsSkip(
  candidate: InviteNewSubsDiscoveryRecord,
  reason: string,
  error?: unknown,
  phase = "enrichment",
): void {
  logDiagnostic(
    error ? "warn" : "info",
    "invite_new_subs_candidate_skipped",
    {
      workflow: "invite_new_subs",
      phase,
      subredditId: candidate.id,
      subredditName: candidate.displayName,
      reason,
    },
    error,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
