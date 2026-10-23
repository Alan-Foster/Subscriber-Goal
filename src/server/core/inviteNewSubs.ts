import { logDiagnostic } from "../../shared/diagnostics";
import type { RedditClient, RedisClient, SubredditId } from "../types";

export const inviteNewSubsHostSubreddit = "subscriber_goal_dev";
export const inviteNewSubsControlWikiPage = "invite-new-subs";
export const inviteNewSubsMessageWikiPage = "invite-new-subs-message";
export const inviteNewSubsDataWikiPage = "invite-new-subs-data";
export const inviteNewSubsWikiVersion = "v2" as const;
export const inviteNewSubsDataWikiVersion = "v1" as const;
export const inviteNewSubsDeliveryJobName = "invite-new-subs-delivery-job";
export const inviteNewSubsReportJobName = "invite-new-subs-report-job";
export const inviteNewSubsSubject = "Tool for Growing your New Subreddit";
export const inviteNewSubsReportRecipient = "Alan-Foster";
export const inviteNewSubsReportSubject = "New Subreddit DM Report — 12 Hours";
export const inviteNewSubsRetentionSeconds = 7 * 24 * 60 * 60;
export const inviteNewSubsRecipientCooldownSeconds = 30 * 24 * 60 * 60;
export const inviteNewSubsReportWindowMs = 12 * 60 * 60 * 1000;
export const inviteNewSubsDeliverySpacingMs = 60_000;
export const inviteNewSubsSchemaVersion = 1;
export const inviteNewSubsSource = "reddit/subreddits/new";
export const inviteNewSubsMaximumBatchSize = 10;

const inviteNewSubsGateStateKey = "invite_new_subs:gate_state:v1";
const inviteNewSubsBatchIdentityKey = "invite_new_subs:batch_identity:v1";
const inviteNewSubsSeenKeyPrefix = "invite_new_subs:seen:v2";
const inviteNewSubsDeliveryClaimKeyPrefix = "invite_new_subs:delivery_claim:v2";
const inviteNewSubsRecipientCooldownKeyPrefix =
  "invite_new_subs:recipient_cooldown:v1";
const inviteNewSubsDeliveryMetricsKey = "invite_new_subs:delivery_metrics:v1";
const inviteNewSubsReportLockKeyPrefix = "invite_new_subs:report_lock:v1";
const inviteNewSubsReportSentKeyPrefix = "invite_new_subs:report_sent:v1";
const inviteNewSubsReportLockMs = 5 * 60 * 1000;
const inviteNewSubsReportSentRetentionSeconds = 30 * 24 * 60 * 60;
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
  | "cooldown_suppressed"
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

  const recipient = normalizeRedditUsername(job.topModerator);
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
    logDiagnostic("info", "invite_new_subs_dm_sent", {
      workflow: "invite_new_subs",
      phase: "delivery",
      subredditId: job.subredditId,
      subredditName: job.subredditName,
    });
    return "messaged";
  }

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
  logDiagnostic(
    "warn",
    "invite_new_subs_dm_failed",
    {
      workflow: "invite_new_subs",
      phase: "delivery",
      subredditId: job.subredditId,
      subredditName: job.subredditName,
    },
    deliveryError,
  );
  return "dm_failed";
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
  return JSON.stringify([
    batch.generatedAt,
    ...batch.subreddits.map((candidate) => candidate.id.toLowerCase()),
  ]);
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
