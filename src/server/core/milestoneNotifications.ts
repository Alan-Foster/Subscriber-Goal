import { notifications } from "@devvit/notifications";
import { redis, scheduler } from "@devvit/web/server";
import type { MilestoneNotificationJob } from "../../shared/types/api";
import type { LinkId } from "../types";
import { isLinkId } from "../types";
import { formatSubscriberCount } from "../../shared/numberFormat";
import { logDiagnostic } from "../../shared/diagnostics";
import { translate } from "../../shared/i18n/catalog";
import { getJobBackoffDelay } from "../jobs/backoff";
import {
  isOptionalString,
  isRecord,
  parseStoredJson,
} from "../utils/runtimeValidation";

export const MILESTONE_NOTIFICATION_DELIVERY_ENABLED = false;
export const milestoneNotificationBatchSize = 200;
export const milestoneNotificationBatchDelayMs = 1_500;
export const milestoneNotificationJobName = "milestone-notification-job";
export const milestoneNotificationDailyLimit = 25_000;
// A campaign may deliver for seven days after completion. State is retained for
// another seven days so every accepted send/debit boundary remains inspectable.
export const milestoneNotificationCampaignLifetimeMs = 7 * 86_400_000;
export const milestoneNotificationStateRetentionMs = 14 * 86_400_000;
export const milestoneNotificationClaimMs = 60_000;
export const milestoneNotificationRecoveryBatchSize = 20;
export const milestoneNotificationRecoveryKey =
  "milestone_notification_continuations_v2";
export const milestoneNotificationDailyBudgetKeyPrefix =
  "milestone_notification_daily_budget_v1";
export const milestoneNotificationDailyBudgetExpirationSeconds =
  3 * 24 * 60 * 60;

export const milestoneNotificationTitle = translate(
  "en",
  "outbound.milestone.title",
);
export const milestoneNotificationBody = translate(
  "en",
  "outbound.milestone.body",
  {
    subredditName: "{{subredditName}}",
    goalText: "{{goalText}}",
  },
);

type NotificationClient = Pick<
  typeof notifications,
  "listOptedInUsers" | "enqueue"
>;
type SchedulerClient = Pick<typeof scheduler, "runJob">;
type DailyBudgetClient = Pick<typeof redis.global, "incrBy" | "expire">;
type StateRedis = Pick<
  typeof redis,
  "get" | "set" | "watch" | "zAdd" | "zRange" | "zRem"
>;

export type MilestoneNotificationCampaignData = {
  postId: LinkId;
  completedTime: number;
  subredditName: string;
  goal: number;
  language?: string;
};

type Recipient = {
  userId: `t2_${string}`;
  link: LinkId;
  data: Record<string, string>;
};
const pagePhases = [
  "claimed",
  "prepared",
  "debit_started",
  "funded",
  "refund_started",
  "enqueue_started",
  "confirmed",
  "terminal",
  "unresolved",
] as const;
type PagePhase = (typeof pagePhases)[number];

export type MilestoneNotificationPageState = {
  version: 2;
  job: MilestoneNotificationJob;
  phase: PagePhase;
  owner?: string;
  claimUntil?: number;
  updatedAt: number;
  budgetKey?: string;
  reserved?: number;
  recipients?: Recipient[];
  pageNext?: string;
  successCount?: number;
  failureCount?: number;
  child?: MilestoneNotificationJob;
  continuation?: "pending" | "scheduled" | "terminal";
  recoveryAttempts?: number;
  nextRecoveryAt?: number;
  outcome?: string;
};

export type MilestoneNotificationBatchResult =
  | { status: "suppressed"; done: true; cursor: "" }
  | {
      status: "duplicate" | "unresolved" | "expired" | "ineligible";
      done: true;
      cursor: string;
    }
  | {
      status: "processed";
      done: boolean;
      cursor: string;
      recipients: number;
      successCount: number;
      failureCount: number;
    };

