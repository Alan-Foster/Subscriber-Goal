import type { RedditClient, RedisClient } from "../types";
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
  isCapacityOnlyHighlightFailure,
  highlightAndVerifyPost,
  highlightVerificationIntervalMs,
  highlightVerificationMaxWaitMs,
  type HighlightResult,
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
  getCanonicalGoalPointer,
  saveCanonicalGoalPointer,
} from "../data/highlightManagement";
import {
  recurringHighlightRepairIntervalMs,
  scheduleHighlightRepair,
} from "../data/highlightRepair";
import { clearHighlightContradictionIncident } from "../data/highlightContradiction";
import {
  isSubscriberGoalPostRetired,
  retireSubscriberGoalPost,
} from "./postRetirement";
import {
  getPostAvailability,
  PostTemporarilyUnavailableError,
} from "../utils/postStatus";
import {
  type CreateSubscriberGoalOptions,
  type CreateSubscriberGoalResult,
  type SubscriberGoalFlairResult,
  SubscriberGoalModeratorPermissionError,
  SubscriberGoalCreationOutcomeUnknownError,
  submissionReconciliationDelayMs,
  SubscriberGoalPermissionVerificationError,
  type GoalPost,
  type CreationSubreddit,
  type GoalCreationInput,
  type GoalCreationRecoveryHooks,
  createTerminalCreationResult,
} from "./subscriberGoalCreationModel";

export async function createSubscriberGoalInternal(
  input: GoalCreationInput,
  recovery?: GoalCreationRecoveryHooks,
): Promise<CreateSubscriberGoalResult> {
  const { reddit, redis, options } = input;
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
    const automaticSuccessor =
      options.reconciliationContext === "automatic_successor";
    const terminal = await revalidateRecoveredCreation({
      reddit,
      redis,
      post: recovery.recoveredPost,
      candidatePostIds: automaticSuccessor
        ? existingClassicGoalPostIds
        : existingGoalPostIds,
      automaticSuccessor,
    });
    if (terminal) return terminal;
  }

  const flairResult = await checkCreationPermissionsAndPrepareFlair(
    input,
    subreddit,
  );
  if (!recovery?.recoveredPost) {
    [existingGoalPostIds, existingClassicGoalPostIds] =
      await getExistingGoalPostIds(redis);
  }
  const textFallback = buildCreationTextFallback(
    options,
    subreddit,
    isTinyPost,
    isCtaOnlyPost,
  );
  const post = await submitGoalOrUseRecoveredPost(
    options,
    subreddit,
    textFallback,
    flairResult,
    recovery,
  );
  const crosspostDispatchResult = await registerCreatedGoal(
    input,
    post,
    { isTinyPost, isCtaOnlyPost, afterSubscribePresetArgs },
    recovery,
  );
  await updateOlderGoalPosts(
    input,
    subreddit,
    post,
    existingClassicGoalPostIds,
    isCompactActionPost,
    recovery,
  );
  const highlightResult = await approveAndHighlightGoal(
    input,
    subreddit,
    post,
    existingClassicGoalPostIds,
    isCompactActionPost,
  );
  await recordCreationHighlightOutcome(
    redis,
    options,
    post,
    highlightResult,
    isCompactActionPost,
  );

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

async function checkCreationPermissionsAndPrepareFlair(
  { reddit, redis, options }: GoalCreationInput,
  subreddit: CreationSubreddit,
): Promise<SubscriberGoalFlairResult> {
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

  return prepareSubscriberGoalFlair({
    reddit,
    redis,
    subredditName: subreddit.name,
    appUsername,
    canManageFlair: hasAllPermissions || permissions.includes("flair"),
  });
}

function buildCreationTextFallback(
  options: CreateSubscriberGoalOptions,
  subreddit: CreationSubreddit,
  isTinyPost: boolean,
  isCtaOnlyPost: boolean,
) {
  return isCtaOnlyPost
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
}

async function submitGoalOrUseRecoveredPost(
  options: CreateSubscriberGoalOptions,
  subreddit: CreationSubreddit,
  textFallback: ReturnType<typeof buildCreationTextFallback>,
  flairResult: SubscriberGoalFlairResult,
  recovery?: GoalCreationRecoveryHooks,
): Promise<GoalPost> {
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
    await recordSubmittedPostId(options, recovery, post);
  }
  return post;
}

