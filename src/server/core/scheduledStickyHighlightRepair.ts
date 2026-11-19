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

function logPlaytestAction(subreddit: Subreddit, entry: ModAction): void {
  logDiagnostic("info", "scheduled_sticky_playtest_action", {
    workflow,
    subredditName: subreddit.name,
    action: entry.type,
    actionId: entry.id,
    actionAt: entry.createdAt.getTime(),
    moderatorId: entry.moderatorId,
    targetId: entry.target?.id,
    description: entry.description,
    details: entry.details,
    category: toPostAction(entry) ? undefined : "no_post_target",
  });
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
  capturePlaytestEvidence = false,
  nowMs = Date.now(),
}: {
  reddit: RedditClient;
  redis: RedisClient;
  subreddit: Subreddit;
  repairEnabled: boolean;
  capturePlaytestEvidence?: boolean;
  nowMs?: number;
}): Promise<void> {
  const token = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(scanKey, token, {
    nx: true,
    expiration: new Date(nowMs + scanIntervalMs),
  });
  if ((await redis.get(scanKey)) !== token) return;

  const unpinEntries = await getRecentActions(
    reddit,
    subreddit,
    "unsticky",
    nowMs,
  );
  const unpinActions = unpinEntries
    .filter((entry) => !repairEnabled || isReplacement(entry))
    .map(toPostAction)
    .filter((action) => action !== undefined);
  if (!capturePlaytestEvidence && unpinActions.length === 0) return;

  const appUser = await reddit.getAppUser();
  const unpins = unpinActions.filter(
    ({ entry }) =>
      !entry.target?.author ||
      entry.target.author.toLowerCase() === appUser?.username.toLowerCase(),
  );
  if (!capturePlaytestEvidence && (!appUser?.id || unpins.length === 0)) return;

  const [stickyEntries, submissionEntries] = await Promise.all([
    getRecentActions(reddit, subreddit, "sticky", nowMs),
    getRecentActions(reddit, subreddit, "submit_scheduled_post", nowMs),
  ]);
  if (capturePlaytestEvidence) {
    logDiagnostic("info", "scheduled_sticky_playtest_scan", {
      workflow,
      subredditName: subreddit.name,
      unpinEntries: unpinEntries.length,
      stickyEntries: stickyEntries.length,
      submissionEntries: submissionEntries.length,
    });
    for (const entry of [
      ...unpinEntries,
      ...stickyEntries,
      ...submissionEntries,
    ]) {
      logPlaytestAction(subreddit, entry);
    }
  }
  if (!appUser?.id) return;
  const stickies = stickyEntries
    .map(toPostAction)
    .filter((action) => action !== undefined);
  const publications = new Map<LinkId, PostAction>();
  for (const entry of submissionEntries) {
    const submission = toPostAction(entry);
    if (submission && publications.has(submission.postId)) continue;
    const targetStickies = stickies.filter(
      ({ postId }) => postId === submission?.postId,
    );
    const moderatorStickies = targetStickies.filter(({ entry: action }) =>
      sameModerator(entry, action),
    );
    const matchingStickies = moderatorStickies.filter(
      ({ at }) =>
        submission && Math.abs(at - submission.at) <= publicationMatchMs,
    );
    const failure = /^automoderator$/i.test(entry.moderatorName)
      ? "automoderator"
      : !submission
        ? "no_post_target"
        : targetStickies.length === 0
          ? "sticky_target_mismatch"
          : moderatorStickies.length === 0
            ? "sticky_actor_mismatch"
            : matchingStickies.length === 0
              ? "sticky_timestamp_mismatch"
              : undefined;
    if (failure || !submission) {
      logDiagnostic("info", "scheduled_sticky_publication_unverified", {
        workflow,
        subredditName: subreddit.name,
        publicationLogId: entry.id,
        publicationLoggedAt: entry.createdAt.getTime(),
        publicationTargetId: entry.target?.id,
        category: failure,
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
        category: !publishedPost
          ? "published_post_missing"
          : publishedPost.id !== submission.postId ||
              publishedPost.subredditId !== subreddit.id
            ? "published_post_identity_mismatch"
            : "post_creation_timestamp_mismatch",
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
      const failure =
        unpin.postId === publication.postId
          ? "unpin_targets_publication"
          : !isReplacement(unpin.entry)
            ? "missing_replacement_detail"
            : !sameModerator(unpin.entry, publication.entry)
              ? "unpin_actor_mismatch"
              : Math.abs(unpin.at - publication.at) > publicationMatchMs
                ? "unpin_timestamp_mismatch"
                : undefined;
      if (failure) {
        if (capturePlaytestEvidence) {
          logDiagnostic("info", "scheduled_sticky_unpin_unverified", {
            workflow,
            subredditName: subreddit.name,
            postId: unpin.postId,
            unpinLogId: unpin.entry.id,
            unpinAt: unpin.at,
            publicationLogId: publication.entry.id,
            publishedPostId: publication.postId,
            publishedAt: publication.at,
            category: failure,
          });
        }
        continue;
      }
      if (unpin.at < (unpinsByGoal.get(unpin.postId)?.at ?? Infinity)) {
        unpinsByGoal.set(unpin.postId, unpin);
      }
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