export const isMilestoneNotificationJob = (
  value: unknown,
): value is MilestoneNotificationJob => {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<MilestoneNotificationJob>;
  return (
    job.campaign === "milestone-completed" &&
    typeof job.postId === "string" &&
    isLinkId(job.postId) &&
    typeof job.completedTime === "number" &&
    Number.isSafeInteger(job.completedTime) &&
    job.completedTime > 0 &&
    typeof job.cursor === "string" &&
    typeof job.attemptedRecipients === "number" &&
    Number.isSafeInteger(job.attemptedRecipients) &&
    job.attemptedRecipients >= 0 &&
    job.attemptedRecipients <= milestoneNotificationDailyLimit
  );
};

export const milestoneNotificationDeadline = (completedTime: number): number =>
  completedTime + milestoneNotificationCampaignLifetimeMs;

export function isMilestoneCampaignEligible(
  job: MilestoneNotificationJob,
  campaign: MilestoneNotificationCampaignData,
  now: number,
): boolean {
  return (
    isMilestoneNotificationJob(job) &&
    now < milestoneNotificationDeadline(job.completedTime) &&
    campaign.postId === job.postId &&
    campaign.completedTime === job.completedTime &&
    campaign.goal > 0 &&
    campaign.subredditName.trim().length > 0
  );
}

export const renderMilestoneNotificationCopy = (input: {
  subredditName: string;
  goal: number;
  language?: string;
}): { title: string; body: string; data: Record<string, string> } => {
  const data = {
    subredditName: input.subredditName,
    goalText: formatSubscriberCount(input.goal),
  };
  const title = translate(input.language, "outbound.milestone.title");
  const body = translate(input.language, "outbound.milestone.body", data);
  if (title.length > 60 || body.length > 100)
    throw new Error("Rendered milestone notification copy exceeds limits.");
  return { title, body, data };
};

// Local Redis is installation-scoped, making installation an implicit identity component.
export const milestoneNotificationPageKey = (
  job: MilestoneNotificationJob,
): string =>
  `milestone_notification_page_v2:${job.postId}:${job.completedTime}:${encodeURIComponent(job.cursor)}`;
const stateExpiration = (job: MilestoneNotificationJob): Date =>
  new Date(job.completedTime + milestoneNotificationStateRetentionMs);

