import { logDiagnostic } from "../../shared/diagnostics";
import type { RedditClient, RedisClient } from "../types";

export const inviteNewSubsHostSubreddit = "subscriber_goal_dev";
export const inviteNewSubsControlWikiPage = "invite-new-subs";
export const inviteNewSubsMessageWikiPage = "invite-new-subs-message";
export const inviteNewSubsDeliveryJobName = "invite-new-subs-delivery-job";
export const inviteNewSubsRecipient = "Alan-Foster";
export const inviteNewSubsSubject = "Tool for Growing your New Subreddit";
export const inviteNewSubsRetentionSeconds = 7 * 24 * 60 * 60;
export const inviteNewSubsDeliverySpacingMs = 60_000;
export const inviteNewSubsFetchTimeoutMs = 10_000;
export const inviteNewSubsListingUrl =
  "https://www.reddit.com/subreddits/new.json?limit=100&raw_json=1";

const inviteNewSubsGateStateKey = "invite_new_subs:gate_state:v1";
const inviteNewSubsSeenKeyPrefix = "invite_new_subs:seen:v1";
const inviteNewSubsDeliveryClaimKeyPrefix = "invite_new_subs:delivery_claim:v1";

export type InviteNewSubsStatus =
  | "baseline"
  | "lookup_failed"
  | "not_public"
  | "no_moderator"
  | "queued"
  | "schedule_failed"
  | "messaged"
  | "dm_failed";

export type InviteNewSubsDeliveryJob = {
  subredditName: string;
  topModerator: string;
  isNsfw: boolean;
  renderedMessage: string;
};

type InviteNewSubsRecord = {
  status: InviteNewSubsStatus;
  subredditName: string;
  updatedAt: number;
  topModerator?: string;
  isNsfw?: boolean;
  error?: string;
};

type FetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

type FetchClient = (
  input: string,
  init?: RequestInit,
) => Promise<FetchResponse>;

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
    | "listing_unavailable"
    | "baseline"
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
  fetchClient = globalThis.fetch,
  now = Date.now,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  scheduler: SchedulerRunClient;
  subredditName: string | undefined;
  fetchClient?: FetchClient;
  now?: () => number;
}): Promise<InviteNewSubsPollResult> {
  const emptyResult = { discovered: 0, queued: 0, skipped: 0 };
  if (!isInviteNewSubsHost(subredditName)) {
    return { status: "wrong_subreddit", ...emptyResult };
  }

  let controlContent: string;
  try {
    controlContent = (
      await reddit.getWikiPage(
        inviteNewSubsHostSubreddit,
        inviteNewSubsControlWikiPage,
      )
    ).content;
  } catch (error) {
    logDiagnostic(
      "warn",
      "invite_new_subs_gate_unavailable",
      { workflow: "invite_new_subs", phase: "gate_read" },
      error,
    );
    return { status: "gate_unavailable", ...emptyResult };
  }

  if (controlContent.trim() !== "enabled") {
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
      )
    ).content.trim();
    if (!template) throw new Error("Invitation message template is empty.");
  } catch (error) {
    logDiagnostic(
      "warn",
      "invite_new_subs_template_unavailable",
      { workflow: "invite_new_subs", phase: "template_read" },
      error,
    );
    return { status: "template_unavailable", ...emptyResult };
  }

  let discoveredNames: string[];
  try {
    discoveredNames = await fetchNewestSubredditNames(fetchClient);
  } catch (error) {
    logDiagnostic(
      "warn",
      "invite_new_subs_listing_unavailable",
      { workflow: "invite_new_subs", phase: "listing_fetch" },
      error,
    );
    return { status: "listing_unavailable", ...emptyResult };
  }

  const nowMs = now();
  const previousGateState = await redis.get(inviteNewSubsGateStateKey);
  if (previousGateState !== "enabled") {
    await Promise.all(
      discoveredNames.map((name) =>
        writeInviteNewSubsRecord(
          redis,
          {
            status: "baseline",
            subredditName: name,
            updatedAt: nowMs,
          },
          nowMs,
        ),
      ),
    );
    await redis.set(inviteNewSubsGateStateKey, "enabled");
    logDiagnostic("info", "invite_new_subs_baseline_created", {
      workflow: "invite_new_subs",
      phase: "baseline",
      baselineCount: discoveredNames.length,
    });
    return {
      status: "baseline",
      discovered: discoveredNames.length,
      queued: 0,
      skipped: discoveredNames.length,
    };
  }

  let discovered = 0;
  let queued = 0;
  let skipped = 0;
  for (const name of [...discoveredNames].reverse()) {
    const reserved = await reserveInviteNewSubsRecord(redis, name, nowMs);
    if (!reserved) continue;
    discovered += 1;

    let subreddit: Awaited<ReturnType<RedditClient["getSubredditByName"]>>;
    try {
      subreddit = await reddit.getSubredditByName(name);
    } catch (error) {
      skipped += 1;
      await updateInviteNewSubsRecord(redis, name, nowMs, {
        status: "lookup_failed",
        error: errorMessage(error),
      });
      logDiagnostic(
        "warn",
        "invite_new_subs_candidate_skipped",
        {
          workflow: "invite_new_subs",
          phase: "enrichment",
          subredditName: name,
          reason: "lookup_failed",
        },
        error,
      );
      continue;
    }

    if (subreddit.type !== "public") {
      skipped += 1;
      await updateInviteNewSubsRecord(redis, name, nowMs, {
        status: "not_public",
        isNsfw: subreddit.nsfw,
      });
      logInviteNewSubsSkip(name, "not_public");
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
      await updateInviteNewSubsRecord(redis, name, nowMs, {
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
          subredditName: name,
          reason: "moderator_lookup_failed",
        },
        error,
      );
      continue;
    }
    if (!topModerator) {
      skipped += 1;
      await updateInviteNewSubsRecord(redis, name, nowMs, {
        status: "no_moderator",
        isNsfw: subreddit.nsfw,
      });
      logInviteNewSubsSkip(name, "no_moderator");
      continue;
    }

    const job: InviteNewSubsDeliveryJob = {
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
      await updateInviteNewSubsRecord(redis, name, nowMs, {
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
          subredditName: name,
          reason: "schedule_failed",
        },
        error,
      );
      continue;
    }

    queued += 1;
    try {
      await updateInviteNewSubsRecord(redis, name, nowMs, {
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
          subredditName: name,
        },
        error,
      );
      throw error;
    }
    logDiagnostic("info", "invite_new_subs_delivery_queued", {
      workflow: "invite_new_subs",
      phase: "schedule",
      subredditName: subreddit.name,
      queuePosition: queued,
    });
  }

  return { status: "processed", discovered, queued, skipped };
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

  const normalizedName = normalizeSubredditName(job.subredditName);
  const nowMs = now();
  const claimKey = `${inviteNewSubsDeliveryClaimKeyPrefix}:${normalizedName}`;
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
    await updateInviteNewSubsRecord(redis, normalizedName, nowMs, {
      status: "messaged",
      topModerator: job.topModerator,
      isNsfw: job.isNsfw,
    });
    logDiagnostic("info", "invite_new_subs_dm_sent", {
      workflow: "invite_new_subs",
      phase: "delivery",
      subredditName: job.subredditName,
    });
    return "messaged";
  } catch (error) {
    await updateInviteNewSubsRecord(redis, normalizedName, nowMs, {
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
        subredditName: job.subredditName,
      },
      error,
    );
    return "dm_failed";
  }
}

