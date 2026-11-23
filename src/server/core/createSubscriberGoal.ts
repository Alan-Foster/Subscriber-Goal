import { AutomaticGoalPrerequisiteError } from "./automaticGoalRetry";
import type { ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import type { SubGoalLanguage } from "../../shared/subGoalPostI18n";
import { isCrosspostDispatchResult } from "../data/crosspostDispatchResult";
import { parseStoredJson } from "../utils/runtimeValidation";
import { isLinkId } from "../types";
import type { HighlightResult } from "../utils/communityHighlights";
import { logDiagnostic } from "../../shared/diagnostics";
import { translate } from "../../shared/i18n/catalog";
import { ProhibitedSubredditError } from "../utils/subredditBlacklist";
import {
  CommunityGoalMutationInProgressError,
  withCommunityGoalMutationLease,
  type CommunityGoalMutationLease,
} from "./communityGoalMutation";
import {
  isSubscriberGoalPostRetired,
  retireSubscriberGoalPost,
} from "./postRetirement";
import {
  getPostAvailability,
  PostTemporarilyUnavailableError,
  isMissingPostError,
} from "../utils/postStatus";
import { getCurrentActorAuthority } from "../utils/actorAuthorization";
import { acquireRedisLock, releaseRedisLock } from "../utils/redisOwnedLock";
import {
  type CreateSubscriberGoalOptions,
  type CreateSubscriberGoalResult,
  SubscriberGoalModeratorPermissionError,
  SubscriberGoalCreationOutcomeUnknownError,
  submissionReconciliationDelayMs,
  type GoalPost,
  type CreationSubreddit,
  type GoalCreationInput,
  type GoalCreationRecoveryHooks,
  createTerminalCreationResult,
  isSubscriberGoalFlairResult,
} from "./subscriberGoalCreationModel";
import { reconcileAmbiguousSubmissionUnderLock } from "../jobs/submissionReconciliation";
import { createSubscriberGoalInternal } from "./subscriberGoalCreationSteps";
export {
  SubscriberGoalModeratorPermissionError,
  SubscriberGoalCreationOutcomeUnknownError,
} from "./subscriberGoalCreationModel";
export type { CreateSubscriberGoalResult } from "./subscriberGoalCreationModel";

export class SubscriberGoalCreationInProgressError extends Error {
  constructor(language?: SubGoalLanguage) {
    super(translate(language, "errors.create.inProgress"));
    this.name = "SubscriberGoalCreationInProgressError";
  }
}

export const subscriberGoalCreationOperationRetentionSeconds = 24 * 60 * 60;

type StoredCreationOperation = Record<string, string>;

async function writeCreationOperation(
  redis: RedisClient,
  operationKey: string,
  fields: Record<string, string>,
): Promise<void> {
  await redis.hSet(operationKey, fields);
  if (!operationKey.includes(":manual-v2:")) return;
  try {
    await redis.expire(
      operationKey,
      subscriberGoalCreationOperationRetentionSeconds,
    );
  } catch (error) {
    logDiagnostic(
      "warn",
      "goal_creation_retention_failed",
      { workflow: "create_subscriber_goal", phase: "operation_retention" },
      error,
    );
  }
}

type CompletedCreationRecovery =
  | { status: "complete"; result: CreateSubscriberGoalResult }
  | { status: "retired"; postId: `t3_${string}`; reason?: string }
  | { status: "missing" }
  | { status: "unknown" };

async function recoverCompletedCreation(
  reddit: RedditClient,
  redis: RedisClient,
  raw: StoredCreationOperation,
  expectedSubreddit?: {
    id?: string | undefined;
    name?: string | undefined;
  },
): Promise<CompletedCreationRecovery> {
  const postId = raw.postId ?? "";
  try {
    if (!isLinkId(postId)) {
      throw new Error(
        "Completed Subscriber Goal operation has no valid post ID.",
      );
    }
    if (await isSubscriberGoalPostRetired(redis, postId)) {
      return { status: "retired", postId };
    }
    let post: Awaited<ReturnType<typeof reddit.getPostById>>;
    try {
      post = await reddit.getPostById(postId);
    } catch (error) {
      if (!isMissingPostError(error, postId)) throw error;
      return {
        status: "retired",
        postId,
        reason: "creation_retry_post_missing",
      };
    }
    if (!post) throw new PostTemporarilyUnavailableError(postId);
    const scope =
      expectedSubreddit ??
      (raw.subredditId && raw.subredditName
        ? { id: raw.subredditId, name: raw.subredditName }
        : undefined);
    if (
      scope &&
      (post.subredditId !== scope.id ||
        normalizeSubredditName(post.subredditName) !==
          normalizeSubredditName(scope.name))
    ) {
      return { status: "missing" };
    }
    const availability = getPostAvailability(post);
    if (availability.status === "terminal") {
      return {
        status: "retired",
        postId,
        reason: `creation_retry_removed:${availability.category}`,
      };
    }
    const crosspostDispatchResult = parseStoredJson(
      raw.crosspostDispatchResult,
      isCrosspostDispatchResult,
      {
        workflow: "create_subscriber_goal",
        phase: "completed_crosspost_result",
        postId,
      },
    );
    if (!crosspostDispatchResult) return { status: "unknown" };
    const storedHighlightResult = raw.highlightResult || raw.stickyResult;
    if (!storedHighlightResult) {
      throw new Error(
        "Completed Subscriber Goal operation has missing result metadata.",
      );
    }
    const parsedHighlightResult: unknown = JSON.parse(storedHighlightResult);
    return {
      status: "complete",
      result: {
        outcome: "created",
        post,
        crosspostDispatchResult,
        highlightResult: normalizeStoredHighlightResult(
          parsedHighlightResult,
          postId,
        ),
        flairResult: parseStoredJson(
          raw.flairResult,
          isSubscriberGoalFlairResult,
          {
            workflow: "create_subscriber_goal",
            phase: "completed_flair_result",
            postId,
          },
        ) ?? { status: "unknown" },
      },
    };
  } catch (error) {
    logDiagnostic(
      "warn",
      "goal_creation_recovery_failed",
      {
        workflow: "create_subscriber_goal",
        phase: "completed_operation",
        postId,
      },
      error,
    );
    throw error;
  }
}

function recoverTerminalCreation(
  raw: StoredCreationOperation,
): CreateSubscriberGoalResult | undefined {
  const postId = raw.postId ?? "";
  if (
    (raw.status !== "superseded" && raw.status !== "retired") ||
    !isLinkId(postId)
  ) {
    return undefined;
  }
  return createTerminalCreationResult(
    raw.status,
    postId,
    isLinkId(raw.supersedingPostId ?? "")
      ? (raw.supersedingPostId as `t3_${string}`)
      : undefined,
  );
}

export async function getStoredTerminalSubscriberGoalCreation(
  redis: RedisClient,
  operationId: string,
): Promise<CreateSubscriberGoalResult | undefined> {
  return recoverTerminalCreation(
    await redis.hGetAll(`subscriber_goal_creation_v1:${operationId}`),
  );
}

export type SubscriberGoalCreationRecovery =
  | { status: "complete"; result: CreateSubscriberGoalResult }
  | {
      status: "superseded" | "retired";
      postId: `t3_${string}`;
      supersedingPostId?: `t3_${string}`;
    }
  | { status: "unknown" }
  | { status: "missing" };

type ManualOperationScope = {
  actorUserId?: string | undefined;
  subredditId?: string | undefined;
  subredditName?: string | undefined;
};

function operationScopeMatches(
  raw: StoredCreationOperation,
  expected: ManualOperationScope,
): boolean {
  if (!expected.actorUserId) return true;
  return (
    raw.actorUserId === expected.actorUserId &&
    raw.subredditId === expected.subredditId &&
    normalizeSubredditName(raw.subredditName) ===
      normalizeSubredditName(expected.subredditName)
  );
}

const normalizeSubredditName = (value: string | undefined): string =>
  value?.trim().toLowerCase() ?? "";

export async function recoverSubscriberGoalCreation({
  reddit,
  redis,
  operationId,
  actorUserId,
  subredditId,
  subredditName,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  operationId: string;
  actorUserId?: string;
  subredditId?: string;
  subredditName?: string;
}): Promise<SubscriberGoalCreationRecovery> {
  const operationKey = `subscriber_goal_creation_v1:${operationId}`;
  const raw = await redis.hGetAll(operationKey);
  if (
    !operationScopeMatches(raw, { actorUserId, subredditId, subredditName })
  ) {
    return { status: "missing" };
  }
  const terminal = recoverTerminalCreation(raw);
  if (terminal) {
    return {
      status: terminal.outcome as "superseded" | "retired",
      postId: terminal.post.id,
      ...(terminal.supersedingPostId
        ? { supersedingPostId: terminal.supersedingPostId }
        : {}),
    };
  }
  if (raw.status === "complete") {
    const completed = await recoverCompletedCreation(
      reddit,
      redis,
      raw,
      actorUserId ? { id: subredditId, name: subredditName } : undefined,
    );
    return completed.status === "retired"
      ? { status: "retired", postId: completed.postId }
      : completed;
  }
  if (
    raw.status === "submitting" ||
    raw.status === "submission_unknown" ||
    raw.status === "post_submitted"
  ) {
    return { status: "unknown" };
  }
  return { status: "missing" };
}

export class SubscriberGoalActorAuthorizationError extends Error {
  constructor(status: "denied" | "inconclusive", language?: SubGoalLanguage) {
    super(
      translate(
        language,
        status === "denied"
          ? "moderator.authorization.managePostsRequired"
          : "moderator.authorization.retry",
      ),
    );
    this.name = "SubscriberGoalActorAuthorizationError";
  }
}

export async function createSubscriberGoal({
  reddit,
  redis,
  appSettings,
  options,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  options: CreateSubscriberGoalOptions;
}): Promise<CreateSubscriberGoalResult> {
  try {
    return await withCommunityGoalMutationLease(
      redis,
      (mutationLease) =>
        createSubscriberGoalUnderCommunityLease({
          reddit,
          redis,
          appSettings,
          options: { ...options, mutationLease },
        }),
      options.mutationLease,
    );
  } catch (error) {
    if (error instanceof CommunityGoalMutationInProgressError) {
      throw new SubscriberGoalCreationInProgressError(options.language);
    }
    // With an operation ID, submission failures are converted into the
    // explicit unknown-outcome error before reaching this boundary. Other
    // unclassified API/Redis failures must not exhaust automatic creation.
    if (
      options.automaticPermissionCheck &&
      !(error instanceof SubscriberGoalCreationOutcomeUnknownError) &&
      !(error instanceof PostTemporarilyUnavailableError) &&
      !(error instanceof SubscriberGoalModeratorPermissionError) &&
      !(error instanceof ProhibitedSubredditError)
    ) {
      throw new AutomaticGoalPrerequisiteError(error);
    }
    throw error;
  }
}

async function createSubscriberGoalUnderCommunityLease({
  reddit,
  redis,
  appSettings,
  options,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  options: CreateSubscriberGoalOptions & {
    mutationLease: CommunityGoalMutationLease;
  };
}): Promise<CreateSubscriberGoalResult> {
  const operationId = options.operationId?.trim();
  if (!operationId) {
    return createSubscriberGoalInternal({
      reddit,
      redis,
      appSettings,
      options,
    });
  }

  const operationKey = `subscriber_goal_creation_v1:${operationId}`;
  const lockKey = `${operationKey}:lock`;
  const existing = await redis.hGetAll(operationKey);
  const currentSubreddit = options.manualActorUserId
    ? await reddit.getCurrentSubreddit()
    : undefined;
  const expectedScope = {
    actorUserId: options.manualActorUserId,
    subredditId: currentSubreddit?.id,
    subredditName: currentSubreddit?.name,
  };
  const existingTerminal = recoverTerminalCreation(existing);
  if (existingTerminal) {
    if (operationScopeMatches(existing, expectedScope)) return existingTerminal;
    throw new SubscriberGoalActorAuthorizationError(
      "inconclusive",
      options.language,
    );
  }
  const nowMs = Date.now();
  const lockToken = await acquireRedisLock(redis, lockKey, 15 * 60 * 1000, {
    nowMs,
  });
  if (!lockToken) {
    throw new SubscriberGoalCreationInProgressError(options.language);
  }

  try {
    return await runCreationUnderOperationLock(
      { reddit, redis, appSettings, options },
      { operationKey, nowMs, currentSubreddit, expectedScope },
    );
  } finally {
    await releaseRedisLock(redis, lockKey, lockToken);
  }
}

async function runCreationUnderOperationLock(
  input: GoalCreationInput,
  {
    operationKey,
    nowMs,
    currentSubreddit,
    expectedScope,
  }: {
    operationKey: string;
    nowMs: number;
    currentSubreddit: CreationSubreddit | undefined;
    expectedScope: Parameters<typeof operationScopeMatches>[1];
  },
): Promise<CreateSubscriberGoalResult> {
  const { reddit, redis, options } = input;
  const reloaded = await redis.hGetAll(operationKey);
  const completed = await readFinishedOperation(
    input,
    operationKey,
    reloaded,
    expectedScope,
    currentSubreddit,
  );
  if (completed) return completed;
  await verifyManualCreationActor(reddit, options, currentSubreddit);
  let recoveredPost = await recoverUncertainSubmission(
    input,
    operationKey,
    reloaded,
  );
  const submissionMarker = reloaded.submissionMarker || crypto.randomUUID();
  await writeCreationOperation(redis, operationKey, {
    status: "claimed",
    startedAt: reloaded.startedAt || String(nowMs),
    updatedAt: String(nowMs),
    submissionMarker,
    ...(options.manualActorUserId && currentSubreddit
      ? {
          actorUserId: options.manualActorUserId,
          subredditId: currentSubreddit.id,
          subredditName: currentSubreddit.name,
        }
      : {}),
  });
  const submittedPostId = recoveredPost?.id ?? reloaded.postId ?? "";
  if (isLinkId(submittedPostId) && !recoveredPost) {
    const recovered = await recoverSubmittedPost(
      reddit,
      redis,
      operationKey,
      submittedPostId,
    );
    if (recovered.terminal) return recovered.terminal;
    recoveredPost = recovered.post;
  }
  const result = await createSubscriberGoalInternal(
    input,
    creationRecoveryCallbacks(
      redis,
      operationKey,
      options,
      reloaded,
      submissionMarker,
      recoveredPost,
    ),
  );
  return persistCreationResult(redis, operationKey, result);
}

async function readFinishedOperation(
  { reddit, redis, options }: GoalCreationInput,
  operationKey: string,
  reloaded: StoredCreationOperation,
  expectedScope: Parameters<typeof operationScopeMatches>[1],
  currentSubreddit: CreationSubreddit | undefined,
): Promise<CreateSubscriberGoalResult | undefined> {
  const reloadedTerminal = recoverTerminalCreation(reloaded);
  if (reloadedTerminal) {
    if (operationScopeMatches(reloaded, expectedScope)) {
      return reloadedTerminal;
    }
    throw new SubscriberGoalActorAuthorizationError(
      "inconclusive",
      options.language,
    );
  }
  if (reloaded.status === "complete") {
    if (operationScopeMatches(reloaded, expectedScope)) {
      const completed = await recoverCompletedCreation(
        reddit,
        redis,
        reloaded,
        currentSubreddit
          ? { id: currentSubreddit.id, name: currentSubreddit.name }
          : undefined,
      );
      if (completed.status === "complete") return completed.result;
      if (completed.status === "unknown") {
        throw new SubscriberGoalCreationOutcomeUnknownError(options.language);
      }
      if (completed.status === "retired") {
        if (completed.reason) {
          await retireSubscriberGoalPost(
            redis,
            completed.postId,
            completed.reason,
          );
        }
        const retired = createTerminalCreationResult(
          "retired",
          completed.postId,
        );
        await persistTerminalCreationOutcome(redis, operationKey, retired);
        return retired;
      }
    }
    throw new SubscriberGoalActorAuthorizationError(
      "inconclusive",
      options.language,
    );
  }
}

async function verifyManualCreationActor(
  reddit: RedditClient,
  options: CreateSubscriberGoalOptions,
  currentSubreddit: CreationSubreddit | undefined,
): Promise<void> {
  if (options.manualActorUserId) {
    if (!currentSubreddit) {
      throw new SubscriberGoalActorAuthorizationError(
        "inconclusive",
        options.language,
      );
    }
    const authority = await getCurrentActorAuthority({
      reddit,
      actorUserId: options.manualActorUserId,
      subredditName: currentSubreddit.name,
      requirement: "manage-posts",
    });
    if (authority.status !== "authorized") {
      throw new SubscriberGoalActorAuthorizationError(
        authority.status,
        options.language,
      );
    }
  }
}

async function recoverUncertainSubmission(
  { reddit, redis, options }: GoalCreationInput,
  operationKey: string,
  reloaded: StoredCreationOperation,
): Promise<GoalPost | undefined> {
  if (
    reloaded.status === "submitting" ||
    reloaded.status === "submission_unknown"
  ) {
    const reconciliation = await reconcileAmbiguousSubmissionUnderLock({
      reddit,
      raw: reloaded,
      language: options.language,
      nowMs: options.reconciliationNowMs ?? Date.now(),
      canStart: options.canStartSubmissionReconciliation,
      persist: (fields) => writeCreationOperation(redis, operationKey, fields),
    });
    const recoveredPost = reconciliation.post;
    try {
      await writeCreationOperation(redis, operationKey, {
        status: "post_submitted",
        postId: recoveredPost.id,
        updatedAt: String(Date.now()),
      });
    } catch (error) {
      logDiagnostic(
        "warn",
        "goal_creation_recovered_post_id_persistence_failed",
        {
          workflow: "create_subscriber_goal",
          phase: "recovered_post_id_persistence",
          postId: recoveredPost.id,
        },
        error,
      );
      const safeNextAt =
        reconciliation.reservation.nextAt ??
        (options.reconciliationNowMs ?? Date.now()) +
          submissionReconciliationDelayMs[0];
      throw new SubscriberGoalCreationOutcomeUnknownError(options.language, {
        status: "pending",
        attempts: reconciliation.reservation.attempts,
        nextAt: safeNextAt,
      });
    }
    return recoveredPost;
  }
}

async function recoverSubmittedPost(
  reddit: RedditClient,
  redis: RedisClient,
  operationKey: string,
  submittedPostId: GoalPost["id"],
): Promise<
  | { post: GoalPost; terminal?: never }
  | { terminal: CreateSubscriberGoalResult; post?: never }
> {
  let recoveredPost: GoalPost;
  if (await isSubscriberGoalPostRetired(redis, submittedPostId)) {
    const retired = createTerminalCreationResult("retired", submittedPostId);
    await persistTerminalCreationOutcome(redis, operationKey, retired);
    return { terminal: retired };
  }
  try {
    recoveredPost = await reddit.getPostById(submittedPostId);
    if (!recoveredPost) {
      throw new PostTemporarilyUnavailableError(submittedPostId);
    }
  } catch (error) {
    if (isMissingPostError(error, submittedPostId)) {
      await retireSubscriberGoalPost(
        redis,
        submittedPostId,
        "creation_retry_post_missing",
      );
      const retired = createTerminalCreationResult("retired", submittedPostId);
      await persistTerminalCreationOutcome(redis, operationKey, retired);
      return { terminal: retired };
    }
    throw error;
  }
  return { post: recoveredPost };
}

function creationRecoveryCallbacks(
  redis: RedisClient,
  operationKey: string,
  options: CreateSubscriberGoalOptions,
  reloaded: StoredCreationOperation,
  submissionMarker: string,
  recoveredPost: GoalPost | undefined,
): GoalCreationRecoveryHooks {
  const recoveredCrosspostDispatchResult = parseStoredJson(
    reloaded.crosspostDispatchResult,
    isCrosspostDispatchResult,
    {
      workflow: "create_subscriber_goal",
      phase: "registration_crosspost_result",
      postId: recoveredPost?.id,
    },
  );
  return {
    ...(recoveredPost ? { recoveredPost } : {}),
    ...(recoveredCrosspostDispatchResult
      ? { recoveredCrosspostDispatchResult }
      : {}),
    submissionMarker,
    onSubmissionStarted: async (subredditName, subredditId) => {
      const reconciliationNowMs = options.reconciliationNowMs ?? Date.now();
      await writeCreationOperation(redis, operationKey, {
        status: "submitting",
        subredditName,
        subredditId,
        updatedAt: String(reconciliationNowMs),
      });
    },
    onPostSubmitted: async (postId) => {
      await writeCreationOperation(redis, operationKey, {
        status: "post_submitted",
        postId,
        updatedAt: String(Date.now()),
      });
    },
    onSubmissionUnknown: async () => {
      const reconciliationNowMs = options.reconciliationNowMs ?? Date.now();
      await writeCreationOperation(redis, operationKey, {
        status: "submission_unknown",
        reconciliationStatus: "pending",
        reconciliationAttempts: "0",
        reconciliationStartedAt: String(reconciliationNowMs),
        reconciliationNextAt: String(
          reconciliationNowMs + submissionReconciliationDelayMs[0],
        ),
        updatedAt: String(Date.now()),
      });
    },
    onRegistrationCompleted: async (postId, crosspostDispatchResult) => {
      await writeCreationOperation(redis, operationKey, {
        status: "registered",
        postId,
        crosspostDispatchResult: JSON.stringify(crosspostDispatchResult),
        updatedAt: String(Date.now()),
      });
    },
  };
}

async function persistCreationResult(
  redis: RedisClient,
  operationKey: string,
  result: CreateSubscriberGoalResult,
): Promise<CreateSubscriberGoalResult> {
  if (result.outcome !== "created") {
    await persistTerminalCreationOutcome(redis, operationKey, result);
    return result;
  }
  await writeCreationOperation(redis, operationKey, {
    status: "complete",
    postId: result.post.id,
    completedAt: String(Date.now()),
    updatedAt: String(Date.now()),
    crosspostDispatchResult: JSON.stringify(result.crosspostDispatchResult),
    highlightResult: JSON.stringify(result.highlightResult),
    flairResult: JSON.stringify(result.flairResult),
  });
  return result;
}

async function persistTerminalCreationOutcome(
  redis: RedisClient,
  operationKey: string,
  result: CreateSubscriberGoalResult,
): Promise<void> {
  await writeCreationOperation(redis, operationKey, {
    status: result.outcome,
    postId: result.post.id,
    supersedingPostId: result.supersedingPostId ?? "",
    completedAt: String(Date.now()),
    updatedAt: String(Date.now()),
  });
}

type StoredHighlightResult = {
  status?: unknown;
  errorMessage?: unknown;
  verifiedStickied?: unknown;
  verifiedHighlighted?: unknown;
  failureCategory?: unknown;
  issues?: unknown;
  selectedPostId?: unknown;
};

function normalizeStoredHighlightResult(
  value: unknown,
  postId: `t3_${string}`,
): HighlightResult {
  const legacy = value as StoredHighlightResult;
  const status =
    legacy?.status === "pinned"
      ? "highlighted"
      : legacy?.status === "not_pinned"
        ? "not_highlighted"
        : legacy?.status === "highlighted"
          ? "highlighted"
          : "not_highlighted";
  const verifiedHighlighted =
    typeof legacy.verifiedHighlighted === "boolean"
      ? legacy.verifiedHighlighted
      : typeof legacy.verifiedStickied === "boolean"
        ? legacy.verifiedStickied
        : status === "highlighted";
  const { issues, failureCategory, errorMessage } =
    normalizeStoredHighlightIssues(legacy, postId);
  const current = value as Partial<HighlightResult>;
  return {
    status,
    selectedPostId:
      typeof legacy.selectedPostId === "string"
        ? (legacy.selectedPostId as `t3_${string}`)
        : postId,
    verifiedHighlighted,
    issues,
    ...(typeof current.selectedPosition === "number"
      ? { selectedPosition: current.selectedPosition }
      : {}),
    capacityOutcome: current.capacityOutcome ?? "not_needed",
    cleanupOutcome: current.cleanupOutcome ?? "not_needed",
    removedManagedHighlightIds: current.removedManagedHighlightIds ?? [],
    preservedHighlightIds: current.preservedHighlightIds ?? [],
    rollbackOutcome: current.rollbackOutcome ?? "not_needed",
    ...(failureCategory ? { failureCategory } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function normalizeStoredHighlightIssues(
  legacy: StoredHighlightResult,
  postId: GoalPost["id"],
) {
  const storedFailureCategory =
    typeof legacy.failureCategory === "string"
      ? (legacy.failureCategory as HighlightResult["failureCategory"])
      : undefined;
  const storedErrorMessage =
    typeof legacy.errorMessage === "string" ? legacy.errorMessage : undefined;
  const storedIssues = Array.isArray(legacy.issues)
    ? (legacy.issues as HighlightResult["issues"])
    : storedFailureCategory && storedErrorMessage
      ? [
          {
            category: storedFailureCategory,
            message: storedErrorMessage,
            postId,
          },
        ]
      : [];
  const issues = storedIssues.filter(
    ({ category }) => String(category) !== "reorder",
  );
  const hadReorderIssue =
    legacy.failureCategory === "reorder" ||
    issues.length !== storedIssues.length;
  const failureCategory = hadReorderIssue
    ? issues[0]?.category
    : storedFailureCategory;
  const errorMessage = hadReorderIssue
    ? issues.map(({ message }) => message).join(" ")
    : storedErrorMessage;
  return { issues, failureCategory, errorMessage };
}