function parseState(
  value: string | undefined,
): MilestoneNotificationPageState | undefined {
  return parseStoredJson(
    value,
    isMilestoneNotificationPageState,
    { workflow: "milestone_notification", phase: "state_parse" },
    { event: "milestone_notification_state_invalid", level: "error" },
  );
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isOptionalNumber = (value: unknown): boolean =>
  value === undefined || isFiniteNumber(value);

function isMilestoneRecipient(value: unknown): value is Recipient {
  return (
    isRecord(value) &&
    typeof value.userId === "string" &&
    /^t2_[\w]+$/.test(value.userId) &&
    typeof value.link === "string" &&
    isLinkId(value.link) &&
    isRecord(value.data) &&
    Object.values(value.data).every((field) => typeof field === "string")
  );
}

function hasValidOptionalPageMetadata(state: Record<string, unknown>): boolean {
  return (
    isOptionalString(state.owner) &&
    isOptionalNumber(state.claimUntil) &&
    isOptionalString(state.budgetKey) &&
    isOptionalNumber(state.reserved) &&
    isOptionalString(state.pageNext) &&
    isOptionalNumber(state.successCount) &&
    isOptionalNumber(state.failureCount) &&
    isOptionalNumber(state.recoveryAttempts) &&
    isOptionalNumber(state.nextRecoveryAt) &&
    isOptionalString(state.outcome)
  );
}

function isMilestoneNotificationPageState(
  value: unknown,
): value is MilestoneNotificationPageState {
  return (
    isRecord(value) &&
    value.version === 2 &&
    isMilestoneNotificationJob(value.job) &&
    pagePhases.some((phase) => phase === value.phase) &&
    isFiniteNumber(value.updatedAt) &&
    hasValidOptionalPageMetadata(value) &&
    (value.recipients === undefined ||
      (Array.isArray(value.recipients) &&
        value.recipients.length <= milestoneNotificationBatchSize &&
        value.recipients.every(isMilestoneRecipient))) &&
    (value.child === undefined || isMilestoneNotificationJob(value.child)) &&
    (value.continuation === undefined ||
      value.continuation === "pending" ||
      value.continuation === "scheduled" ||
      value.continuation === "terminal")
  );
}

async function replaceState(
  client: StateRedis,
  key: string,
  expected: string | undefined,
  next: MilestoneNotificationPageState,
): Promise<boolean> {
  const tx = await client.watch(key);
  if ((await client.get(key)) !== expected) {
    await tx.discard();
    return false;
  }
  await tx.multi();
  await tx.set(key, JSON.stringify(next), {
    expiration: stateExpiration(next.job),
  });
  return (await tx.exec()).length > 0;
}

async function claimPage(
  client: StateRedis,
  job: MilestoneNotificationJob,
  now: number,
): Promise<
  { key: string; state: MilestoneNotificationPageState } | "invalid" | undefined
> {
  const key = milestoneNotificationPageKey(job);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const raw = await client.get(key);
    const old = parseState(raw);
    if (raw && !old) return "invalid";
    if (old && old.job.attemptedRecipients !== job.attemptedRecipients)
      return undefined;
    // Prepared work and a known debit are safe to resume. Uncertain debit,
    // refund, and send boundaries are deliberately never claimable again.
    if (
      old &&
      (!(["claimed", "prepared", "funded"] as PagePhase[]).includes(
        old.phase,
      ) ||
        (old.claimUntil ?? 0) > now)
    )
      return undefined;
    const state: MilestoneNotificationPageState = old
      ? {
          ...old,
          owner: crypto.randomUUID(),
          claimUntil: now + milestoneNotificationClaimMs,
          updatedAt: now,
        }
      : {
          version: 2,
          job,
          phase: "claimed",
          owner: crypto.randomUUID(),
          claimUntil: now + milestoneNotificationClaimMs,
          updatedAt: now,
        };
    if (await replaceState(client, key, raw, state)) return { key, state };
  }
  throw new Error("Could not claim milestone notification page.");
}

async function ownedTransition(
  client: StateRedis,
  key: string,
  owner: string,
  now: number,
  update: (
    state: MilestoneNotificationPageState,
  ) => MilestoneNotificationPageState,
): Promise<MilestoneNotificationPageState | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const raw = await client.get(key);
    const old = parseState(raw);
    if (!old || old.owner !== owner || (old.claimUntil ?? 0) <= now)
      return undefined;
    const next = update(old);
    if (await replaceState(client, key, raw, next)) return next;
  }
  return undefined;
}

async function saveDecision(
  client: StateRedis,
  key: string,
  owner: string,
  now: number,
  next: MilestoneNotificationPageState,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const raw = await client.get(key);
    const old = parseState(raw);
    if (!old || old.owner !== owner || (old.claimUntil ?? 0) <= now)
      return false;
    const tx = await client.watch(key);
    if ((await client.get(key)) !== raw) {
      await tx.discard();
      continue;
    }
    await tx.multi();
    await tx.set(key, JSON.stringify(next), {
      expiration: stateExpiration(next.job),
    });
    if (next.child)
      await tx.zAdd(milestoneNotificationRecoveryKey, {
        member: key,
        score: next.nextRecoveryAt ?? now,
      });
    if ((await tx.exec()).length > 0) return true;
  }
  return false;
}

