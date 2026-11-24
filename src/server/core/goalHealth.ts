import {
  logDiagnostic,
  type DiagnosticContext,
} from "../../shared/diagnostics";
import { appRepairStateKey } from "../data/highlightRepair";
import {
  autoCreateNextGoalDelayMs,
  autoCreateNextGoalExhaustedKey,
  autoCreateNextGoalQueueKey,
  autoCreateNextGoalReconciliationExhaustedKey,
  autoCreateNextGoalRetryAttemptsKey,
  autoCreateNextGoalSuccessorsKey,
} from "../data/subGoalData";
import { subscriberGoalPostRegistryKey } from "../data/subscriberGoalPostRegistry";
import {
  isLinkId,
  type LinkId,
  type RedditClient,
  type RedisClient,
} from "../types";
import { remainingMs } from "../utils/timeBudget";
import { appAccountHealthStateKey } from "./appAccountHealth";
import { getAutomaticGoalEligibility } from "./automaticGoalEligibility";
import { automaticGoalPrerequisiteRetriesKey } from "./automaticGoalRetry";
import { communityGoalMutationLockKey } from "./communityGoalMutation";
import {
  positiveTime,
  readGoalHealthPosts,
  scanGoalHealthInventory,
  type GoalHealthPost,
  type GoalHealthScan,
} from "./goalHealthInventory";
import {
  onboardingGoalBaseDelayMs,
  onboardingGoalStaggerMaxMinutes,
  onboardingReminderStaggerMaxMinutes,
} from "./onboardingConfig";
import { getOnboardingEligibility } from "./onboardingEligibility";
import { parseOnboardingState } from "./onboardingGoalState";
import {
  onboardingSubscriberGoalStateKey,
  readOnboardingWarningFields,
} from "./onboardingState";
import {
  AUTOMATIC_ONBOARDING_ENABLED,
  type OnboardingSubscriberGoalState,
} from "./onboardingSubscriberGoal";

export const goalHealthThrottleKey = "goal_health_check_v1";
const hourMs = 60 * 60 * 1000;
const repeatWarningMs = 24 * hourMs;
const stateLifetimeMs = 48 * hourMs;
const pendingGraceMs = 3 * hourMs;
const minimumBudgetMs = 3_000;
const saveReserveMs = 500;
const queueSampleSize = 8;
const pendingCreationStatuses = new Set([
  "claimed",
  "submitting",
  "submission_unknown",
  "post_submitted",
  "registered",
]);

type CurrentSubreddit = Awaited<
  ReturnType<RedditClient["getCurrentSubreddit"]>
>;
type CheckState = {
  checkedAt: number;
  lastPostId?: LinkId | undefined;
  lastPostCreatedAt?: number | undefined;
  manualDeletion?: boolean | undefined;
  scan?: GoalHealthScan | undefined;
  warning?: { fingerprint: string; at: number } | undefined;
};
type Observation = {
  lastPostId?: LinkId | undefined;
  lastPostCreatedAt?: number | undefined;
  manualDeletion?: boolean | undefined;
  scan?: GoalHealthScan;
  missing?: DiagnosticContext;
};
type QueueItem = { member: LinkId; score: number };

type GoalHealthOptions = {
  reddit: RedditClient;
  redis: RedisClient;
  deadlineMs: number;
  subreddit?: CurrentSubreddit | null;
  now?: () => number;
};

