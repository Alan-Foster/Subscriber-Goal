import type { ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import type { SubGoalColorTheme } from "../../shared/subGoalColorTheme";
import type { SubGoalLanguage } from "../../shared/subGoalPostI18n";
import type { SubGoalPostHeight } from "../../shared/subGoalPostHeight";
import { applyGoalPostFrameStyle, createGoalPost } from "./post";
import {
  cancelAllAutoCreateNextGoals,
  registerNewCtaOnlyPost,
  registerNewSubGoalPost,
  registerNewSubscribeOnlyPost,
  setSubredditDisplayNameForPost,
  type CrosspostDispatchResult,
} from "../data/subGoalData";
import { setSavedSubredditDisplayName } from "../data/subredditDisplayNameData";
import {
  getQueuedUpdates,
  getTrackedPosts,
  queueUpdate,
} from "../data/updaterData";
import { isLinkId } from "../types";
import { clearSubscriberGoalStickies } from "../utils/redditUtils";
import {
  ctaOnlyTextFallbackMaker,
  subscribeOnlyTextFallbackMaker,
  textFallbackMaker,
} from "../utils/textFallback";
import { toErrorMessage } from "../utils/crosspostLogs";
import { logDiagnostic } from "../../shared/diagnostics";
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
  stickyVerification?: Partial<StickyVerificationOptions>;
};

export type CreateSubscriberGoalResult = {
  post: Awaited<ReturnType<typeof createGoalPost>>;
  crosspostDispatchResult: CrosspostDispatchResult;
  stickyResult: StickyResult;
  flairResult: SubscriberGoalFlairResult;
};

export type SubscriberGoalFlairResult =
  | { status: "applied"; flairId: string }
  | {
      status: "omitted";
      reason: "missing_permission" | "preparation_failed";
    };

export class SubscriberGoalModeratorPermissionError extends Error {
  constructor(appUsername: string | undefined, subredditName: string) {
    const appAccount = appUsername
      ? `u/${appUsername}`
      : "the Subscriber Goal app account";
    super(
      `${appAccount} must be a moderator of r/${subredditName} with Manage Posts permission. Restore the app account's moderator permissions or reinstall Subscriber Goal, then try again.`,
    );
    this.name = "SubscriberGoalModeratorPermissionError";
  }
}

export class SubscriberGoalCreationInProgressError extends Error {
  constructor() {
    super(
      "This Subscriber Goal creation is already in progress. Please wait a moment and try again.",
    );
    this.name = "SubscriberGoalCreationInProgressError";
  }
}

export type StickyResult = {
  status: "pinned" | "not_pinned";
  errorMessage?: string;
  verifiedStickied?: boolean;
};

const STICKY_VERIFICATION_MAX_WAIT_MS = 30_000;
const STICKY_VERIFICATION_INTERVAL_MS = 5_000;