export async function maybeScheduleMilestoneNotification(
  input: Omit<
    MilestoneNotificationJob,
    "campaign" | "cursor" | "attemptedRecipients"
  >,
  options: {
    deliveryEnabled?: boolean;
    schedulerClient?: SchedulerClient;
  } = {},
): Promise<"scheduled" | "suppressed"> {
  if (!(options.deliveryEnabled ?? MILESTONE_NOTIFICATION_DELIVERY_ENABLED)) {
    logDiagnostic("info", "milestone_notification_suppressed", {
      workflow: "milestone_notification",
      phase: "schedule",
      postId: input.postId,
      reason: "delivery_disabled",
    });
    return "suppressed";
  }
  await (options.schedulerClient ?? scheduler).runJob({
    name: milestoneNotificationJobName,
    data: {
      campaign: "milestone-completed",
      postId: input.postId,
      completedTime: input.completedTime,
      cursor: "",
      attemptedRecipients: 0,
    } satisfies MilestoneNotificationJob,
    runAt: new Date(),
  });
  return "scheduled";
}

type OwnedMilestonePage = {
  stateClient: StateRedis;
  key: string;
  owner: string;
  clock: () => number;
};

type PreparedMilestonePage = {
  state: MilestoneNotificationPageState;
  eligible: Recipient[];
  cursor: string;
};

type FundedMilestonePage = {
  state: MilestoneNotificationPageState;
  recipients: Recipient[];
};

type EnqueuedMilestonePage = {
  state: MilestoneNotificationPageState;
  successCount: number;
  failureCount: number;
};

export async function processMilestoneNotificationBatch(
  job: MilestoneNotificationJob,
  campaign: MilestoneNotificationCampaignData,
  options: {
    deliveryEnabled?: boolean;
    notificationClient?: NotificationClient;
    schedulerClient?: SchedulerClient;
    dailyBudgetClient?: DailyBudgetClient;
    stateClient?: StateRedis;
    now?: () => number;
  } = {},
): Promise<MilestoneNotificationBatchResult> {
  if (!(options.deliveryEnabled ?? MILESTONE_NOTIFICATION_DELIVERY_ENABLED)) {
    logDiagnostic("info", "milestone_notification_suppressed", {
      workflow: "milestone_notification",
      phase: "delivery",
      postId: job.postId,
      reason: "delivery_disabled",
    });
    return { status: "suppressed", done: true, cursor: "" };
  }
  const clock = options.now ?? Date.now;
  const now = clock();
  if (!isMilestoneCampaignEligible(job, campaign, now)) {
    return {
      status:
        now >= milestoneNotificationDeadline(job.completedTime)
          ? "expired"
          : "ineligible",
      done: true,
      cursor: job.cursor,
    };
  }
  const stateClient = options.stateClient ?? redis;
  const claimed = await claimPage(stateClient, job, now);
  if (claimed === "invalid") return stoppedPage("duplicate", job.cursor);
  if (!claimed) {
    return describeUnclaimedPage(stateClient, job);
  }
  const owner = claimed.state.owner!;
  const remaining = milestoneNotificationDailyLimit - job.attemptedRecipients;
  if (remaining <= 0) {
    await saveDecision(stateClient, claimed.key, owner, now, {
      ...claimed.state,
      phase: "terminal",
      continuation: "terminal",
      outcome: "campaign_cap",
      updatedAt: now,
    });
    return processed(true, job.cursor, 0, 0, 0);
  }
  const notificationClient = options.notificationClient ?? notifications;
  const copy = renderMilestoneNotificationCopy(campaign);
  const page = { stateClient, key: claimed.key, owner, clock };
  const prepared = await prepareMilestonePage(
    page,
    notificationClient,
    claimed.state,
    job,
    campaign,
    copy,
    remaining,
  );
  if (!prepared) return stoppedPage("duplicate", job.cursor);

  const budget = options.dailyBudgetClient ?? redis.global;
  const funded = await fundMilestonePage(page, budget, prepared);
  if (typeof funded === "string") return stoppedPage(funded, job.cursor);
  const refunded = await refundUnusedMilestoneBudget(page, budget, funded);
  if (!refunded) return stoppedPage("unresolved", job.cursor);

  const enqueued = await enqueueMilestonePage(
    page,
    notificationClient,
    refunded,
    funded.recipients,
    copy,
  );
  if (!enqueued) return stoppedPage("duplicate", job.cursor);
  return saveMilestonePageDecision(
    page,
    job,
    prepared,
    funded.recipients,
    enqueued,
    options,
  );
}

