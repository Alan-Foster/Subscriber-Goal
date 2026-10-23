import { logDiagnostic } from "../../shared/diagnostics";
import type { RedditClient, RedisClient, SubredditId } from "../types";

export const inviteNewSubsHostSubreddit = "subscriber_goal_dev";
export const inviteNewSubsControlWikiPage = "invite-new-subs";
export const inviteNewSubsMessageWikiPage = "invite-new-subs-message";
export const inviteNewSubsDataWikiPage = "invite-new-subs-data";
export const inviteNewSubsWikiVersion = "v2" as const;
export const inviteNewSubsDataWikiVersion = "v1" as const;
export const inviteNewSubsDeliveryJobName = "invite-new-subs-delivery-job";
export const inviteNewSubsRecipient = "Alan-Foster";
export const inviteNewSubsSubject = "Tool for Growing your New Subreddit";
export const inviteNewSubsRetentionSeconds = 7 * 24 * 60 * 60;
export const inviteNewSubsDeliverySpacingMs = 60_000;
export const inviteNewSubsSchemaVersion = 1;
export const inviteNewSubsSource = "reddit/subreddits/new";
export const inviteNewSubsMaximumBatchSize = 10;

const inviteNewSubsGateStateKey = "invite_new_subs:gate_state:v1";
const inviteNewSubsBatchIdentityKey = "invite_new_subs:batch_identity:v1";
const inviteNewSubsSeenKeyPrefix = "invite_new_subs:seen:v2";
const inviteNewSubsDeliveryClaimKeyPrefix = "invite_new_subs:delivery_claim:v2";
const subredditIdPattern = /^t5_[a-z0-9]+$/i;
const displayNamePattern = /^[a-z0-9_]+$/i;
const utcIsoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export type InviteNewSubsDiscoveryRecord = {
  id: SubredditId;
  displayName: string;
  subredditType: string;
  over18: boolean;
  subscribers: number;
  createdUtc: number;
  url: string;
};

export type InviteNewSubsDiscoveryBatch = {
  schemaVersion: 1;
  source: typeof inviteNewSubsSource;
  generatedAt: string;
  subreddits: InviteNewSubsDiscoveryRecord[];
};

export type InviteNewSubsStatus =
  | "baseline"
  | "processing"
  | "lookup_failed"
  | "not_public"
  | "no_moderator"
  | "queued"
  | "schedule_failed"
  | "messaged"
  | "dm_failed";