export async function runGoalHealthCheck(
  options: GoalHealthOptions,
): Promise<void> {
  const { deadlineMs, subreddit, now = Date.now } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const budgetMs = remainingMs(deadlineMs, 0, now());
    if (subreddit === null || budgetMs < minimumBudgetMs) return;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error("Goal health check exceeded the runner budget.")),
        budgetMs,
      );
    });
    await Promise.race([checkGoalHealth({ ...options, now }), timeout]);
  } catch (error) {
    logDiagnostic(
      "warn",
      "goal_health_check_failed",
      { workflow: "goal_health" },
      error,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function checkGoalHealth({
  reddit,
  redis,
  deadlineMs,
  subreddit,
  now,
}: GoalHealthOptions & { now: () => number }): Promise<void> {
  const state = await claimHealthCheck(redis, deadlineMs, now);
  if (!state) return;
  const canRead = () => remainingMs(deadlineMs, saveReserveMs, now()) > 0;
  if (!canRead()) return;
  const community = subreddit ?? (await reddit.getCurrentSubreddit());
  if (!getAutomaticGoalEligibility(community).eligible || !canRead()) return;
  const observation = await inspectGoalHealth(redis, community, state, canRead);
  if (!observation || remainingMs(deadlineMs, 0, now()) === 0) return;
  await saveObservation(redis, state, observation, now());
}

function readState(raw: string | undefined): CheckState | undefined {
  if (raw === undefined) return;
  return JSON.parse(raw) as CheckState;
}

async function claimHealthCheck(
  redis: RedisClient,
  deadlineMs: number,
  now: () => number,
): Promise<CheckState | undefined> {
  const previous = readState(await redis.get(goalHealthThrottleKey));
  if (previous && now() - previous.checkedAt < hourMs) return;
  if (remainingMs(deadlineMs, saveReserveMs, now()) === 0) return;
  const tx = await redis.watch(goalHealthThrottleKey);
  let started = false;
  try {
    if (remainingMs(deadlineMs, saveReserveMs, now()) === 0) {
      await tx.unwatch();
      return;
    }
    const state = readState(await redis.get(goalHealthThrottleKey));
    const checkedAt = now();
    if (
      (state && checkedAt - state.checkedAt < hourMs) ||
      remainingMs(deadlineMs, saveReserveMs, checkedAt) === 0
    ) {
      await tx.unwatch();
      return;
    }
    const claimed = { ...state, checkedAt };
    await tx.multi();
    started = true;
    await tx.set(goalHealthThrottleKey, JSON.stringify(claimed), {
      expiration: new Date(checkedAt + stateLifetimeMs),
    });
    if (remainingMs(deadlineMs, 0, now()) === 0) {
      await tx.discard();
      return;
    }
    if ((await tx.exec()).length > 0) return claimed;
  } catch (error) {
    try {
      await (started ? tx.discard() : tx.unwatch());
    } catch {
      // diagnostic-allow-silent: the outer handler logs the original error.
    }
    throw error;
  }
}

async function saveObservation(
  redis: RedisClient,
  state: CheckState,
  { lastPostId, lastPostCreatedAt, manualDeletion, scan, missing }: Observation,
  nowMs: number,
): Promise<void> {
  const fingerprint = missing
    ? JSON.stringify([missing.postId, missing.reason])
    : undefined;
  const warn =
    !!fingerprint &&
    (state.warning?.fingerprint !== fingerprint ||
      nowMs - state.warning.at >= repeatWarningMs);
  const warning = warn
    ? { fingerprint, at: nowMs }
    : scan || missing
      ? state.warning
      : undefined;
  await redis.set(
    goalHealthThrottleKey,
    JSON.stringify({
      ...state,
      lastPostId,
      lastPostCreatedAt,
      manualDeletion,
      scan,
      warning,
    }),
    { expiration: new Date(nowMs + stateLifetimeMs) },
  );
  if (warn && missing) logDiagnostic("warn", "goal_missing", missing);
}

async function readInitialInventory(
  redis: RedisClient,
  state: CheckState,
  canRead: () => boolean,
) {
  const [workflow, [registered], queue] = await Promise.all([
    redis.hGetAll(onboardingSubscriberGoalStateKey),
    redis.zRange(subscriberGoalPostRegistryKey, 0, 0, {
      by: "rank",
      reverse: true,
    }),
    redis.zRange(autoCreateNextGoalQueueKey, 0, queueSampleSize),
  ]);
  if (!canRead()) return;
  const onboarding = parseOnboardingState(workflow);
  const queued = queue
    .slice(0, queueSampleSize)
    .filter((row): row is QueueItem => isLinkId(row.member));
  const knownIds = [
    registered?.member,
    state.lastPostId,
    onboarding?.postId,
    onboarding?.replacementSourcePostId,
    state.scan?.completedId,
    state.scan?.alternativeId,
    ...queued.map(({ member }) => member),
  ].filter(isKnownPostId);
  const posts = await readGoalHealthPosts(redis, [...new Set(knownIds)]);
  return {
    workflow,
    onboarding,
    registered,
    queued,
    posts,
    knownIds,
    queueTruncated: queue.length > queueSampleSize,
  };
}

async function inspectGoalHealth(
  redis: RedisClient,
  subreddit: CurrentSubreddit,
  state: CheckState,
  canRead: () => boolean,
): Promise<Observation | undefined> {
  const initial = await readInitialInventory(redis, state, canRead);
  if (!initial || !canRead()) return;
  const { registered, queued, onboarding } = initial;
  const remember = (observation: Observation): Observation => ({
    ...observation,
    manualDeletion:
      observation.manualDeletion ??
      (observation.lastPostId === state.lastPostId
        ? state.manualDeletion
        : undefined),
    lastPostCreatedAt:
      registered && observation.lastPostId === registered.member
        ? registered.score
        : observation.lastPostId === state.lastPostId
          ? state.lastPostCreatedAt
          : undefined,
  });
  if (rememberedManualDeletion(state, registered)) {
    return remember({ lastPostId: state.lastPostId, manualDeletion: true });
  }
  const inventory = await collectGoalInventory(redis, initial, state, canRead);
  if (!inventory) return;
  const { latest, scan, healthy } = inventory;
  const lastPostId =
    latest?.id ?? state.lastPostId ?? onboarding?.postId ?? queued[0]?.member;
  const knownPostId = isKnownPostId(lastPostId) ? lastPostId : undefined;
  if (healthy) return remember({ lastPostId: knownPostId });
  if (scan) return remember({ lastPostId: knownPostId, scan });
  if (!canRead()) return;

  const result = await inspectMissingGoal({
    ...initial,
    redis,
    subreddit,
    latest,
    lastPostId: knownPostId,
    manualDeletion:
      latest?.retiredReason === "app_menu_deletion" ||
      (lastPostId === state.lastPostId && state.manualDeletion === true),
    nowMs: state.checkedAt,
    canRead,
  });
  if (result) return remember(result);
}

function rememberedManualDeletion(
  state: CheckState,
  newest: { member: string; score: number } | undefined,
): boolean {
  return (
    state.manualDeletion === true &&
    (!newest || (state.lastPostCreatedAt ?? 0) > newest.score)
  );
}

async function collectGoalInventory(
  redis: RedisClient,
  {
    posts,
    registered,
    knownIds,
  }: NonNullable<Awaited<ReturnType<typeof readInitialInventory>>>,
  state: CheckState,
  canRead: () => boolean,
): Promise<
  | {
      latest: GoalHealthPost | undefined;
      healthy: boolean;
      scan?: GoalHealthScan;
    }
  | undefined
> {
  const latest = pickLatestGoal(posts, registered, state);
  const active = posts.find(({ status }) => status === "active");
  if (active || latest?.status === "alternative")
    return { latest: latest ?? active, healthy: true };
  if (!canRead()) return;

  const inventory = await scanGoalHealthInventory(
    redis,
    state.scan ?? { cursor: 0 },
    canRead,
  );
  if (inventory.active)
    return { latest: latest ?? inventory.active, healthy: true };
  if (!inventory.complete)
    return { latest, healthy: false, scan: inventory.scan };
  if (!canRead()) return;
  const scannedIds = [inventory.scan.completedId, inventory.scan.alternativeId]
    .filter(isKnownPostId)
    .filter((id) => !knownIds.includes(id));
  const all = [...posts, ...(await readGoalHealthPosts(redis, scannedIds))];
  return {
    latest: pickLatestGoal(all, registered, state),
    healthy: !registered && all.some(({ status }) => status === "alternative"),
  };
}

function isKnownPostId(id: string | undefined): id is LinkId {
  return id !== undefined && isLinkId(id);
}

function pickLatestGoal(
  posts: GoalHealthPost[],
  registered: { member: string; score: number } | undefined,
  state: CheckState,
): GoalHealthPost | undefined {
  const first = posts.find(({ id }) => id === registered?.member);
  if (first && registered) {
    const rememberedRetired = posts.find(
      ({ id, status }) => id === state.lastPostId && status === "retired",
    );
    return rememberedRetired &&
      (state.lastPostCreatedAt ?? 0) > registered.score
      ? rememberedRetired
      : first;
  }
  return posts.reduce<GoalHealthPost | undefined>((latest, post) => {
    if (!latest) return post;
    const rank = (candidate: GoalHealthPost) =>
      candidate.retiredAt ?? candidate.completedAt ?? 0;
    return rank(post) > rank(latest) ? post : latest;
  }, undefined);
}

type MissingGoalInput = {
  redis: RedisClient;
  subreddit: CurrentSubreddit;
  onboarding: OnboardingSubscriberGoalState | undefined;
  workflow: Record<string, string>;
  latest: GoalHealthPost | undefined;
  lastPostId: LinkId | undefined;
  manualDeletion: boolean;
  posts: GoalHealthPost[];
  queued: QueueItem[];
  queueTruncated: boolean;
  nowMs: number;
  canRead: () => boolean;
};

async function inspectMissingGoal(
  input: MissingGoalInput,
): Promise<Observation | undefined> {
  const {
    redis,
    onboarding,
    workflow,
    latest,
    lastPostId,
    posts,
    queued,
    queueTruncated,
    nowMs,
    canRead,
  } = input;
  const clear = { lastPostId, manualDeletion: input.manualDeletion };
  if (!expectsClassicGoal(input)) return clear;
  if (!canRead()) return;

  const nextDue = lastPostId
    ? await redis.zScore(autoCreateNextGoalQueueKey, lastPostId)
    : undefined;
  if (!canRead()) return;
  const pending = readPendingSuccessors(queued, posts, latest, nextDue, nowMs);
  if (pending.fresh) return clear;
  const onboardingDeadline = await readOnboardingDeadline(
    redis,
    onboarding,
    workflow,
  );
  if (onboardingDeadline !== undefined && nowMs <= onboardingDeadline)
    return clear;
  if (!canRead()) return;
  const [lease, creation] = await Promise.all([
    redis.get(communityGoalMutationLockKey),
    readPendingCreation(redis, lastPostId, onboarding?.operationId, queued),
  ]);
  if (lease || creation.some((startedAt) => nowMs - startedAt < pendingGraceMs))
    return clear;
  if (queueTruncated || !canRead()) return;
  const pendingSince = [...pending.startedAt, ...creation];
  if (onboarding && onboarding.status !== "complete")
    pendingSince.push(onboarding.armedAt);
  return {
    lastPostId,
    missing: await readMissingGoalDiagnostic(
      input,
      nextDue,
      onboardingDeadline,
      pendingSince,
    ),
  };
}

function expectsClassicGoal({
  subreddit,
  onboarding,
  latest,
  manualDeletion,
}: MissingGoalInput): boolean {
  if (
    latest?.status === "alternative" ||
    explicitlyOptedOut(onboarding, latest)
  )
    return false;
  if (
    !latest &&
    (!AUTOMATIC_ONBOARDING_ENABLED ||
      !getOnboardingEligibility(subreddit).eligible)
  )
    return false;
  return !manualDeletion;
}

async function readMissingGoalDiagnostic(
  { redis, subreddit, latest, lastPostId, onboarding, nowMs }: MissingGoalInput,
  nextDue: number | undefined,
  onboardingDeadline: number | undefined,
  pendingSince: number[],
): Promise<DiagnosticContext> {
  const [successor, repair, health] = await Promise.all([
    readSuccessorState(redis, lastPostId, nextDue),
    redis.hMGet(appRepairStateKey, [
      "status",
      "reason",
      "nextRunAt",
      "scheduledAt",
    ]),
    redis.hGet(appAccountHealthStateKey, "status"),
  ]);
  const [repairStatus, repairReason, repairDueAt, repairScheduledAt] = repair;
  const oldestPending = Math.min(
    ...pendingSince,
    pendingRepairSince(repairStatus, repairScheduledAt),
  );
  return {
    workflow: "goal_health",
    subredditName: subreddit.name,
    postId: latest?.id ?? lastPostId ?? "none",
    reason: missingReason(latest, successor, onboardingDeadline),
    goalStatus: latest?.status ?? "unknown",
    completedAt: latest?.completedAt,
    retiredAt: latest?.retiredAt,
    retirementReason: latest?.retiredReason,
    ...successor,
    cancellationReason:
      latest?.retiredReason ?? latest?.suppression ?? "unknown",
    onboardingStatus: onboarding?.status ?? "none",
    onboardingResult: onboarding?.resultStatus,
    appRepairStatus: repairStatus ?? "none",
    appRepairReason: repairReason || undefined,
    appRepairNextRunAt: positiveTime(repairDueAt),
    appAccountHealthStatus: health ?? "unknown",
    oldestPendingAgeMs: Number.isFinite(oldestPending)
      ? Math.max(0, nowMs - oldestPending)
      : undefined,
  };
}

function pendingRepairSince(
  status: string | null | undefined,
  scheduledAt: unknown,
): number {
  return status === "pending" || status === "processing"
    ? (positiveTime(scheduledAt) ?? Infinity)
    : Infinity;
}

function explicitlyOptedOut(
  onboarding: OnboardingSubscriberGoalState | undefined,
  latest: GoalHealthPost | undefined,
): boolean {
  return (
    onboarding?.resultStatus === "completed_auto_disabled" &&
    (!latest ||
      [onboarding.postId, onboarding.replacementSourcePostId].includes(
        latest.id,
      ))
  );
}

function readPendingSuccessors(
  queued: QueueItem[],
  posts: GoalHealthPost[],
  latest: GoalHealthPost | undefined,
  nextDue: number | undefined,
  nowMs: number,
) {
  const queuedIds = new Set(queued.map(({ member }) => member));
  if (latest && nextDue !== undefined) queuedIds.add(latest.id);
  const startedAt = [...posts, ...(latest ? [latest] : [])]
    .filter(({ id, status }) => queuedIds.has(id) && status === "completed")
    .flatMap(({ completedAt }) =>
      completedAt === undefined ? [] : [completedAt],
    );
  return {
    startedAt,
    fresh: startedAt.some(
      (completedAt) =>
        nowMs < completedAt + autoCreateNextGoalDelayMs + pendingGraceMs,
    ),
  };
}

async function readOnboardingDeadline(
  redis: RedisClient,
  onboarding: OnboardingSubscriberGoalState | undefined,
  workflow: Record<string, string>,
): Promise<number | undefined> {
  if (!onboarding || onboarding.status === "complete" || onboarding.pausedAt)
    return;
  const warningWindowMs = onboardingReminderStaggerMaxMinutes * 60_000;
  if (onboarding.status === "awaiting_warning") {
    const warning = await readOnboardingWarningFields(redis, workflow);
    const latestWarning = onboarding.armedAt + warningWindowMs;
    return (
      Math.min(
        positiveTime(warning.nextRunAt) ?? latestWarning,
        latestWarning,
      ) + pendingGraceMs
    );
  }
  const latestGoal =
    onboarding.armedAt +
    warningWindowMs +
    onboardingGoalBaseDelayMs +
    onboardingGoalStaggerMaxMinutes * 60_000;
  return (
    Math.min(onboarding.nextRunAt ?? latestGoal, latestGoal) + pendingGraceMs
  );
}

async function readPendingCreation(
  redis: RedisClient,
  postId: LinkId | undefined,
  onboardingOperation: string | undefined,
  queued: QueueItem[],
): Promise<number[]> {
  const operations = new Set(queued.map(({ member }) => `auto-next:${member}`));
  if (postId) operations.add(`auto-next:${postId}`);
  if (onboardingOperation) operations.add(onboardingOperation);
  const rows = await Promise.all(
    [...operations].map((id) =>
      redis.hMGet(`subscriber_goal_creation_v1:${id}`, [
        "status",
        "startedAt",
        "reconciliationStatus",
      ]),
    ),
  );
  return rows.flatMap(([status, rawStartedAt, reconciliation]) => {
    const startedAt = positiveTime(rawStartedAt);
    return status &&
      pendingCreationStatuses.has(status) &&
      reconciliation !== "exhausted" &&
      startedAt !== undefined
      ? [startedAt]
      : [];
  });
}

async function readSuccessorState(
  redis: RedisClient,
  id: LinkId | undefined,
  dueAt: number | undefined,
) {
  if (!id) return { successorQueued: false };
  const [
    successorPostId,
    retries,
    prerequisiteRetries,
    exhausted,
    reconciliation,
  ] = await Promise.all([
    redis.hGet(autoCreateNextGoalSuccessorsKey, id),
    redis.hGet(autoCreateNextGoalRetryAttemptsKey, id),
    redis.hGet(automaticGoalPrerequisiteRetriesKey, `auto-next:${id}`),
    redis.hGet(autoCreateNextGoalExhaustedKey, id),
    redis.hGet(autoCreateNextGoalReconciliationExhaustedKey, id),
  ]);
  return {
    successorQueued: dueAt !== undefined,
    successorDueAt: dueAt,
    successorPostId,
    successorRetries: positiveTime(retries) ?? 0,
    successorPrerequisiteRetries: positiveTime(prerequisiteRetries) ?? 0,
    successorExhausted: !!exhausted,
    successorReconciliationExhausted: !!reconciliation,
  };
}

function missingReason(
  latest: GoalHealthPost | undefined,
  successor: Awaited<ReturnType<typeof readSuccessorState>>,
  onboardingDeadline: number | undefined,
): string {
  if (
    successor.successorExhausted ||
    successor.successorReconciliationExhausted
  )
    return "successor_exhausted";
  if (successor.successorQueued) return "successor_overdue";
  if (latest?.status === "completed") return "successor_missing";
  if (latest?.status === "retired") return "goal_retired";
  if (onboardingDeadline !== undefined) return "onboarding_overdue";
  return "no_goal_record";
}