async function describeUnclaimedPage(
  stateClient: StateRedis,
  job: MilestoneNotificationJob,
): Promise<MilestoneNotificationBatchResult> {
  const phase = parseState(
    await stateClient.get(milestoneNotificationPageKey(job)),
  )?.phase;
  return {
    status:
      phase === "debit_started" ||
      phase === "refund_started" ||
      phase === "enqueue_started" ||
      phase === "unresolved"
        ? "unresolved"
        : "duplicate",
    done: true,
    cursor: job.cursor,
  };
}

function stoppedPage(
  status: "duplicate" | "unresolved",
  cursor: string,
): MilestoneNotificationBatchResult {
  return { status, done: true, cursor };
}

async function prepareMilestonePage(
  pageClaim: OwnedMilestonePage,
  notificationClient: NotificationClient,
  state: MilestoneNotificationPageState,
  job: MilestoneNotificationJob,
  campaign: MilestoneNotificationCampaignData,
  copy: ReturnType<typeof renderMilestoneNotificationCopy>,
  remaining: number,
): Promise<PreparedMilestonePage | undefined> {
  const { stateClient, key, owner, clock } = pageClaim;
  if (state.phase !== "claimed") {
    return {
      state,
      eligible: state.recipients ?? [],
      cursor: state.pageNext ?? "",
    };
  }
  const page = await notificationClient.listOptedInUsers({
    limit: Math.min(milestoneNotificationBatchSize, remaining),
    ...(job.cursor ? { after: job.cursor } : {}),
  });
  const eligible = page.userIds
    .filter((id): id is `t2_${string}` => /^t2_[\w]+$/.test(id))
    .map((userId) => ({ userId, link: campaign.postId, data: copy.data }));
  const cursor = page.next ?? "";
  const transitionNow = clock();
  const prepared = await ownedTransition(
    stateClient,
    key,
    owner,
    transitionNow,
    (old) => ({
      ...old,
      phase: "prepared",
      recipients: eligible,
      pageNext: cursor,
      updatedAt: transitionNow,
    }),
  );
  if (!prepared) return undefined;
  return { state: prepared, eligible, cursor };
}

async function fundMilestonePage(
  page: OwnedMilestonePage,
  budget: DailyBudgetClient,
  { state, eligible }: PreparedMilestonePage,
): Promise<FundedMilestonePage | "duplicate" | "unresolved"> {
  const { stateClient, key, owner, clock } = page;
  if (state.phase === "funded")
    return { state, recipients: state.recipients ?? [] };
  if (!eligible.length) return { state, recipients: eligible };

  const debitNow = clock();
  const budgetKey = `${milestoneNotificationDailyBudgetKeyPrefix}:${new Date(debitNow).toISOString().slice(0, 10)}`;
  const debitStarted = await ownedTransition(
    stateClient,
    key,
    owner,
    debitNow,
    (old) => ({
      ...old,
      phase: "debit_started",
      budgetKey,
      reserved: eligible.length,
      outcome: "debit_outcome_unresolved",
      updatedAt: debitNow,
    }),
  );
  if (!debitStarted) return "duplicate";
  let total: number;
  try {
    total = await budget.incrBy(budgetKey, eligible.length);
  } catch (error) {
    const failedAt = clock();
    await ownedTransition(stateClient, key, owner, failedAt, (old) => ({
      ...old,
      phase: "unresolved",
      outcome: "debit_uncertain",
      updatedAt: failedAt,
    }));
    throw error;
  }
  const recipients = eligible.slice(
    0,
    Math.max(0, milestoneNotificationDailyLimit - (total - eligible.length)),
  );
  const fundedAt = clock();
  const funded = await ownedTransition(
    stateClient,
    key,
    owner,
    fundedAt,
    (old) => ({
      ...old,
      phase: "funded",
      recipients,
      outcome: "debit_confirmed",
      updatedAt: fundedAt,
    }),
  );
  if (!funded) return "unresolved";
  try {
    await budget.expire(
      budgetKey,
      milestoneNotificationDailyBudgetExpirationSeconds,
    );
  } catch (error) {
    logDiagnostic(
      "warn",
      "milestone_notification_budget_ttl_failed",
      { workflow: "milestone_notification", budgetKey },
      error,
    );
  }
  return { state: funded, recipients };
}

