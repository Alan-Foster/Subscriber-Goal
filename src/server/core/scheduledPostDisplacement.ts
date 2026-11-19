import { subscriberGoalPostKind } from "../../shared/postKind";
import { logDiagnostic } from "../../shared/diagnostics";
import { getSubGoalData } from "../data/subGoalData";
import {
  isLinkId,
  type LinkId,
  type RedditClient,
  type RedisClient,
} from "../types";
import {
  communityHighlightLimit,
  getCommunityHighlights,
} from "../utils/communityHighlights";
import { getPostAvailability, isMissingPostError } from "../utils/postStatus";
import {
  CommunityGoalMutationInProgressError,
  withCommunityGoalMutationLease,
} from "./communityGoalMutation";
import { isSubscriberGoalPostRetired } from "./postRetirement";

export const scheduledPostDisplacementKey = "scheduled_post_displacement_v1";
const waitMs = 15 * 60_000;
const retryWindowMs = 60 * 60_000;
const logLimit = 25;
const workflow = "scheduled_post_displacement";

type Subreddit = Awaited<ReturnType<RedditClient["getCurrentSubreddit"]>>;

export async function recordScheduledPostDisplacementCheck(
  redis: RedisClient,
  postId: LinkId,
  actionedAt: string | undefined,
): Promise<void> {
  const unpinnedAt = Date.parse(actionedAt ?? "");
  if (!Number.isFinite(unpinnedAt)) {
    logDiagnostic("warn", "scheduled_post_displacement_invalid_unpin_time", {
      workflow,
      postId,
    });
    return;
  }

  await redis.hSet(scheduledPostDisplacementKey, {
    [postId]: String(unpinnedAt),
  });
  logDiagnostic("info", "scheduled_post_displacement_queued", {
    workflow,
    postId,
    unpinnedAt,
    dueAt: unpinnedAt + waitMs,
  });
}

// A newer unpin can replace the hash field while the scheduler awaits Reddit.
async function consumeCheck(
  redis: RedisClient,
  postId: string,
  expected: string,
): Promise<boolean> {
  const tx = await redis.watch(scheduledPostDisplacementKey);
  let inMulti = false;
  try {
    if ((await redis.hGet(scheduledPostDisplacementKey, postId)) !== expected) {
      await tx.unwatch();
      return false;
    }
    await tx.multi();
    inMulti = true;
    await tx.hDel(scheduledPostDisplacementKey, [postId]);
    return (await tx.exec()).length > 0;
  } catch (error) {
    if (inMulti) await tx.discard();
    else await tx.unwatch();
    throw error;
  }
}

async function repinGoal(
  reddit: RedditClient,
  redis: RedisClient,
  subreddit: Subreddit,
  postId: LinkId,
): Promise<void> {
  const post = await reddit.getPostById(postId).catch((error: unknown) => {
    if (!isMissingPostError(error, postId)) throw error;
  });
  if (
    !post ||
    post.id !== postId ||
    post.subredditId !== subreddit.id ||
    post.archived ||
    getPostAvailability(post).status !== "active"
  )
    return;

  const [appUser, goal, retired] = await Promise.all([
    reddit.getAppUser(),
    getSubGoalData(redis, postId),
    isSubscriberGoalPostRetired(redis, postId),
  ]);
  if (
    !appUser?.id ||
    post.authorId !== appUser.id ||
    retired ||
    goal.postKind !== subscriberGoalPostKind ||
    goal.goal <= 0 ||
    goal.completedTime ||
    subreddit.numberOfSubscribers >= goal.goal
  )
    return;

  const highlights = await getCommunityHighlights(subreddit);
  if (
    highlights.length >= communityHighlightLimit ||
    highlights.some((highlight) => highlight.postId === postId)
  )
    return;

  await post.highlight();
  const after = await getCommunityHighlights(subreddit);
  const position = after.findIndex((highlight) => highlight.postId === postId);
  logDiagnostic("info", "scheduled_post_displacement_repinned", {
    workflow,
    postId,
    listedPosition: position === -1 ? undefined : position + 1,
    highlightCount: after.length,
  });
}

export async function processDueScheduledPostDisplacementChecks({
  reddit,
  redis,
  subreddit,
  nowMs = Date.now(),
}: {
  reddit: RedditClient;
  redis: RedisClient;
  subreddit: Subreddit;
  nowMs?: number;
}): Promise<void> {
  const checks = await redis.hGetAll(scheduledPostDisplacementKey);
  for (const [postId, raw] of Object.entries(checks)) {
    const unpinnedAt = Number(raw);
    const dueAt = unpinnedAt + waitMs;
    if (
      !isLinkId(postId) ||
      !Number.isFinite(unpinnedAt) ||
      nowMs >= dueAt + retryWindowMs
    ) {
      await consumeCheck(redis, postId, raw);
      continue;
    }
    if (nowMs < dueAt) continue;

    const diagnostic = {
      workflow,
      postId,
      unpinnedAt,
      dueAt,
      subredditName: subreddit.name,
    };
    try {
      await withCommunityGoalMutationLease(redis, async () => {
        if ((await redis.hGet(scheduledPostDisplacementKey, postId)) !== raw)
          return;
        let submissions;
        try {
          submissions = await reddit
            .getModerationLog({
              subredditName: subreddit.name,
              type: "submit_scheduled_post",
              limit: logLimit,
              pageSize: logLimit,
            })
            .get(logLimit);
        } catch (error) {
          logDiagnostic(
            "warn",
            "scheduled_post_displacement_log_read_failed",
            diagnostic,
            error,
          );
          return;
        }
        const match = submissions.find((entry) => {
          const publishedAt = entry.createdAt.getTime();
          return (
            entry.type === "submit_scheduled_post" &&
            publishedAt >= unpinnedAt - waitMs &&
            publishedAt <= dueAt
          );
        });
        logDiagnostic("info", "scheduled_post_displacement_checked", {
          ...diagnostic,
          entriesRead: submissions.length,
          matchedAt: match?.createdAt.getTime(),
          matchedActionId: match?.id,
        });

        // Consume before the write so a failed or ambiguous attempt cannot repeat.
        if (!(await consumeCheck(redis, postId, raw)) || !match) return;
        await repinGoal(reddit, redis, subreddit, postId);
      });
    } catch (error) {
      if (!(error instanceof CommunityGoalMutationInProgressError)) {
        logDiagnostic(
          "warn",
          "scheduled_post_displacement_check_failed",
          diagnostic,
          error,
        );
      }
    }
  }
}
