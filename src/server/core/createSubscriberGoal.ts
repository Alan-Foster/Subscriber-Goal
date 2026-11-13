import type { ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import type { SubGoalColorTheme } from "../../shared/subGoalColorTheme";
import type { SubGoalLanguage } from "../../shared/subGoalPostI18n";
import type { SubGoalPostHeight } from "../../shared/subGoalPostHeight";
import { applyGoalPostFrameStyle, createGoalPost } from "./post";
import {
  cancelAllAutoCreateNextGoals,
  cancelAutoCreateNextGoal,
  autoCreateNextGoalSuccessorsKey,
  postHeightSuffix,
  postKindSuffix,
  postCompletedTimeSuffix,
  registerNewCtaOnlyPost,
  registerNewSubGoalPost,
  registerNewSubscribeOnlyPost,
  setSubredditDisplayNameForPost,
  subscriberGoalsKey,
  type CrosspostDispatchResult,
} from "../data/subGoalData";
import { setSavedSubredditDisplayName } from "../data/subredditDisplayNameData";
import {
  getQueuedUpdates,
  getTrackedPosts,
  queueUpdate,
} from "../data/updaterData";
import { isLinkId } from "../types";
import {
  createFailedHighlightResult,
  highlightAndVerifyPost,
  highlightVerificationIntervalMs,
  highlightVerificationMaxWaitMs,
  type HighlightResult,
  type HighlightVerificationOptions,
} from "../utils/communityHighlights";
import {
  ctaOnlyTextFallbackMaker,
  subscribeOnlyTextFallbackMaker,
  textFallbackMaker,
} from "../utils/textFallback";
import { toErrorMessage } from "../utils/crosspostLogs";
import { logDiagnostic } from "../../shared/diagnostics";
import { translate } from "../../shared/i18n/catalog";
import {
  defaultAfterSubscribeAction,
  type AfterSubscribeAction,
  type AfterSubscribePreset,
} from "../../shared/afterSubscribeAction";
import {
  isSubredditBlacklisted,
  ProhibitedSubredditError,
} from "../utils/subredditBlacklist";
import { getSubscriberGoalCandidatePostIds } from "../data/subscriberGoalCandidates";
import { ensureSubscriberGoalPostFlair } from "./subscriberGoalPostFlair";
import { checkAppAccountHealth } from "./appAccountHealth";
import {
  CommunityGoalMutationInProgressError,
  withCommunityGoalMutationLease,
  type CommunityGoalMutationLease,
} from "./communityGoalMutation";
import {
  getHighlightManagementBaseline,
  saveHighlightManagementBaseline,
  type HighlightReconciliationContext,
} from "../data/highlightManagement";
import { scheduleHighlightRepair } from "../data/highlightRepair";
import { clearHighlightContradictionIncident } from "../data/highlightContradiction";
import {
  isSubscriberGoalPostRetired,
  retireSubscriberGoalPost,
} from "./postRetirement";
import { getTerminalRemovedByCategory } from "../utils/postStatus";
import { getCurrentActorAuthority } from "../utils/actorAuthorization";

type CreateSubscriberGoalOptions = {
  title: string;
  goal?: number;
  subredditDisplayName: string;
  crosspost: boolean;
  colorTheme: SubGoalColorTheme;
  postHeight: SubGoalPostHeight;
  autoCreateNextGoal: boolean;
  language: SubGoalLanguage;
  cancelPendingAutoCreateGoals?: boolean;
  submitAsUser?: boolean;
  headerText?: string;
  afterSubscribeAction?: AfterSubscribeAction;
  afterSubscribePreset?: AfterSubscribePreset;
  operationId?: string;
  automaticPermissionCheck?: boolean;
  highlightVerification?: Partial<HighlightVerificationOptions>;
  reconciliationContext?: HighlightReconciliationContext;
  mutationLease?: CommunityGoalMutationLease;
  reconciliationNowMs?: number;
  /** Trusted server-only identity for an interactive/manual invocation. */
  manualActorUserId?: string;
};

export type CreateSubscriberGoalResult = {
  outcome: "created" | "superseded" | "retired";
  post: Awaited<ReturnType<typeof createGoalPost>>;
  crosspostDispatchResult: CrosspostDispatchResult;
  highlightResult: HighlightResult;
  flairResult: SubscriberGoalFlairResult;
  supersedingPostId?: `t3_${string}`;
};

export type SubscriberGoalFlairResult =
  | { status: "applied"; flairId: string }
  | {
      status: "omitted";
      reason: "missing_permission" | "preparation_failed";
    };

export class SubscriberGoalModeratorPermissionError extends Error {
  constructor(
    appUsername: string | undefined,
    subredditName: string,
    language?: SubGoalLanguage,
  ) {
    const appAccount = appUsername
      ? `u/${appUsername}`
      : "the Subscriber Goal app account";
    super(
      translate(language, "errors.create.moderatorPermission", {
        appAccount,
        subredditName,
      }),
    );
    this.name = "SubscriberGoalModeratorPermissionError";
  }
}

export class SubscriberGoalCreationInProgressError extends Error {
  constructor(language?: SubGoalLanguage) {
    super(translate(language, "errors.create.inProgress"));
    this.name = "SubscriberGoalCreationInProgressError";
  }
}

export class SubscriberGoalCreationOutcomeUnknownError extends Error {
  readonly reconciliationStatus: "pending" | "exhausted";
  readonly reconciliationAttempts: number;
  readonly reconciliationNextAt?: number;

  constructor(
    language?: SubGoalLanguage,
    reconciliation: {
      status: "pending" | "exhausted";
      attempts: number;
      nextAt?: number;
    } = { status: "pending", attempts: 0 },
  ) {
    super(translate(language, "errors.create.outcomeUnknown"));
    this.name = "SubscriberGoalCreationOutcomeUnknownError";
    this.reconciliationStatus = reconciliation.status;
    this.reconciliationAttempts = reconciliation.attempts;
    if (reconciliation.nextAt !== undefined) {
      this.reconciliationNextAt = reconciliation.nextAt;
    }
  }
}

export const subscriberGoalCreationOperationRetentionSeconds = 24 * 60 * 60;
const submissionReconciliationListingLimit = 100;
export const submissionReconciliationDelayMs = [
  1 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  120 * 60 * 1000,
] as const;

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

async function recoverCompletedCreation(
  reddit: RedditClient,
  raw: StoredCreationOperation,
  expectedSubreddit?: {
    id?: string | undefined;
    name?: string | undefined;
  },
): Promise<CreateSubscriberGoalResult | undefined> {
  const postId = raw.postId ?? "";
  if (
    raw.status !== "complete" ||
    !isLinkId(postId) ||
    !raw.crosspostDispatchResult ||
    !(raw.highlightResult || raw.stickyResult) ||
    !raw.flairResult
  ) {
    return undefined;
  }
  try {
    const storedHighlightResult = raw.highlightResult || raw.stickyResult;
    const post = (await reddit.getPostById(postId)) as unknown as Awaited<
      ReturnType<typeof createGoalPost>
    >;
    if (
      expectedSubreddit &&
      (post.subredditId !== expectedSubreddit.id ||
        normalizeSubredditName(post.subredditName) !==
          normalizeSubredditName(expectedSubreddit.name))
    ) {
      return undefined;
    }
    return {
      outcome: "created",
      post,
      crosspostDispatchResult: JSON.parse(raw.crosspostDispatchResult),
      highlightResult: normalizeStoredHighlightResult(
        JSON.parse(storedHighlightResult!),
        postId,
      ),
      flairResult: JSON.parse(raw.flairResult),
    } as CreateSubscriberGoalResult;
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
    return undefined;
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
  const completed = await recoverCompletedCreation(
    reddit,
    raw,
    actorUserId ? { id: subredditId, name: subredditName } : undefined,
  );
  if (completed) return { status: "complete", result: completed };
  if (
    raw.status === "submitting" ||
    raw.status === "submission_unknown" ||
    raw.status === "post_submitted"
  ) {
    return { status: "unknown" };
  }
  return { status: "missing" };
}

export class SubscriberGoalPermissionVerificationError extends Error {
  constructor(subredditName: string, language?: SubGoalLanguage) {
    super(
      translate(language, "errors.create.permissionVerification", {
        subredditName,
      }),
    );
    this.name = "SubscriberGoalPermissionVerificationError";
  }
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
  const completed = operationScopeMatches(existing, expectedScope)
    ? await recoverCompletedCreation(
        reddit,
        existing,
        currentSubreddit
          ? { id: currentSubreddit.id, name: currentSubreddit.name }
          : undefined,
      )
    : undefined;
  if (completed) return completed;
  const nowMs = Date.now();
  const lockToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(lockKey, lockToken, {
    nx: true,
    expiration: new Date(nowMs + 15 * 60 * 1000),
  });
  if ((await redis.get(lockKey)) !== lockToken) {
    throw new SubscriberGoalCreationInProgressError(options.language);
  }

  try {
    const reloaded = await redis.hGetAll(operationKey);
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
    const recoveredComplete = operationScopeMatches(reloaded, expectedScope)
      ? await recoverCompletedCreation(
          reddit,
          reloaded,
          currentSubreddit
            ? { id: currentSubreddit.id, name: currentSubreddit.name }
            : undefined,
        )
      : undefined;
    if (recoveredComplete) return recoveredComplete;
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
    let recoveredPost: Awaited<ReturnType<typeof createGoalPost>> | undefined;
    if (
      reloaded.status === "submitting" ||
      reloaded.status === "submission_unknown"
    ) {
      const reconciliation = await reconcileAmbiguousSubmissionUnderLock({
        reddit,
        redis,
        operationKey,
        raw: reloaded,
        language: options.language,
        nowMs: options.reconciliationNowMs ?? Date.now(),
      });
      recoveredPost = reconciliation.post;
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
    }
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
      if (await isSubscriberGoalPostRetired(redis, submittedPostId)) {
        const retired = createTerminalCreationResult(
          "retired",
          submittedPostId,
        );
        await persistTerminalCreationOutcome(redis, operationKey, retired);
        return retired;
      }
      try {
        recoveredPost = (await reddit.getPostById(
          submittedPostId,
        )) as unknown as Awaited<ReturnType<typeof createGoalPost>>;
      } catch (error) {
        const message = toErrorMessage(error);
        if (
          /not[\s-]?found|does not exist|deleted|no longer exists|\b404\b|\b410\b/i.test(
            message,
          )
        ) {
          await retireSubscriberGoalPost(
            redis,
            submittedPostId,
            "creation_retry_post_missing",
          );
          const retired = createTerminalCreationResult(
            "retired",
            submittedPostId,
          );
          await persistTerminalCreationOutcome(redis, operationKey, retired);
          return retired;
        }
        throw error;
      }
    }
    const result = await createSubscriberGoalInternal(
      { reddit, redis, appSettings, options },
      {
        ...(recoveredPost ? { recoveredPost } : {}),
        ...(reloaded.crosspostDispatchResult
          ? {
              recoveredCrosspostDispatchResult: JSON.parse(
                reloaded.crosspostDispatchResult,
              ) as CrosspostDispatchResult,
            }
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
      },
    );
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
  } finally {
    if ((await redis.get(lockKey)) === lockToken) await redis.del(lockKey);
  }
}

async function createSubscriberGoalInternal(
  {
    reddit,
    redis,
    appSettings,
    options,
  }: {
    reddit: RedditClient;
    redis: RedisClient;
    appSettings: ServerAppSettings;
    options: CreateSubscriberGoalOptions;
  },
  recovery?: {
    recoveredPost?: Awaited<ReturnType<typeof createGoalPost>>;
    recoveredCrosspostDispatchResult?: CrosspostDispatchResult;
    submissionMarker: string;
    onSubmissionStarted: (
      subredditName: string,
      subredditId: string,
    ) => Promise<void>;
    onPostSubmitted: (postId: string) => Promise<void>;
    onSubmissionUnknown: () => Promise<void>;
    onRegistrationCompleted: (
      postId: `t3_${string}`,
      result: CrosspostDispatchResult,
    ) => Promise<void>;
  },
): Promise<CreateSubscriberGoalResult> {
  const subreddit = await reddit.getCurrentSubreddit();
  if (await isSubredditBlacklisted(reddit, subreddit.name)) {
    throw new ProhibitedSubredditError();
  }
  const isTinyPost = options.postHeight === "tiny";
  const isCtaOnlyPost = options.postHeight === "cta";
  const isCompactActionPost = isTinyPost || isCtaOnlyPost;
  const afterSubscribePresetArgs = options.afterSubscribePreset
    ? ([options.afterSubscribePreset] as const)
    : ([] as const);
  if (!isCompactActionPost && options.goal === undefined) {
    throw new Error("Subscriber goal is required for goal posts.");
  }
  if (
    isCtaOnlyPost &&
    (!options.afterSubscribeAction ||
      options.afterSubscribeAction.type === "disabled")
  ) {
    throw new Error("CTA-only posts require an actionable CTA.");
  }

  let existingGoalPostIds: string[] = [];
  let existingClassicGoalPostIds: Array<`t3_${string}`> = [];

  if (recovery?.recoveredPost) {
    [existingGoalPostIds, existingClassicGoalPostIds] =
      await getExistingGoalPostIds(redis);
    const terminal = await revalidateRecoveredCreation({
      reddit,
      redis,
      post: recovery.recoveredPost,
      candidatePostIds: existingGoalPostIds,
    });
    if (terminal) return terminal;
  }

  const health = await checkAppAccountHealth({
    reddit,
    redis,
    subredditName: subreddit.name,
    subredditId: subreddit.id,
    language: options.language,
    ...(options.automaticPermissionCheck
      ? { notify: false, scheduleUnknownRetry: false }
      : {}),
  });
  const { appUsername, permissions } = health;
  const hasAllPermissions = permissions.includes("all");
  if (health.status === "unknown") {
    if (options.automaticPermissionCheck) {
      throw new SubscriberGoalPermissionVerificationError(
        subreddit.name,
        options.language,
      );
    }
    throw new Error(
      translate(options.language, "errors.create.permissionVerificationRetry", {
        subredditName: subreddit.name,
      }),
    );
  }
  if (!health.healthy) {
    logDiagnostic("warn", "subscriber_goal_permission_preflight_failed", {
      workflow: "create_subscriber_goal",
      phase: "permission_preflight",
      category: "missing_posts_permission",
      subredditName: subreddit.name,
      username: appUsername,
    });
    throw new SubscriberGoalModeratorPermissionError(
      appUsername,
      subreddit.name,
      options.language,
    );
  }

  const flairResult = await prepareSubscriberGoalFlair({
    reddit,
    subredditName: subreddit.name,
    appUsername,
    canManageFlair: hasAllPermissions || permissions.includes("flair"),
  });
  if (!recovery?.recoveredPost) {
    [existingGoalPostIds, existingClassicGoalPostIds] =
      await getExistingGoalPostIds(redis);
  }
  const textFallback = isCtaOnlyPost
    ? ctaOnlyTextFallbackMaker(
        (
          options.afterSubscribeAction as Exclude<
            AfterSubscribeAction,
            { type: "disabled" }
          >
        ).buttonText,
      )
    : isTinyPost
      ? subscribeOnlyTextFallbackMaker({
          subredditName: options.subredditDisplayName,
          language: options.language,
        })
      : textFallbackMaker({
          goal: options.goal as number,
          subscribers: subreddit.numberOfSubscribers,
          subredditName: options.subredditDisplayName,
          completedTime: null,
          language: options.language,
        });

  let post = recovery?.recoveredPost;
  if (!post) {
    await recovery?.onSubmissionStarted(subreddit.name, subreddit.id);
    try {
      post = await createGoalPost({
        title: options.title,
        subredditName: subreddit.name,
        textFallback,
        postHeight: options.postHeight,
        language: options.language,
        ...(recovery?.submissionMarker
          ? { submissionMarker: recovery.submissionMarker }
          : {}),
        ...(flairResult.status === "applied"
          ? { flairId: flairResult.flairId }
          : {}),
        ...(options.submitAsUser === true ? { submitAsUser: true } : {}),
      });
    } catch (error) {
      if (recovery) {
        const reconciliationNowMs = options.reconciliationNowMs ?? Date.now();
        try {
          await recovery.onSubmissionUnknown();
        } catch (bookkeepingError) {
          logDiagnostic(
            "warn",
            "goal_creation_submission_unknown_persistence_failed",
            {
              workflow: "create_subscriber_goal",
              phase: "submission_unknown_persistence",
            },
            bookkeepingError,
          );
        }
        throw new SubscriberGoalCreationOutcomeUnknownError(options.language, {
          status: "pending",
          attempts: 0,
          nextAt: reconciliationNowMs + submissionReconciliationDelayMs[0],
        });
      }
      throw error;
    }
  }
  if (!recovery?.recoveredPost && recovery) {
    try {
      await recovery.onPostSubmitted(post.id);
    } catch (error) {
      logDiagnostic(
        "warn",
        "goal_creation_post_id_persistence_failed",
        {
          workflow: "create_subscriber_goal",
          phase: "post_id_persistence",
          postId: post.id,
        },
        error,
      );
      try {
        await recovery.onSubmissionUnknown();
      } catch (bookkeepingError) {
        logDiagnostic(
          "warn",
          "goal_creation_submission_unknown_persistence_failed",
          {
            workflow: "create_subscriber_goal",
            phase: "post_id_fallback_persistence",
            postId: post.id,
          },
          bookkeepingError,
        );
      }
      throw new SubscriberGoalCreationOutcomeUnknownError(options.language, {
        status: "pending",
        attempts: 0,
        nextAt:
          (options.reconciliationNowMs ?? Date.now()) +
          submissionReconciliationDelayMs[0],
      });
    }
  }
  await applyGoalPostFrameStyle(post, options.postHeight);

  if (!recovery?.recoveredPost) {
    await setSavedSubredditDisplayName(redis, options.subredditDisplayName);
  }
  const replayedRegistrationResult = isCtaOnlyPost
    ? await registerNewCtaOnlyPost(
        redis,
        appSettings,
        post,
        options.subredditDisplayName,
        options.colorTheme,
        options.language,
        options.afterSubscribeAction as Exclude<
          AfterSubscribeAction,
          { type: "disabled" }
        >,
        ...afterSubscribePresetArgs,
      )
    : isTinyPost
      ? await registerNewSubscribeOnlyPost(
          redis,
          appSettings,
          post,
          options.subredditDisplayName,
          options.colorTheme,
          options.language,
          options.afterSubscribeAction ?? defaultAfterSubscribeAction,
          ...afterSubscribePresetArgs,
        )
      : await registerNewSubGoalPost(
          reddit,
          redis,
          appSettings,
          post,
          options.goal as number,
          recovery?.recoveredCrosspostDispatchResult
            ? false
            : options.crosspost,
          options.subredditDisplayName,
          options.colorTheme,
          options.autoCreateNextGoal,
          options.language,
          options.headerText,
          options.postHeight as Exclude<SubGoalPostHeight, "tiny" | "cta">,
          options.afterSubscribeAction ?? defaultAfterSubscribeAction,
          ...afterSubscribePresetArgs,
        );
  const crosspostDispatchResult =
    recovery?.recoveredCrosspostDispatchResult ?? replayedRegistrationResult;
  if (!recovery?.recoveredCrosspostDispatchResult) {
    await recovery?.onRegistrationCompleted(post.id, crosspostDispatchResult);
  }

  if (!isCompactActionPost) {
    for (const olderPostId of existingClassicGoalPostIds) {
      if (olderPostId === post.id) continue;
      await redis.hSet(autoCreateNextGoalSuccessorsKey, {
        [olderPostId]: post.id,
      });
      await cancelAutoCreateNextGoal(redis, olderPostId);
    }
  }

  const trackedPosts = recovery?.recoveredPost
    ? []
    : await getTrackedPosts(redis);
  const queuedPosts = recovery?.recoveredPost
    ? []
    : await getQueuedUpdates(redis);
  const activePostIds = [...new Set([...trackedPosts, ...queuedPosts])];
  for (const activePostId of activePostIds) {
    if (!isLinkId(activePostId)) {
      continue;
    }
    try {
      const activePost = await reddit.getPostById(activePostId);
      if (activePost.subredditId !== subreddit.id) {
        continue;
      }
      await setSubredditDisplayNameForPost(
        redis,
        activePostId,
        options.subredditDisplayName,
      );
      await queueUpdate(redis, activePostId, new Date());
    } catch (backfillError) {
      logDiagnostic(
        "warn",
        "goal_backfill_failed",
        {
          workflow: "create_subscriber_goal",
          phase: "display_name_backfill",
          postId: activePostId,
        },
        backfillError,
      );
    }
  }

  await post.approve();
  let highlightResult: HighlightResult;
  try {
    const highlightHealth = await checkAppAccountHealth({
      reddit,
      redis,
      subredditName: subreddit.name,
      subredditId: subreddit.id,
      language: options.language,
      notify: false,
    });
    highlightResult =
      highlightHealth.healthy && highlightHealth.status === "healthy"
        ? await highlightAndVerifyPost(reddit, subreddit, post, {
            maxWaitMs:
              options.highlightVerification?.maxWaitMs ??
              highlightVerificationMaxWaitMs,
            intervalMs:
              options.highlightVerification?.intervalMs ??
              highlightVerificationIntervalMs,
            ...(!isCompactActionPost
              ? { removableManagedPostIds: existingClassicGoalPostIds }
              : {}),
          })
        : createFailedHighlightResult(
            post.id,
            "permission",
            "Manage Posts permission could not be verified, so no Community Highlight changes were attempted.",
          );
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    logDiagnostic(
      "warn",
      "highlight_operation_failed",
      {
        workflow: "create_subscriber_goal",
        phase: "replacement",
        postId: post.id,
      },
      error,
    );
    highlightResult = createFailedHighlightResult(
      post.id,
      "write",
      errorMessage,
    );
  }

  if (!isCompactActionPost && highlightResult.issues.length === 0) {
    await saveHighlightManagementBaseline(redis, {
      canonicalPostId: post.id,
      highlighted: true,
      position: 0,
      highlightLabel: null,
      highlightedUntil: null,
      moderatorOverride: "none",
      reconciledAt: Date.now(),
    });
    await clearHighlightContradictionIncident(redis);
  } else if (highlightResult.issues.length > 0) {
    await scheduleHighlightRepair(redis, {
      delayMs: 5 * 60 * 1000,
      force: true,
      reason: `${options.reconciliationContext ?? "manual_creation"}_highlight_degraded`,
      targetPostId: post.id,
    });
  }

  if (options.cancelPendingAutoCreateGoals && !recovery?.recoveredPost) {
    await cancelAllAutoCreateNextGoals(redis);
  }

  return {
    outcome: "created",
    post,
    crosspostDispatchResult,
    highlightResult,
    flairResult,
  };
}

async function reconcileAmbiguousSubmissionUnderLock({
  reddit,
  redis,
  operationKey,
  raw,
  language,
  nowMs,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  operationKey: string;
  raw: StoredCreationOperation;
  language?: SubGoalLanguage;
  nowMs: number;
}): Promise<{
  post: Awaited<ReturnType<typeof createGoalPost>>;
  reservation: SubmissionReconciliationReservation;
}> {
  const marker = raw.submissionMarker;
  const expectedSubredditName = raw.subredditName;
  const expectedSubredditId = raw.subredditId;
  const attempts = Math.max(0, Number(raw.reconciliationAttempts) || 0);
  const throwUnknown = (
    status: "pending" | "exhausted",
    nextAt?: number,
  ): never => {
    throw new SubscriberGoalCreationOutcomeUnknownError(language, {
      status,
      attempts,
      ...(nextAt === undefined ? {} : { nextAt }),
    });
  };
  if (!marker || !expectedSubredditName || !expectedSubredditId) {
    try {
      await writeCreationOperation(redis, operationKey, {
        reconciliationStatus: "exhausted",
        reconciliationAttempts: String(attempts),
        reconciliationNextAt: "",
        reconciliationCompletedAt: String(nowMs),
        updatedAt: String(Date.now()),
      });
    } catch (error) {
      logDiagnostic(
        "warn",
        "goal_creation_legacy_reconciliation_persistence_failed",
        {
          workflow: "create_subscriber_goal",
          phase: "legacy_submission_reconciliation",
        },
        error,
      );
    }
    return throwUnknown("exhausted");
  }
  if (raw.reconciliationStatus === "exhausted") {
    return throwUnknown("exhausted");
  }
  const persistedNextAt = Number(raw.reconciliationNextAt);
  if (!Number.isFinite(persistedNextAt) || persistedNextAt <= 0) {
    const submissionStartedAt = Number(raw.updatedAt);
    const nextAt =
      (Number.isFinite(submissionStartedAt) && submissionStartedAt > 0
        ? submissionStartedAt
        : nowMs) + submissionReconciliationDelayMs[0];
    if (nowMs < nextAt) {
      try {
        await writeCreationOperation(redis, operationKey, {
          reconciliationStatus: "pending",
          reconciliationAttempts: String(attempts),
          reconciliationStartedAt:
            raw.reconciliationStartedAt || String(submissionStartedAt || nowMs),
          reconciliationNextAt: String(nextAt),
          updatedAt: String(Date.now()),
        });
      } catch (error) {
        logDiagnostic(
          "warn",
          "goal_creation_reconciliation_schedule_persistence_failed",
          {
            workflow: "create_subscriber_goal",
            phase: "submission_reconciliation_schedule",
          },
          error,
        );
      }
      return throwUnknown("pending", nextAt);
    }
  }
  if (
    Number.isFinite(persistedNextAt) &&
    persistedNextAt > 0 &&
    nowMs < persistedNextAt
  ) {
    return throwUnknown("pending", persistedNextAt);
  }

  const reservation = createSubmissionReconciliationReservation(
    attempts + 1,
    nowMs,
  );
  try {
    await writeCreationOperation(redis, operationKey, {
      reconciliationStatus: reservation.status,
      reconciliationAttempts: String(reservation.attempts),
      reconciliationNextAt: String(reservation.nextAt ?? ""),
      ...(reservation.status === "exhausted"
        ? { reconciliationCompletedAt: String(nowMs) }
        : {}),
      updatedAt: String(Date.now()),
    });
  } catch (error) {
    logDiagnostic(
      "warn",
      "goal_creation_reconciliation_reservation_failed",
      {
        workflow: "create_subscriber_goal",
        phase: "submission_reconciliation_reservation",
        reconciliationAttempts: reservation.attempts,
      },
      error,
    );
    const safeNextAt =
      reservation.nextAt ?? nowMs + submissionReconciliationDelayMs[0];
    throw new SubscriberGoalCreationOutcomeUnknownError(language, {
      status: "pending",
      attempts: reservation.attempts,
      nextAt: safeNextAt,
    });
  }

  let match: Awaited<ReturnType<typeof createGoalPost>> | undefined;
  try {
    match = await findSubmissionMarkerMatch({
      reddit,
      marker,
      expectedSubredditName,
      expectedSubredditId,
    });
  } catch (error) {
    logDiagnostic(
      "warn",
      "goal_creation_submission_reconciliation_failed",
      {
        workflow: "create_subscriber_goal",
        phase: "submission_reconciliation",
        subredditName: expectedSubredditName,
      },
      error,
    );
  }
  if (match) return { post: match, reservation };

  throw new SubscriberGoalCreationOutcomeUnknownError(language, {
    status: reservation.status,
    attempts: reservation.attempts,
    ...(reservation.nextAt === undefined ? {} : { nextAt: reservation.nextAt }),
  });
}

type SubmissionReconciliationReservation = {
  status: "pending" | "exhausted";
  attempts: number;
  nextAt?: number;
};

function createSubmissionReconciliationReservation(
  attempts: number,
  nowMs: number,
): SubmissionReconciliationReservation {
  const nextDelay = submissionReconciliationDelayMs[attempts];
  return nextDelay === undefined
    ? { status: "exhausted", attempts }
    : { status: "pending", attempts, nextAt: nowMs + nextDelay };
}

async function findSubmissionMarkerMatch({
  reddit,
  marker,
  expectedSubredditName,
  expectedSubredditId,
}: {
  reddit: RedditClient;
  marker: string;
  expectedSubredditName: string;
  expectedSubredditId: string;
}): Promise<Awaited<ReturnType<typeof createGoalPost>> | undefined> {
  const posts = await reddit
    .getNewPosts({
      subredditName: expectedSubredditName,
      limit: submissionReconciliationListingLimit,
      pageSize: submissionReconciliationListingLimit,
    })
    .all();
  const matches: typeof posts = [];
  for (const post of posts) {
    if (
      post.subredditId !== expectedSubredditId ||
      post.subredditName.toLowerCase() !== expectedSubredditName.toLowerCase()
    ) {
      continue;
    }
    const postData = await reddit.getPostData(post.id);
    if (postData?.submissionMarker === marker) matches.push(post);
  }
  return matches.length === 1
    ? (matches[0] as Awaited<ReturnType<typeof createGoalPost>>)
    : undefined;
}

async function getExistingGoalPostIds(
  redis: RedisClient,
): Promise<[string[], Array<`t3_${string}`>]> {
  const postIds = await getSubscriberGoalCandidatePostIds(redis);
  const classicPostIds: Array<`t3_${string}`> = [];
  for (const postId of postIds) {
    const [postKind, postHeight] = await redis.hMGet(subscriberGoalsKey, [
      `${postId}${postKindSuffix}`,
      `${postId}${postHeightSuffix}`,
    ]);
    if (
      postKind === "subscriber-goal-v1" &&
      (postHeight === "regular" || postHeight === "short") &&
      isLinkId(postId)
    ) {
      classicPostIds.push(postId);
    }
  }
  return [postIds, classicPostIds];
}

async function revalidateRecoveredCreation({
  reddit,
  redis,
  post,
  candidatePostIds,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  post: Awaited<ReturnType<typeof createGoalPost>>;
  candidatePostIds: string[];
}): Promise<CreateSubscriberGoalResult | undefined> {
  if (await isSubscriberGoalPostRetired(redis, post.id)) {
    return createTerminalCreationResult("retired", post.id);
  }
  const removedByCategory = getTerminalRemovedByCategory(post);
  if (removedByCategory) {
    await retireSubscriberGoalPost(
      redis,
      post.id,
      `creation_retry_removed:${removedByCategory}`,
    );
    return createTerminalCreationResult("retired", post.id);
  }
  const [successor, completedTime, baseline] = await Promise.all([
    redis.hGet(autoCreateNextGoalSuccessorsKey, post.id),
    redis.hGet(subscriberGoalsKey, `${post.id}${postCompletedTimeSuffix}`),
    getHighlightManagementBaseline(redis),
  ]);
  if (isLinkId(successor ?? "")) {
    return createTerminalCreationResult(
      "superseded",
      post.id,
      successor as `t3_${string}`,
    );
  }
  if (Number(completedTime) > 0) {
    return createTerminalCreationResult("superseded", post.id);
  }

  const recoveredCreatedAt = new Date(post.createdAt).getTime();
  const possibleNewerIds = new Set(candidatePostIds);
  if (baseline?.canonicalPostId) possibleNewerIds.add(baseline.canonicalPostId);
  for (const candidateId of possibleNewerIds) {
    if (candidateId === post.id || !isLinkId(candidateId)) continue;
    try {
      const candidate = await reddit.getPostById(candidateId);
      const candidateCreatedAt = new Date(candidate.createdAt).getTime();
      if (
        Number.isFinite(candidateCreatedAt) &&
        (!Number.isFinite(recoveredCreatedAt) ||
          candidateCreatedAt > recoveredCreatedAt)
      ) {
        return createTerminalCreationResult("superseded", post.id, candidateId);
      }
    } catch (error) {
      // Candidate cleanup is owned by normal reconciliation; an unavailable
      // candidate must not make a valid recovery destructive.
      logDiagnostic(
        "warn",
        "goal_creation_revalidation_candidate_unavailable",
        {
          workflow: "create_subscriber_goal",
          phase: "revalidation",
          postId: post.id,
          candidatePostId: candidateId,
        },
        error,
      );
    }
  }
  return undefined;
}

function createTerminalCreationResult(
  outcome: "superseded" | "retired",
  postId: `t3_${string}`,
  supersedingPostId?: `t3_${string}`,
): CreateSubscriberGoalResult {
  return {
    outcome,
    post: { id: postId } as Awaited<ReturnType<typeof createGoalPost>>,
    crosspostDispatchResult: { status: "skipped" },
    highlightResult: createFailedHighlightResult(
      postId,
      "write",
      outcome === "retired"
        ? "The recovered post is retired."
        : "The recovered post was superseded by newer community state.",
    ),
    flairResult: { status: "omitted", reason: "preparation_failed" },
    ...(supersedingPostId ? { supersedingPostId } : {}),
  };
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

async function prepareSubscriberGoalFlair({
  reddit,
  subredditName,
  appUsername,
  canManageFlair,
}: {
  reddit: RedditClient;
  subredditName: string;
  appUsername: string | undefined;
  canManageFlair: boolean;
}): Promise<SubscriberGoalFlairResult> {
  if (!canManageFlair) {
    logDiagnostic("warn", "subscriber_goal_flair_omitted", {
      workflow: "create_subscriber_goal",
      phase: "flair_preparation",
      category: "missing_flair_permission",
      subredditName,
      username: appUsername,
    });
    return { status: "omitted", reason: "missing_permission" };
  }

  try {
    const flair = await ensureSubscriberGoalPostFlair(reddit, subredditName);
    return { status: "applied", flairId: flair.id };
  } catch (error) {
    logDiagnostic(
      "warn",
      "subscriber_goal_flair_omitted",
      {
        workflow: "create_subscriber_goal",
        phase: "flair_preparation",
        category: "flair_preparation_failed",
        subredditName,
        username: appUsername,
      },
      error,
    );
    return { status: "omitted", reason: "preparation_failed" };
  }
}

function normalizeStoredHighlightResult(
  value: unknown,
  postId: `t3_${string}`,
): HighlightResult {
  const legacy = value as {
    status?: unknown;
    errorMessage?: unknown;
    verifiedStickied?: unknown;
    verifiedHighlighted?: unknown;
    failureCategory?: unknown;
    issues?: unknown;
    selectedPostId?: unknown;
  };
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
  const failureCategory =
    typeof legacy.failureCategory === "string"
      ? (legacy.failureCategory as HighlightResult["failureCategory"])
      : undefined;
  const errorMessage =
    typeof legacy.errorMessage === "string" ? legacy.errorMessage : undefined;
  const current = value as Partial<HighlightResult>;
  return {
    ...current,
    status,
    selectedPostId:
      typeof legacy.selectedPostId === "string"
        ? (legacy.selectedPostId as `t3_${string}`)
        : postId,
    verifiedHighlighted,
    issues: Array.isArray(legacy.issues)
      ? (legacy.issues as HighlightResult["issues"])
      : failureCategory && errorMessage
        ? [{ category: failureCategory, message: errorMessage, postId }]
        : [],
    capacityOutcome: current.capacityOutcome ?? "not_needed",
    cleanupOutcome: current.cleanupOutcome ?? "not_needed",
    removedManagedHighlightIds: current.removedManagedHighlightIds ?? [],
    preservedHighlightIds: current.preservedHighlightIds ?? [],
    rollbackOutcome: current.rollbackOutcome ?? "not_needed",
    reorderOutcome: current.reorderOutcome ?? "not_attempted",
    ...(failureCategory ? { failureCategory } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}