async function refundUnusedMilestoneBudget(
  page: OwnedMilestonePage,
  budget: DailyBudgetClient,
  { state, recipients }: FundedMilestonePage,
): Promise<MilestoneNotificationPageState | undefined> {
  const { stateClient, key, owner, clock } = page;
  const refund = (state.reserved ?? recipients.length) - recipients.length;
  if (
    state.phase !== "funded" ||
    state.outcome !== "debit_confirmed" ||
    !(refund > 0)
  ) {
    return state;
  }
  const budgetKey = state.budgetKey;
  if (!budgetKey) {
    return undefined;
  }
  const refundAt = clock();
  const refundStarted = await ownedTransition(
    stateClient,
    key,
    owner,
    refundAt,
    (old) => ({
      ...old,
      phase: "refund_started",
      recipients,
      outcome: "refund_outcome_unresolved",
      updatedAt: refundAt,
    }),
  );
  if (!refundStarted) return undefined;
  try {
    await budget.incrBy(budgetKey, -refund);
  } catch (error) {
    const failedAt = clock();
    await ownedTransition(stateClient, key, owner, failedAt, (old) => ({
      ...old,
      phase: "unresolved",
      outcome: "refund_uncertain",
      updatedAt: failedAt,
    }));
    throw error;
  }
  const refundedAt = clock();
  return ownedTransition(stateClient, key, owner, refundedAt, (old) => ({
    ...old,
    phase: "funded",
    recipients,
    outcome: "refund_confirmed",
    updatedAt: refundedAt,
  }));
}

async function enqueueMilestonePage(
  page: OwnedMilestonePage,
  notificationClient: NotificationClient,
  state: MilestoneNotificationPageState,
  recipients: Recipient[],
  copy: ReturnType<typeof renderMilestoneNotificationCopy>,
): Promise<EnqueuedMilestonePage | undefined> {
  const { stateClient, key, owner, clock } = page;
  let successCount = 0;
  let failureCount = 0;
  if (recipients.length) {
    const sendAt = clock();
    const nextState = await ownedTransition(
      stateClient,
      key,
      owner,
      sendAt,
      (old) => ({
        ...old,
        phase: "enqueue_started",
        recipients,
        outcome: "enqueue_outcome_unresolved",
        updatedAt: sendAt,
      }),
    );
    if (!nextState) return undefined;
    state = nextState;
    const result = await notificationClient.enqueue({
      title: copy.title,
      body: copy.body,
      recipients,
    });
    successCount = result.successCount;
    failureCount = result.failureCount;
  }
  return { state, successCount, failureCount };
}

