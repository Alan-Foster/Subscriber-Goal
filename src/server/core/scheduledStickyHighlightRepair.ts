import type { ModAction } from "@devvit/reddit";
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

const minuteMs = 60_000;
const scanIntervalMs = 5 * minuteMs;
const lookbackMs = 30 * minuteMs;
const unpinWaitMs = 15 * minuteMs;
const publicationMatchMs = 15 * minuteMs;
const stickyMatchMs = 2 * minuteMs;
const logPageSize = 100;
const logLimit = 3 * logPageSize;
const scanKey = "scheduled_sticky_highlight_scan_v1";
const repairKeyPrefix = "scheduled_sticky_highlight_repair_v1";
const workflow = "scheduled_sticky_highlight_repair";

type Subreddit = Awaited<ReturnType<RedditClient["getCurrentSubreddit"]>>;
type LogType = "unsticky" | "sticky" | "submit_scheduled_post";
type PostAction = { entry: ModAction; postId: LinkId; at: number };

function toPostAction(entry: ModAction): PostAction | undefined {
  const postId = entry.target?.id;
  if (postId && isLinkId(postId))
    return { entry, postId, at: entry.createdAt.getTime() };
}

function isReplacement(entry: ModAction): boolean {
  return /\breplaced\b/i.test(
    `${entry.details ?? ""} ${entry.description ?? ""}`,
  );
}

function sameModerator(left: ModAction, right: ModAction): boolean {
  if (left.moderatorId && right.moderatorId) {
    return left.moderatorId === right.moderatorId;
  }
  return (
    Boolean(left.moderatorName) &&
    left.moderatorName.toLowerCase() === right.moderatorName?.toLowerCase()
  );
}

async function getRecentActions(
  reddit: RedditClient,
  subreddit: Subreddit,
  type: LogType,
  nowMs: number,
): Promise<ModAction[]> {
  const entries: ModAction[] = [];
  let inspected = 0;
  let pageHasRecentEntry = false;
  for await (const entry of reddit.getModerationLog({
    subredditName: subreddit.name,
    type,
    pageSize: logPageSize,
    limit: logLimit,
  })) {
    inspected += 1;
    const at = entry.createdAt.getTime();
    if (at >= nowMs - lookbackMs) pageHasRecentEntry = true;
    if (
      at >= nowMs - lookbackMs &&
      at <= nowMs &&
      entry.type === type &&
      entry.subredditId === subreddit.id
    ) {
      entries.push(entry);
    }
    // Check a whole page before stopping so a late row in a mixed page is seen.
    if (inspected % logPageSize !== 0) continue;
    if (!pageHasRecentEntry) break;
    if (inspected === logLimit) {
      logDiagnostic("warn", "scheduled_sticky_log_limit_reached", {
        workflow,
        category: type,
        subredditName: subreddit.name,
      });
      break;
    }
    pageHasRecentEntry = false;
  }
  return entries;
}

async function getPostIfPresent(reddit: RedditClient, postId: LinkId) {
  try {
    return await reddit.getPostById(postId);
  } catch (error) {
    if (!isMissingPostError(error, postId)) throw error;
  }
}

async function repairGoal({
  reddit,
  redis,
  subreddit,
  appUserId,
  publication,
  unpin,
  repairEnabled,
  nowMs,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  subreddit: Subreddit;
  appUserId: string;
  publication: PostAction;
  unpin: PostAction;
  repairEnabled: boolean;
  nowMs: number;
}): Promise<void> {
  const key = `${repairKeyPrefix}:${unpin.postId}:${publication.postId}`;
  if (await redis.get(key)) return;
  const goalPost = await getPostIfPresent(reddit, unpin.postId);
  if (
    !goalPost ||
    goalPost.id !== unpin.postId ||
    goalPost.subredditId !== subreddit.id ||
    goalPost.authorId !== appUserId ||
    goalPost.archived ||
    getPostAvailability(goalPost).status !== "active" ||
    (await isSubscriberGoalPostRetired(redis, unpin.postId))
  )
    return;

  const goal = await getSubGoalData(redis, unpin.postId);
  if (
    goal.goal <= 0 ||
    goal.completedTime ||
    subreddit.numberOfSubscribers >= goal.goal
  )
    return;

  const diagnostic = {
    workflow,
    subredditName: subreddit.name,
    postId: unpin.postId,
    publishedPostId: publication.postId,
    publishedAt: publication.at,
    publicationLogId: publication.entry.id,
    publicationLoggedAt: publication.entry.createdAt.getTime(),
    unpinAt: unpin.at,
    unpinLogId: unpin.entry.id,
    repairDueAt: unpin.at + unpinWaitMs,
  };
  if (!repairEnabled) {
    logDiagnostic("info", "scheduled_sticky_repair_candidate", diagnostic);
    return;
  }
  // The community mutation lease serializes the claim with other app writes.
  // Keep it after an ambiguous write so a moderator's second unpin is respected.
  await redis.set(key, unpin.entry.id, {
    expiration: new Date(nowMs + lookbackMs + publicationMatchMs),
  });
  let highlights;
  try {
    highlights = await getCommunityHighlights(subreddit);
  } catch (error) {
    await redis.del(key);
    throw error;
  }
  const alreadyHighlighted = highlights.some(
    ({ postId }) => postId === unpin.postId,
  );
  if (alreadyHighlighted || highlights.length >= communityHighlightLimit) {
    logDiagnostic("info", "scheduled_sticky_repair_skipped", {
      ...diagnostic,
      category: alreadyHighlighted ? "already_highlighted" : "capacity",
    });
    return;
  }
  await goalPost.highlight();
  logDiagnostic("info", "scheduled_sticky_repair_applied", diagnostic);
}

