import type { ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import type { SubGoalColorTheme } from "../../shared/subGoalColorTheme";
import type { SubGoalLanguage } from "../../shared/subGoalPostI18n";
import type { SubGoalPostHeight } from "../../shared/subGoalPostHeight";
import { applyGoalPostFrameStyle, createGoalPost } from "./post";
import {
  cancelAllAutoCreateNextGoals,
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
import { clearUserStickies } from "../utils/redditUtils";
import {
  subscribeOnlyTextFallbackMaker,
  textFallbackMaker,
} from "../utils/textFallback";
import { toErrorMessage } from "../utils/crosspostLogs";
import {
  defaultAfterSubscribeAction,
  type AfterSubscribeAction,
} from "../../shared/afterSubscribeAction";

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
  stickyVerification?: Partial<StickyVerificationOptions>;
};

export type CreateSubscriberGoalResult = {
  post: Awaited<ReturnType<typeof createGoalPost>>;
  crosspostDispatchResult: CrosspostDispatchResult;
  stickyResult: StickyResult;
};

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
  const subreddit = await reddit.getCurrentSubreddit();
  const appUser = await reddit.getAppUser();
  if (!appUser?.username) {
    throw new Error("Could not resolve app user.");
  }

  const existingTrackedPosts = await getTrackedPosts(redis);
  const existingQueuedPosts = await getQueuedUpdates(redis);
  await clearUserStickies(reddit, appUser.username, {
    knownPostIds: [
      ...new Set([...existingTrackedPosts, ...existingQueuedPosts]),
    ],
    subreddit,
  });

  const isTinyPost = options.postHeight === "tiny";
  if (!isTinyPost && options.goal === undefined) {
    throw new Error("Subscriber goal is required for non-tiny posts.");
  }
  const textFallback = isTinyPost
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

  const post = await createGoalPost({
    title: options.title,
    subredditName: subreddit.name,
    textFallback,
    postHeight: options.postHeight,
    ...(options.submitAsUser === true ? { submitAsUser: true } : {}),
  });
  await applyGoalPostFrameStyle(post, options.postHeight);

  await setSavedSubredditDisplayName(redis, options.subredditDisplayName);
  const crosspostDispatchResult = isTinyPost
    ? await registerNewSubscribeOnlyPost(
        redis,
        appSettings,
        post,
        options.subredditDisplayName,
        options.colorTheme,
        options.language,
        options.afterSubscribeAction ?? defaultAfterSubscribeAction,
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
        options.postHeight as Exclude<SubGoalPostHeight, "tiny">,
        options.afterSubscribeAction ?? defaultAfterSubscribeAction,
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
      console.warn(
        `Failed to backfill subreddit display name for active post ${activePostId}: ${String(
          backfillError,
        )}`,
      );
    }
  }

  await post.approve();
  const stickyResult = await stickyAndVerifyPost(reddit, post, subreddit.name, {
    maxWaitMs:
      options.stickyVerification?.maxWaitMs ?? STICKY_VERIFICATION_MAX_WAIT_MS,
    intervalMs:
      options.stickyVerification?.intervalMs ?? STICKY_VERIFICATION_INTERVAL_MS,
  });

  if (options.cancelPendingAutoCreateGoals) {
    await cancelAllAutoCreateNextGoals(redis);
  }

  return { post, crosspostDispatchResult, stickyResult };
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
    console.warn(
      `[sticky] append failed: mode=append operation=write subreddit=${subredditName} postId=${post.id} error=${stickyErrorMessage}`,
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
      console.warn(
        `[sticky] verification refetch failed: mode=append operation=verify subreddit=${subredditName} postId=${post.id} attempt=${attempt} elapsedMs=${elapsedMs} error=${refetchErrorMessage}`,
      );
    }

    const verifier = (
      postToVerify as { isStickied?: () => boolean | Promise<boolean> }
    ).isStickied;
    if (typeof verifier !== "function") {
      lastVerificationErrorMessage =
        "Unable to verify sticky status because post.isStickied is unavailable.";
      console.warn(
        `[sticky] verification unavailable: mode=append operation=verify subreddit=${subredditName} postId=${post.id} attempt=${attempt} elapsedMs=${elapsedMs} refetched=${refetched} error=${lastVerificationErrorMessage}`,
      );
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
        console.warn(
          `[sticky] verification failed: mode=append operation=verify subreddit=${subredditName} postId=${post.id} attempt=${attempt} elapsedMs=${elapsedMs} refetched=${refetched} error=${lastVerificationErrorMessage}`,
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