async function saveMilestonePageDecision(
  page: OwnedMilestonePage,
  job: MilestoneNotificationJob,
  { cursor, eligible }: PreparedMilestonePage,
  recipients: Recipient[],
  { state, successCount, failureCount }: EnqueuedMilestonePage,
  options: { schedulerClient?: SchedulerClient },
): Promise<MilestoneNotificationBatchResult> {
  const { stateClient, key, owner, clock } = page;
  const attemptedRecipients = job.attemptedRecipients + recipients.length;
  const done =
    !cursor ||
    attemptedRecipients >= milestoneNotificationDailyLimit ||
    recipients.length < (state.reserved ?? eligible.length);
  const child: MilestoneNotificationJob | undefined = done
    ? undefined
    : { ...job, cursor, attemptedRecipients };
  const decisionAt = clock();
  const decision: MilestoneNotificationPageState = {
    ...state,
    phase: recipients.length ? "confirmed" : "terminal",
    successCount,
    failureCount,
    ...(child ? { child } : {}),
    continuation: child ? "pending" : "terminal",
    recoveryAttempts: 0,
    nextRecoveryAt: decisionAt,
    outcome: child ? "page_confirmed_continuation_pending" : "complete",
    updatedAt: decisionAt,
  };
  if (!(await saveDecision(stateClient, key, owner, decisionAt, decision)))
    return stoppedPage("unresolved", job.cursor);
  if (child) {
    try {
      await (options.schedulerClient ?? scheduler).runJob({
        name: milestoneNotificationJobName,
        data: child,
        runAt: new Date(decisionAt + milestoneNotificationBatchDelayMs),
      });
      await markContinuationScheduled(stateClient, key, clock());
    } catch (error) {
      logDiagnostic(
        "warn",
        "milestone_notification_continuation_pending",
        { workflow: "milestone_notification", postId: job.postId },
        error,
      );
    }
  }
  return processed(done, cursor, recipients.length, successCount, failureCount);
}

function processed(
  done: boolean,
  cursor: string,
  recipients: number,
  successCount: number,
  failureCount: number,
): MilestoneNotificationBatchResult {
  return {
    status: "processed",
    done,
    cursor,
    recipients,
    successCount,
    failureCount,
  };
}

async function markContinuationScheduled(
  client: StateRedis,
  key: string,
  now: number,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const raw = await client.get(key);
    const state = parseState(raw);
    if (!state?.child || state.continuation !== "pending") return;
    const tx = await client.watch(key);
    if ((await client.get(key)) !== raw) {
      await tx.discard();
      continue;
    }
    await tx.multi();
    await tx.set(
      key,
      JSON.stringify({ ...state, continuation: "scheduled", updatedAt: now }),
      { expiration: stateExpiration(state.job) },
    );
    await tx.zRem(milestoneNotificationRecoveryKey, [key]);
    if ((await tx.exec()).length) return;
  }
}

type MilestoneRecoveryOptions = {
  redisClient?: StateRedis;
  schedulerClient?: SchedulerClient;
  getCampaign: (
    job: MilestoneNotificationJob,
  ) => Promise<MilestoneNotificationCampaignData | undefined>;
  deliveryEnabled?: boolean;
  now?: () => number;
  canStart?: () => boolean;
};

export async function recoverMilestoneNotificationContinuations(
  options: MilestoneRecoveryOptions,
): Promise<{
  due: number;
  scheduled: number;
  failed: number;
  expired: number;
}> {
  const summary = { due: 0, scheduled: 0, failed: 0, expired: 0 };
  if (!(options.deliveryEnabled ?? MILESTONE_NOTIFICATION_DELIVERY_ENABLED))
    return summary;
  const client = options.redisClient ?? redis;
  const now = (options.now ?? Date.now)();
  const due = await client.zRange(milestoneNotificationRecoveryKey, 0, now, {
    by: "score",
    limit: { offset: 0, count: milestoneNotificationRecoveryBatchSize },
  });
  summary.due = due.length;
  for (const { member: key } of due) {
    if (options.canStart && !options.canStart()) break;
    try {
      const outcome = await recoverMilestoneContinuation(
        client,
        key,
        now,
        options,
      );
      if (outcome) summary[outcome] += 1;
    } catch (error) {
      summary.failed += 1;
      logDiagnostic(
        "warn",
        "milestone_notification_recovery_failed",
        { workflow: "milestone_notification", phase: "continuation_recovery" },
        error,
      );
      await retryMilestoneContinuation(client, key, now);
    }
  }
  return summary;
}