export type InviteNewSubsDeliveryJob = {
  subredditId: SubredditId;
  subredditName: string;
  topModerator: string;
  isNsfw: boolean;
  renderedMessage: string;
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

type SchedulerRunClient = {
  runJob(job: {
    name: string;
    data: InviteNewSubsDeliveryJob;
    runAt: Date;
  }): Promise<string>;
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
};

export type InviteNewSubsDeliveryResult =
  | "invalid"
  | "duplicate"
  | "messaged"
  | "dm_failed";

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

  let template: string;
  try {
    template = (
      await reddit.getWikiPage(
        inviteNewSubsHostSubreddit,
        inviteNewSubsMessageWikiPage,
        { wikiVersion: inviteNewSubsWikiVersion },
      )
    ).content.trim();
    if (!template) throw new Error("Invitation message template is empty.");
  } catch (error) {
    logDiagnostic(
      "warn",
      "invite_new_subs_template_unavailable",
      {
        workflow: "invite_new_subs",
        phase: "template_read",
        subredditName: inviteNewSubsHostSubreddit,
        pageName: inviteNewSubsMessageWikiPage,
        wikiVersion: inviteNewSubsWikiVersion,
      },
      error,
    );
    return completeInviteNewSubsPoll({
      status: "template_unavailable",
      ...emptyResult,
    });
  }

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

  if (
    previousGateState === "enabled" &&
    previousBatchIdentity === batchIdentity
  ) {
    return completeInviteNewSubsPoll(
      { status: "unchanged", ...emptyResult },
      batch,
    );
  }

  const existingRecords = await Promise.all(
    batch.subreddits.map((candidate) =>
      redis.get(inviteNewSubsSeenKey(candidate.id)),
    ),
  );
  const allIdsAreAbsent = existingRecords.every(
    (record) => record === undefined,
  );
  const requiresBaseline = previousGateState !== "enabled" || allIdsAreAbsent;

  if (requiresBaseline) {
    await Promise.all(
      batch.subreddits.map((candidate) =>
        writeInviteNewSubsRecord(
          redis,
          {
            status: "baseline",
            subredditId: candidate.id,
            subredditName: candidate.displayName,
            updatedAt: nowMs,
            isNsfw: candidate.over18,
          },
          nowMs,
        ),
      ),
    );
    await writeBatchIdentity(redis, batchIdentity, nowMs);
    await redis.set(inviteNewSubsGateStateKey, "enabled");
    logDiagnostic("info", "invite_new_subs_baseline_created", {
      workflow: "invite_new_subs",
      phase: "baseline",
      baselineCount: batch.subreddits.length,
      generatedAt: batch.generatedAt,
    });
    return completeInviteNewSubsPoll(
      {
        status: "baseline",
        discovered: batch.subreddits.length,
        queued: 0,
        skipped: batch.subreddits.length,
      },
      batch,
    );
  }

  let discovered = 0;
  let queued = 0;
  let skipped = 0;
  for (const candidate of [...batch.subreddits].reverse()) {
    const reserved = await reserveInviteNewSubsRecord(redis, candidate, nowMs);
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
      skipped += 1;
      await updateInviteNewSubsRecord(redis, candidate.id, nowMs, {
        status: "lookup_failed",
        error: errorMessage(error),
      });
      logDiagnostic(
        "warn",
        "invite_new_subs_candidate_skipped",
        {
          workflow: "invite_new_subs",
          phase: "enrichment",
          subredditId: candidate.id,
          subredditName: candidate.displayName,
          reason: "lookup_failed",
        },
        error,
      );
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
      skipped += 1;
      await updateInviteNewSubsRecord(redis, candidate.id, nowMs, {
        status: "lookup_failed",
        isNsfw: subreddit.nsfw,
        error: errorMessage(error),
      });
      logDiagnostic(
        "warn",
        "invite_new_subs_candidate_skipped",
        {
          workflow: "invite_new_subs",
          phase: "enrichment",
          subredditId: candidate.id,
          subredditName: candidate.displayName,
          reason: "moderator_lookup_failed",
        },
        error,
      );
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

    const job: InviteNewSubsDeliveryJob = {
      subredditId: candidate.id,
      subredditName: subreddit.name,
      topModerator,
      isNsfw: subreddit.nsfw,
      renderedMessage: renderInviteNewSubsMessage(template, {
        subredditName: subreddit.name,
        topModerator,
        isNsfw: subreddit.nsfw,
      }),
    };
    try {
      await scheduler.runJob({
        name: inviteNewSubsDeliveryJobName,
        data: job,
        runAt: new Date(nowMs + queued * inviteNewSubsDeliverySpacingMs),
      });
    } catch (error) {
      skipped += 1;
      await updateInviteNewSubsRecord(redis, candidate.id, nowMs, {
        status: "schedule_failed",
        topModerator,
        isNsfw: subreddit.nsfw,
        error: errorMessage(error),
      });
      logDiagnostic(
        "warn",
        "invite_new_subs_candidate_skipped",
        {
          workflow: "invite_new_subs",
          phase: "schedule",
          subredditId: candidate.id,
          subredditName: candidate.displayName,
          reason: "schedule_failed",
        },
        error,
      );
      continue;
    }

    queued += 1;
    try {
      await updateInviteNewSubsRecord(redis, candidate.id, nowMs, {
        status: "queued",
        topModerator,
        isNsfw: subreddit.nsfw,
      });
    } catch (error) {
      logDiagnostic(
        "error",
        "invite_new_subs_queued_state_write_failed",
        {
          workflow: "invite_new_subs",
          phase: "queue_persistence",
          subredditId: candidate.id,
          subredditName: candidate.displayName,
        },
        error,
      );
      throw error;
    }
    logDiagnostic("info", "invite_new_subs_delivery_queued", {
      workflow: "invite_new_subs",
      phase: "schedule",
      subredditId: candidate.id,
      subredditName: subreddit.name,
      queuePosition: queued,
    });
  }

  await writeBatchIdentity(redis, batchIdentity, nowMs);
  await redis.set(inviteNewSubsGateStateKey, "enabled");
  return completeInviteNewSubsPoll(
    { status: "processed", discovered, queued, skipped },
    batch,
  );
}