async function recordSubmittedPostId(
  options: CreateSubscriberGoalOptions,
  recovery: GoalCreationRecoveryHooks,
  post: GoalPost,
): Promise<void> {
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

async function registerCreatedGoal(
  { reddit, redis, appSettings, options }: GoalCreationInput,
  post: GoalPost,
  {
    isTinyPost,
    isCtaOnlyPost,
    afterSubscribePresetArgs,
  }: {
    isTinyPost: boolean;
    isCtaOnlyPost: boolean;
    afterSubscribePresetArgs: readonly [] | readonly [AfterSubscribePreset];
  },
  recovery?: GoalCreationRecoveryHooks,
): Promise<CrosspostDispatchResult> {
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
  return crosspostDispatchResult;
}

async function updateOlderGoalPosts(
  { reddit, redis, options }: GoalCreationInput,
  subreddit: CreationSubreddit,
  post: GoalPost,
  existingClassicGoalPostIds: Array<GoalPost["id"]>,
  isCompactActionPost: boolean,
  recovery?: GoalCreationRecoveryHooks,
): Promise<void> {
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
}

async function approveAndHighlightGoal(
  { reddit, redis, options }: GoalCreationInput,
  subreddit: CreationSubreddit,
  post: GoalPost,
  existingClassicGoalPostIds: Array<GoalPost["id"]>,
  isCompactActionPost: boolean,
): Promise<HighlightResult> {
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
  return highlightResult;
}

async function recordCreationHighlightOutcome(
  redis: RedisClient,
  options: CreateSubscriberGoalOptions,
  post: GoalPost,
  highlightResult: HighlightResult,
  isCompactActionPost: boolean,
): Promise<void> {
  if (!isCompactActionPost && highlightResult.issues.length === 0) {
    await saveCanonicalGoalPointer(redis, {
      canonicalPostId: post.id,
      reconciledAt: Date.now(),
    });
    await clearHighlightContradictionIncident(redis);
  } else if (highlightResult.issues.length > 0) {
    const capacityOnly =
      options.automaticPermissionCheck &&
      isCapacityOnlyHighlightFailure(highlightResult);
    await scheduleHighlightRepair(redis, {
      delayMs: capacityOnly
        ? recurringHighlightRepairIntervalMs
        : 5 * 60 * 1000,
      force: !capacityOnly,
      reason: `${options.reconciliationContext ?? "manual_creation"}_highlight_degraded`,
      targetPostId: post.id,
    });
  }
}

async function getExistingGoalPostIds(
  redis: RedisClient,
): Promise<[string[], Array<`t3_${string}`>]> {
  const postIds = await getSubscriberGoalCandidatePostIds(redis);
  const classicPostIds: Array<`t3_${string}`> = [];
  for (const postId of postIds) {
    if (isLinkId(postId) && (await hasClassicGoalData(redis, postId))) {
      classicPostIds.push(postId);
    }
  }
  return [postIds, classicPostIds];
}

async function hasClassicGoalData(
  redis: RedisClient,
  postId: `t3_${string}`,
): Promise<boolean> {
  const [postKind, postHeight] = await redis.hMGet(subscriberGoalsKey, [
    `${postId}${postKindSuffix}`,
    `${postId}${postHeightSuffix}`,
  ]);
  return (
    postKind === "subscriber-goal-v1" &&
    (postHeight === "regular" || postHeight === "short")
  );
}

async function revalidateRecoveredCreation({
  reddit,
  redis,
  post,
  candidatePostIds,
  automaticSuccessor,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  post: Awaited<ReturnType<typeof createGoalPost>>;
  candidatePostIds: string[];
  automaticSuccessor: boolean;
}): Promise<CreateSubscriberGoalResult | undefined> {
  if (await isSubscriberGoalPostRetired(redis, post.id)) {
    return createTerminalCreationResult("retired", post.id);
  }
  const availability = getPostAvailability(post);
  if (availability.status === "temporarily_removed") {
    throw new PostTemporarilyUnavailableError(post.id, availability.category);
  }
  if (availability.status === "terminal") {
    const removedByCategory = availability.category;
    await retireSubscriberGoalPost(
      redis,
      post.id,
      `creation_retry_removed:${removedByCategory}`,
    );
    return createTerminalCreationResult("retired", post.id);
  }
  const [successor, completedTime, pointer] = await Promise.all([
    redis.hGet(autoCreateNextGoalSuccessorsKey, post.id),
    redis.hGet(subscriberGoalsKey, `${post.id}${postCompletedTimeSuffix}`),
    getCanonicalGoalPointer(redis),
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
  const canonicalPostId = pointer?.canonicalPostId;
  if (
    canonicalPostId &&
    isLinkId(canonicalPostId) &&
    !possibleNewerIds.has(canonicalPostId) &&
    (!automaticSuccessor || (await hasClassicGoalData(redis, canonicalPostId)))
  ) {
    possibleNewerIds.add(canonicalPostId);
  }
  for (const candidateId of possibleNewerIds) {
    if (candidateId === post.id || !isLinkId(candidateId)) continue;
    if (
      automaticSuccessor &&
      (await isSubscriberGoalPostRetired(redis, candidateId))
    ) {
      continue;
    }
    try {
      const candidate = await reddit.getPostById(candidateId);
      if (
        automaticSuccessor &&
        getPostAvailability(candidate).status !== "active"
      ) {
        continue;
      }
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

async function prepareSubscriberGoalFlair({
  reddit,
  redis,
  subredditName,
  appUsername,
  canManageFlair,
}: {
  reddit: RedditClient;
  redis: RedisClient;
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
    const flair = await ensureSubscriberGoalPostFlair(
      reddit,
      redis,
      subredditName,
    );
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