export function isInviteNewSubsDeliveryJob(
  value: unknown,
): value is InviteNewSubsDeliveryJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<InviteNewSubsDeliveryJob>;
  return (
    typeof job.subredditName === "string" &&
    normalizeSubredditName(job.subredditName).length > 0 &&
    typeof job.topModerator === "string" &&
    job.topModerator.trim().length > 0 &&
    typeof job.isNsfw === "boolean" &&
    typeof job.renderedMessage === "string" &&
    job.renderedMessage.trim().length > 0
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

export async function fetchNewestSubredditNames(
  fetchClient: FetchClient = globalThis.fetch,
): Promise<string[]> {
  const response = await fetchClient(inviteNewSubsListingUrl, {
    method: "GET",
    signal: AbortSignal.timeout(inviteNewSubsFetchTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `Newest subreddits request failed with ${response.status}.`,
    );
  }
  const payload = await response.json();
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new Error("Newest subreddits response is not a listing.");
  }
  const children = payload.data.children;
  if (!Array.isArray(children)) {
    throw new Error("Newest subreddits listing has no children array.");
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const child of children) {
    if (!isRecord(child) || !isRecord(child.data)) continue;
    const displayName = child.data.display_name;
    if (typeof displayName !== "string") continue;
    const normalized = normalizeSubredditName(displayName);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    names.push(displayName.trim().replace(/^r\//i, ""));
  }
  return names;
}

function normalizeSubredditName(value: string): string {
  return value.trim().replace(/^r\//i, "").toLowerCase();
}

function inviteNewSubsSeenKey(subredditName: string): string {
  return `${inviteNewSubsSeenKeyPrefix}:${normalizeSubredditName(subredditName)}`;
}

function expirationDate(nowMs: number): Date {
  return new Date(nowMs + inviteNewSubsRetentionSeconds * 1000);
}

async function reserveInviteNewSubsRecord(
  redis: RedisClient,
  subredditName: string,
  nowMs: number,
): Promise<boolean> {
  const key = inviteNewSubsSeenKey(subredditName);
  const reservationToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  const record: InviteNewSubsRecord & { reservationToken: string } = {
    status: "lookup_failed",
    subredditName,
    updatedAt: nowMs,
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
    inviteNewSubsSeenKey(record.subredditName),
    JSON.stringify(record),
    { expiration: expirationDate(nowMs) },
  );
}

async function updateInviteNewSubsRecord(
  redis: RedisClient,
  subredditName: string,
  nowMs: number,
  update: Pick<InviteNewSubsRecord, "status"> &
    Partial<Pick<InviteNewSubsRecord, "topModerator" | "isNsfw" | "error">>,
): Promise<void> {
  const key = inviteNewSubsSeenKey(subredditName);
  const current = parseInviteNewSubsRecord(await redis.get(key));
  await writeInviteNewSubsRecord(
    redis,
    {
      status: update.status,
      subredditName: current?.subredditName ?? subredditName,
      updatedAt: nowMs,
      ...(update.topModerator ? { topModerator: update.topModerator } : {}),
      ...(update.isNsfw !== undefined ? { isNsfw: update.isNsfw } : {}),
      ...(update.error ? { error: update.error } : {}),
    },
    nowMs,
  );
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

function logInviteNewSubsSkip(
  subredditName: string,
  reason: string,
  error?: unknown,
): void {
  logDiagnostic(
    error ? "warn" : "info",
    "invite_new_subs_candidate_skipped",
    {
      workflow: "invite_new_subs",
      phase: "enrichment",
      subredditName,
      reason,
    },
    error,
  );
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