export async function processInviteNewSubsDelivery({
  reddit,
  redis,
  job,
  now = Date.now,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  job: InviteNewSubsDeliveryJob;
  now?: () => number;
}): Promise<InviteNewSubsDeliveryResult> {
  if (!isInviteNewSubsDeliveryJob(job)) return "invalid";

  const nowMs = now();
  const claimKey = `${inviteNewSubsDeliveryClaimKeyPrefix}:${job.subredditId.toLowerCase()}`;
  const claimToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(claimKey, claimToken, {
    nx: true,
    expiration: expirationDate(nowMs),
  });
  if ((await redis.get(claimKey)) !== claimToken) return "duplicate";

  try {
    await reddit.sendPrivateMessage({
      to: inviteNewSubsRecipient,
      subject: inviteNewSubsSubject,
      text: job.renderedMessage,
    });
    await updateInviteNewSubsRecord(redis, job.subredditId, nowMs, {
      status: "messaged",
      topModerator: job.topModerator,
      isNsfw: job.isNsfw,
    });
    logDiagnostic("info", "invite_new_subs_dm_sent", {
      workflow: "invite_new_subs",
      phase: "delivery",
      subredditId: job.subredditId,
      subredditName: job.subredditName,
    });
    return "messaged";
  } catch (error) {
    await updateInviteNewSubsRecord(redis, job.subredditId, nowMs, {
      status: "dm_failed",
      topModerator: job.topModerator,
      isNsfw: job.isNsfw,
      error: errorMessage(error),
    });
    logDiagnostic(
      "warn",
      "invite_new_subs_dm_failed",
      {
        workflow: "invite_new_subs",
        phase: "delivery",
        subredditId: job.subredditId,
        subredditName: job.subredditName,
      },
      error,
    );
    return "dm_failed";
  }
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
  if (value.schemaVersion !== inviteNewSubsSchemaVersion) {
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
  if (
    !Array.isArray(value.subreddits) ||
    value.subreddits.length === 0 ||
    value.subreddits.length > inviteNewSubsMaximumBatchSize
  ) {
    throw new Error("Discovery data must contain between 1 and 10 subreddits.");
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

  return {
    schemaVersion: 1,
    source: inviteNewSubsSource,
    generatedAt: value.generatedAt,
    subreddits,
  };
}

export function isInviteNewSubsDeliveryJob(
  value: unknown,
): value is InviteNewSubsDeliveryJob {
  if (!isRecord(value)) return false;
  return (
    typeof value.subredditId === "string" &&
    subredditIdPattern.test(value.subredditId) &&
    typeof value.subredditName === "string" &&
    normalizeSubredditName(value.subredditName).length > 0 &&
    typeof value.topModerator === "string" &&
    value.topModerator.trim().length > 0 &&
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
  return JSON.stringify([
    batch.generatedAt,
    ...batch.subreddits.map((candidate) => candidate.id.toLowerCase()),
  ]);
}

function normalizeSubredditName(value: string): string {
  return value.trim().replace(/^r\//i, "").toLowerCase();
}

function inviteNewSubsSeenKey(subredditId: SubredditId): string {
  return `${inviteNewSubsSeenKeyPrefix}:${subredditId.toLowerCase()}`;
}

function expirationDate(nowMs: number): Date {
  return new Date(nowMs + inviteNewSubsRetentionSeconds * 1000);
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

async function writeBatchIdentity(
  redis: RedisClient,
  identity: string,
  nowMs: number,
): Promise<void> {
  await redis.set(inviteNewSubsBatchIdentityKey, identity, {
    expiration: expirationDate(nowMs),
  });
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
): InviteNewSubsPollResult {
  logDiagnostic("info", "invite_new_subs_poll_completed", {
    workflow: "invite_new_subs",
    resultStatus: result.status,
    fetched: batch?.subreddits.length ?? 0,
    new: result.discovered,
    queued: result.queued,
    skipped: result.skipped,
    ...(batch ? { generatedAt: batch.generatedAt } : {}),
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
