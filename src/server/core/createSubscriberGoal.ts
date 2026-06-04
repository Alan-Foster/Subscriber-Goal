import type { ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import type { SubGoalColorTheme } from "../../shared/subGoalColorTheme";
import type { SubGoalLanguage } from "../../shared/subGoalPostI18n";
import { createGoalPost } from "./post";
import {
  cancelAllAutoCreateNextGoals,
  registerNewSubGoalPost,
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
import { applyTextFallback } from "../utils/textFallback";
import { toErrorMessage } from "../utils/crosspostLogs";

type CreateSubscriberGoalOptions = {
  title: string;
  goal: number;
  subredditDisplayName: string;
  crosspost: boolean;
  colorTheme: SubGoalColorTheme;
  autoCreateNextGoal: boolean;
  language: SubGoalLanguage;
  cancelPendingAutoCreateGoals?: boolean;
  submitAsUser?: boolean;
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

  await clearUserStickies(reddit, appUser.username);

  const post = await createGoalPost({
    title: options.title,
    subredditName: subreddit.name,
    ...(options.submitAsUser === true ? { submitAsUser: true } : {}),
  });

  await applyTextFallback(post, {
    goal: options.goal,
    subscribers: subreddit.numberOfSubscribers,
    subredditName: options.subredditDisplayName,
    completedTime: null,
    language: options.language,
  });
  await setSavedSubredditDisplayName(redis, options.subredditDisplayName);

  const crosspostDispatchResult = await registerNewSubGoalPost(
    reddit,
    redis,
    appSettings,
    post,
    options.goal,
    options.crosspost,
    options.subredditDisplayName,
    options.colorTheme,
    options.autoCreateNextGoal,
    options.language,
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
  const stickyResult = await stickyAndVerifyPost(post, subreddit.name);

  if (options.cancelPendingAutoCreateGoals) {
    await cancelAllAutoCreateNextGoals(redis);
  }

  return { post, crosspostDispatchResult, stickyResult };
}

async function stickyAndVerifyPost(
  post: Awaited<ReturnType<typeof createGoalPost>>,
  subredditName: string,
): Promise<StickyResult> {
  let stickyErrorMessage: string | undefined;

  console.info(
    `[sticky] attempting to sticky new Subscriber Goal: subreddit=${subredditName} postId=${post.id}`,
  );
  try {
    await post.sticky();
    console.info(
      `[sticky] sticky call completed: subreddit=${subredditName} postId=${post.id}`,
    );
  } catch (error) {
    stickyErrorMessage = toErrorMessage(error);
    console.warn(
      `[sticky] sticky call failed: subreddit=${subredditName} postId=${post.id} error=${stickyErrorMessage}`,
    );
  }

  const verifier = (post as { isStickied?: () => boolean | Promise<boolean> })
    .isStickied;
  if (typeof verifier !== "function") {
    const errorMessage =
      stickyErrorMessage ??
      "Unable to verify sticky status because post.isStickied is unavailable.";
    console.warn(
      `[sticky] sticky verification unavailable: subreddit=${subredditName} postId=${post.id} error=${errorMessage}`,
    );
    return { status: "not_pinned", errorMessage };
  }

  try {
    const verifiedStickied = await Promise.resolve(verifier.call(post));
    console.info(
      `[sticky] sticky verification result: subreddit=${subredditName} postId=${post.id} verifiedStickied=${verifiedStickied}`,
    );
    if (!stickyErrorMessage && verifiedStickied) {
      return { status: "pinned", verifiedStickied };
    }

    return {
      status: "not_pinned",
      ...(stickyErrorMessage ? { errorMessage: stickyErrorMessage } : {}),
      verifiedStickied,
    };
  } catch (error) {
    const verificationErrorMessage = toErrorMessage(error);
    const errorMessage = stickyErrorMessage
      ? `${stickyErrorMessage}; verification failed: ${verificationErrorMessage}`
      : verificationErrorMessage;
    console.warn(
      `[sticky] sticky verification failed: subreddit=${subredditName} postId=${post.id} error=${verificationErrorMessage}`,
    );
    return { status: "not_pinned", errorMessage };
  }
}