type StickyVerificationOptions = {
  maxWaitMs: number;
  intervalMs: number;
};

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
  const operationId = options.operationId?.trim();
  if (!operationId) {
    return createSubscriberGoalInternal({ reddit, redis, appSettings, options });
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
      !raw.stickyResult ||
      !raw.flairResult
    ) {
      return undefined;
    }
    try {
      const post = (await reddit.getPostById(postId)) as unknown as Awaited<
        ReturnType<typeof createGoalPost>
      >;
      return {
        post,
        crosspostDispatchResult: JSON.parse(raw.crosspostDispatchResult),
        stickyResult: JSON.parse(raw.stickyResult),
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
    throw new SubscriberGoalCreationInProgressError();
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
      stickyResult: JSON.stringify(result.stickyResult),
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
  });
  const { appUsername, permissions } = health;
  const hasAllPermissions = permissions.includes("all");
  if (health.status === "unknown") {
    throw new Error(
      `Reddit could not verify Subscriber Goal's moderator permissions in r/${subreddit.name}. Please try again shortly.`,
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
    );
  }

  const flairResult = await prepareSubscriberGoalFlair({
    reddit,
    subredditName: subreddit.name,
    appUsername,
    canManageFlair: hasAllPermissions || permissions.includes("flair"),
  });
  const existingGoalPostIds = await getSubscriberGoalCandidatePostIds(redis);

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
  let stickyResult: StickyResult;
  try {
    await clearSubscriberGoalStickies(reddit, {
      knownPostIds: existingGoalPostIds,
      subreddit,
    });
    stickyResult = await stickyAndVerifyPost(reddit, post, subreddit.name, {
      maxWaitMs:
        options.stickyVerification?.maxWaitMs ??
        STICKY_VERIFICATION_MAX_WAIT_MS,
      intervalMs:
        options.stickyVerification?.intervalMs ??
        STICKY_VERIFICATION_INTERVAL_MS,
    });
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    logDiagnostic(
      "warn",
      "sticky_operation_failed",
      {
        workflow: "create_subscriber_goal",
        phase: "replacement_cleanup",
        postId: post.id,
      },
      error,
    );
    stickyResult = {
      status: "not_pinned",
      errorMessage,
      verifiedStickied: false,
    };
  }

  if (options.cancelPendingAutoCreateGoals) {
    await cancelAllAutoCreateNextGoals(redis);
  }

  return { post, crosspostDispatchResult, stickyResult, flairResult };
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function stickyAndVerifyPost(
  reddit: RedditClient,
  post: Awaited<ReturnType<typeof createGoalPost>>,
  subredditName: string,
  verificationOptions: StickyVerificationOptions,
): Promise<StickyResult> {
  let stickyErrorMessage: string | undefined;
  let lastVerificationErrorMessage: string | undefined;
  let lastVerifiedStickied: boolean | undefined;

  console.info(
    `[sticky] append attempt: mode=append operation=write subreddit=${subredditName} postId=${post.id}`,
  );
  try {
    await post.sticky();
    console.info(
      `[sticky] append completed: mode=append operation=write subreddit=${subredditName} postId=${post.id}`,
    );
  } catch (error) {
    stickyErrorMessage = toErrorMessage(error);
    logDiagnostic(
      "warn",
      "sticky_operation_failed",
      { workflow: "sticky", phase: "write", postId: post.id },
      error,
    );
  }

  const startedAt = Date.now();
  let attempt = 1;
  while (true) {
    const elapsedMs = Date.now() - startedAt;
    let postToVerify = post;
    let refetched = false;

    try {
      const refetchedPost = await reddit.getPostById(post.id);
      if (
        typeof (
          refetchedPost as { isStickied?: () => boolean | Promise<boolean> }
        )?.isStickied === "function"
      ) {
        postToVerify = refetchedPost;
        refetched = true;
      }
    } catch (error) {
      const refetchErrorMessage = toErrorMessage(error);
      lastVerificationErrorMessage = refetchErrorMessage;
      logDiagnostic(
        "warn",
        "sticky_operation_failed",
        {
          workflow: "sticky",
          phase: "verification_refetch",
          postId: post.id,
          attempt,
          elapsedMs,
        },
        error,
      );
    }

    const verifier = (
      postToVerify as { isStickied?: () => boolean | Promise<boolean> }
    ).isStickied;
    if (typeof verifier !== "function") {
      lastVerificationErrorMessage =
        "Unable to verify sticky status because post.isStickied is unavailable.";
      logDiagnostic("warn", "sticky_verification_unavailable", {
        workflow: "sticky",
        phase: "verification",
        postId: post.id,
        attempt,
        elapsedMs,
        refetched,
      });
    } else {
      try {
        const verifiedStickied = await Promise.resolve(
          verifier.call(postToVerify),
        );
        lastVerifiedStickied = verifiedStickied;
        console.info(
          `[sticky] verification result: mode=append operation=verify subreddit=${subredditName} postId=${post.id} attempt=${attempt} elapsedMs=${elapsedMs} refetched=${refetched} verifiedStickied=${verifiedStickied}`,
        );
        if (verifiedStickied) {
          return { status: "pinned", verifiedStickied };
        }
      } catch (error) {
        lastVerificationErrorMessage = toErrorMessage(error);
        logDiagnostic(
          "warn",
          "sticky_operation_failed",
          {
            workflow: "sticky",
            phase: "verification",
            postId: post.id,
            attempt,
            elapsedMs,
            refetched,
          },
          error,
        );
      }
    }

    if (elapsedMs >= verificationOptions.maxWaitMs) {
      break;
    }

    await sleep(
      Math.min(
        verificationOptions.intervalMs,
        verificationOptions.maxWaitMs - elapsedMs,
      ),
    );
    attempt += 1;
  }

  const errorMessage =
    stickyErrorMessage && lastVerificationErrorMessage
      ? `${stickyErrorMessage}; verification failed: ${lastVerificationErrorMessage}`
      : (stickyErrorMessage ?? lastVerificationErrorMessage);

  return {
    status: "not_pinned",
    ...(errorMessage ? { errorMessage } : {}),
    ...(lastVerifiedStickied !== undefined
      ? { verifiedStickied: lastVerifiedStickied }
      : {}),
  };
}