export async function processScheduledStickyHighlightRepair({
  reddit,
  redis,
  subreddit,
  repairEnabled,
  nowMs = Date.now(),
}: {
  reddit: RedditClient;
  redis: RedisClient;
  subreddit: Subreddit;
  repairEnabled: boolean;
  nowMs?: number;
}): Promise<void> {
  const token = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(scanKey, token, {
    nx: true,
    expiration: new Date(nowMs + scanIntervalMs),
  });
  if ((await redis.get(scanKey)) !== token) return;

  const unpinActions = (
    await getRecentActions(reddit, subreddit, "unsticky", nowMs)
  )
    .filter((entry) => !repairEnabled || isReplacement(entry))
    .map(toPostAction)
    .filter((action) => action !== undefined);
  if (unpinActions.length === 0) return;

  const appUser = await reddit.getAppUser();
  if (!appUser?.id) return;
  const unpins = unpinActions.filter(
    ({ entry }) =>
      !entry.target?.author ||
      entry.target.author.toLowerCase() === appUser.username.toLowerCase(),
  );
  if (unpins.length === 0) return;

  const [stickyEntries, submissionEntries] = await Promise.all([
    getRecentActions(reddit, subreddit, "sticky", nowMs),
    getRecentActions(reddit, subreddit, "submit_scheduled_post", nowMs),
  ]);
  const stickies = stickyEntries
    .map(toPostAction)
    .filter((action) => action !== undefined);
  const publications = new Map<LinkId, PostAction>();
  for (const entry of submissionEntries) {
    if (/^automoderator$/i.test(entry.moderatorName)) continue;
    const submission = toPostAction(entry);
    if (submission && publications.has(submission.postId)) continue;
    const matchingStickies =
      submission &&
      stickies.filter(
        ({ entry: action, postId, at }) =>
          postId === submission.postId &&
          sameModerator(entry, action) &&
          Math.abs(at - submission.at) <= publicationMatchMs,
      );
    if (!submission || !matchingStickies?.length) {
      logDiagnostic("info", "scheduled_sticky_publication_unverified", {
        workflow,
        subredditName: subreddit.name,
        publicationLogId: entry.id,
        publicationLoggedAt: entry.createdAt.getTime(),
        publicationTargetId: entry.target?.id,
        category: submission ? "no_matching_sticky" : "no_post_target",
      });
      continue;
    }
    const publishedPost = await getPostIfPresent(reddit, submission.postId);
    const at = publishedPost?.createdAt.getTime();
    if (
      publishedPost?.id === submission.postId &&
      publishedPost.subredditId === subreddit.id &&
      at !== undefined &&
      at >= nowMs - lookbackMs &&
      at <= nowMs &&
      Math.abs(at - submission.at) <= publicationMatchMs &&
      matchingStickies.some(
        (sticky) => Math.abs(at - sticky.at) <= stickyMatchMs,
      )
    ) {
      publications.set(submission.postId, { ...submission, at });
    } else {
      logDiagnostic("info", "scheduled_sticky_publication_unverified", {
        workflow,
        subredditName: subreddit.name,
        publicationLogId: entry.id,
        publicationLoggedAt: submission.at,
        publishedPostId: submission.postId,
        publishedAt: at,
        stickyAt: matchingStickies[0]?.at,
        category: "post_creation_not_confirmed",
      });
    }
  }
  if (!repairEnabled) {
    for (const unpin of unpins) {
      logDiagnostic("info", "scheduled_sticky_unpin_observed", {
        workflow,
        subredditName: subreddit.name,
        postId: unpin.postId,
        unpinAt: unpin.at,
        unpinLogId: unpin.entry.id,
        replacement: isReplacement(unpin.entry),
      });
    }
  }

  // Use the earliest observed unpin for each goal/publication pair, regardless of listing order.
  for (const publication of publications.values()) {
    const unpinsByGoal = new Map<LinkId, PostAction>();
    for (const unpin of unpins) {
      if (
        unpin.postId !== publication.postId &&
        isReplacement(unpin.entry) &&
        sameModerator(unpin.entry, publication.entry) &&
        Math.abs(unpin.at - publication.at) <= publicationMatchMs &&
        unpin.at < (unpinsByGoal.get(unpin.postId)?.at ?? Infinity)
      )
        unpinsByGoal.set(unpin.postId, unpin);
    }
    for (const unpin of unpinsByGoal.values()) {
      if (repairEnabled && nowMs - unpin.at < unpinWaitMs) continue;
      try {
        const inspectAndRepair = () =>
          repairGoal({
            reddit,
            redis,
            subreddit,
            appUserId: appUser.id,
            publication,
            unpin,
            repairEnabled,
            nowMs,
          });
        if (repairEnabled) {
          await withCommunityGoalMutationLease(redis, inspectAndRepair);
        } else {
          await inspectAndRepair();
        }
      } catch (error) {
        if (error instanceof CommunityGoalMutationInProgressError) return;
        logDiagnostic(
          "warn",
          "scheduled_sticky_repair_failed",
          {
            workflow,
            subredditName: subreddit.name,
            postId: unpin.postId,
            publishedPostId: publication.postId,
            publishedAt: publication.at,
            unpinAt: unpin.at,
          },
          error,
        );
      }
    }
  }
}
