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
  saveHighlightManagementBaseline,
  type HighlightReconciliationContext,
} from "../data/highlightManagement";
import { scheduleHighlightRepair } from "../data/highlightRepair";
import { clearHighlightContradictionIncident } from "../data/highlightContradiction";

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
};

export type CreateSubscriberGoalResult = {
  post: Awaited<ReturnType<typeof createGoalPost>>;
  crosspostDispatchResult: CrosspostDispatchResult;
  highlightResult: HighlightResult;
  flairResult: SubscriberGoalFlairResult;
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
  const recoverComplete = async (
    raw: Record<string, string>,
  ): Promise<CreateSubscriberGoalResult | undefined> => {
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
      return {
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
  };

  const existing = await redis.hGetAll(operationKey);
  const completed = await recoverComplete(existing);
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
    const recoveredComplete = await recoverComplete(reloaded);
    if (recoveredComplete) return recoveredComplete;
    await redis.hSet(operationKey, {
      status: reloaded.status || "pending",
      startedAt: reloaded.startedAt || String(nowMs),
      updatedAt: String(nowMs),
    });
    const submittedPostId = reloaded.postId ?? "";
    const recoveredPost = isLinkId(submittedPostId)
      ? ((await reddit.getPostById(submittedPostId)) as unknown as Awaited<
          ReturnType<typeof createGoalPost>
        >)
      : undefined;
    const result = await createSubscriberGoalInternal(
      { reddit, redis, appSettings, options },
      {
        ...(recoveredPost ? { recoveredPost } : {}),
        onPostSubmitted: async (postId) => {
          await redis.hSet(operationKey, {
            status: "post_submitted",
            postId,
            updatedAt: String(Date.now()),
          });
        },
      },
    );
    await redis.hSet(operationKey, {
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
    onPostSubmitted: (postId: string) => Promise<void>;
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
  const existingGoalPostIds = await getSubscriberGoalCandidatePostIds(redis);
  const existingClassicGoalPostIds = [] as Array<`t3_${string}`>;
  for (const postId of existingGoalPostIds) {
    const [postKind, postHeight] = await redis.hMGet(subscriberGoalsKey, [
      `${postId}${postKindSuffix}`,
      `${postId}${postHeightSuffix}`,
    ]);
    if (
      postKind === "subscriber-goal-v1" &&
      (postHeight === "regular" || postHeight === "short")
    ) {
      if (isLinkId(postId)) existingClassicGoalPostIds.push(postId);
    }
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

  const post =
    recovery?.recoveredPost ??
    (await createGoalPost({
      title: options.title,
      subredditName: subreddit.name,
      textFallback,
      postHeight: options.postHeight,
      language: options.language,
      ...(flairResult.status === "applied"
        ? { flairId: flairResult.flairId }
        : {}),
      ...(options.submitAsUser === true ? { submitAsUser: true } : {}),
    }));
  if (!recovery?.recoveredPost) await recovery?.onPostSubmitted(post.id);
  await applyGoalPostFrameStyle(post, options.postHeight);

  await setSavedSubredditDisplayName(redis, options.subredditDisplayName);
  const crosspostDispatchResult = isCtaOnlyPost
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
          options.crosspost,
          options.subredditDisplayName,
          options.colorTheme,
          options.autoCreateNextGoal,
          options.language,
          options.headerText,
          options.postHeight as Exclude<SubGoalPostHeight, "tiny" | "cta">,
          options.afterSubscribeAction ?? defaultAfterSubscribeAction,
          ...afterSubscribePresetArgs,
        );

  if (!isCompactActionPost) {
    for (const olderPostId of existingClassicGoalPostIds) {
      if (olderPostId === post.id) continue;
      await redis.hSet(autoCreateNextGoalSuccessorsKey, {
        [olderPostId]: post.id,
      });
      await cancelAutoCreateNextGoal(redis, olderPostId);
    }
  }

  const trackedPosts = await getTrackedPosts(redis);
  const queuedPosts = await getQueuedUpdates(redis);
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

  if (options.cancelPendingAutoCreateGoals) {
    await cancelAllAutoCreateNextGoals(redis);
  }

  return { post, crosspostDispatchResult, highlightResult, flairResult };
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