async function recoverMilestoneContinuation(
  client: StateRedis,
  key: string,
  now: number,
  options: MilestoneRecoveryOptions,
): Promise<"scheduled" | "expired" | undefined> {
  const state = parseState(await client.get(key));
  if (!state?.child || state.continuation !== "pending") {
    await client.zRem(milestoneNotificationRecoveryKey, [key]);
    return;
  }
  if (
    !isMilestoneNotificationJob(state.child) ||
    now >= milestoneNotificationDeadline(state.child.completedTime)
  ) {
    await terminalRecovery(client, key, state, now, "expired_or_invalid");
    return "expired";
  }
  const campaign = await options.getCampaign(state.child);
  if (!campaign || !isMilestoneCampaignEligible(state.child, campaign, now)) {
    await terminalRecovery(client, key, state, now, "expired_or_ineligible");
    return "expired";
  }
  if (options.canStart && !options.canStart()) return;
  await (options.schedulerClient ?? scheduler).runJob({
    name: milestoneNotificationJobName,
    data: state.child,
    runAt: new Date(now + milestoneNotificationBatchDelayMs),
  });
  await markContinuationScheduled(client, key, now);
  return "scheduled";
}

// The existing retry series doubles from two seconds to 2^10 seconds.
const milestoneRecoveryBackoff = { baseMs: 2_000, maxMs: 1_024_000 };

async function retryMilestoneContinuation(
  client: StateRedis,
  key: string,
  now: number,
): Promise<void> {
  const state = parseState(await client.get(key));
  if (state?.child && state.continuation === "pending") {
    const attempts = (state.recoveryAttempts ?? 0) + 1;
    const next = Math.min(
      milestoneNotificationDeadline(state.job.completedTime),
      now + getJobBackoffDelay(milestoneRecoveryBackoff, attempts),
    );
    try {
      await rescheduleRecovery(client, key, state, attempts, next, now);
    } catch (persistenceError) {
      logDiagnostic(
        "error",
        "milestone_notification_recovery_persistence_failed",
        { workflow: "milestone_notification", phase: "recovery_backoff" },
        persistenceError,
      );
    }
  }
}

async function rescheduleRecovery(
  client: StateRedis,
  key: string,
  state: MilestoneNotificationPageState,
  attempts: number,
  next: number,
  now: number,
): Promise<void> {
  const tx = await client.watch(key);
  if ((await client.get(key)) !== JSON.stringify(state)) {
    await tx.discard();
    return;
  }
  await tx.multi();
  await tx.set(
    key,
    JSON.stringify({
      ...state,
      recoveryAttempts: attempts,
      nextRecoveryAt: next,
      updatedAt: now,
    }),
    { expiration: stateExpiration(state.job) },
  );
  await tx.zAdd(milestoneNotificationRecoveryKey, { member: key, score: next });
  await tx.exec();
}

async function terminalRecovery(
  client: StateRedis,
  key: string,
  state: MilestoneNotificationPageState,
  now: number,
  outcome: string,
): Promise<void> {
  const tx = await client.watch(key);
  if ((await client.get(key)) !== JSON.stringify(state)) {
    await tx.discard();
    return;
  }
  await tx.multi();
  await tx.set(
    key,
    JSON.stringify({
      ...state,
      phase: "terminal",
      continuation: "terminal",
      outcome,
      updatedAt: now,
    }),
    { expiration: stateExpiration(state.job) },
  );
  await tx.zRem(milestoneNotificationRecoveryKey, [key]);
  await tx.exec();
}
