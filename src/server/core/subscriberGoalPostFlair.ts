import { getPostAvailability } from "../utils/postStatus";
import { isLinkId, type RedditClient, type RedisClient } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";
import { acquireRedisLock, releaseRedisLock } from "../utils/redisOwnedLock";

export const subscriberGoalPostFlairText = "Subscriber Goal";
export const subscriberGoalPostFlairBackgroundColor = "#FF4500";
const flairCreationLockKey = "subscriber_goal_flair_creation_v1_lock";

const canonicalFlairSettings = {
  allowableContent: "text" as const,
  backgroundColor: subscriberGoalPostFlairBackgroundColor,
  modOnly: true,
  text: subscriberGoalPostFlairText,
  textColor: "light" as const,
  allowUserEdits: false,
};

export async function ensureSubscriberGoalPostFlair(
  reddit: RedditClient,
  redis: RedisClient,
  subredditName: string,
): Promise<{ id: string }> {
  const templates = await reddit.getPostFlairTemplates(subredditName);
  const matches = templates.filter(
    (template) => template.text === subscriberGoalPostFlairText,
  );
  if (matches.length > 1) {
    logDiagnostic("warn", "post_flair_duplicate_templates", {
      workflow: "subscriber_goal_flair",
      phase: "template_lookup",
      count: matches.length,
    });
  }
  let existing = matches[0];
  if (!existing) {
    const token = await acquireRedisLock(redis, flairCreationLockKey, 60_000);
    try {
      existing = (await reddit.getPostFlairTemplates(subredditName)).find(
        (template) => template.text === subscriberGoalPostFlairText,
      );
      if (!existing) {
        if (!token)
          throw new Error(
            "Subscriber Goal flair creation is already in progress.",
          );
        const created = await reddit.createPostFlairTemplate({
          subredditName,
          ...canonicalFlairSettings,
        });
        console.info(
          `[flair] created Subscriber Goal template: subreddit=${subredditName} flairId=${created.id}`,
        );
        return created;
      }
    } finally {
      if (token) await releaseRedisLock(redis, flairCreationLockKey, token);
    }
  }

  const needsNormalization =
    existing.allowableContent !== canonicalFlairSettings.allowableContent ||
    (existing.backgroundColor ?? "").toUpperCase() !==
      canonicalFlairSettings.backgroundColor ||
    existing.modOnly !== canonicalFlairSettings.modOnly ||
    existing.textColor !== canonicalFlairSettings.textColor ||
    existing.allowUserEdits !== canonicalFlairSettings.allowUserEdits;
  if (!needsNormalization) {
    return existing;
  }
  const normalized = await existing.edit(canonicalFlairSettings);
  console.info(
    `[flair] normalized Subscriber Goal template: subreddit=${subredditName} flairId=${normalized.id}`,
  );
  return normalized;
}

export async function backfillSubscriberGoalPostFlair(
  reddit: RedditClient,
  subreddit: { id: string; name: string },
  postIds: string[],
  flairId: string,
  {
    canStart = () => true,
    afterPostId = "",
  }: { canStart?: () => boolean; afterPostId?: string } = {},
): Promise<{ applied: number; failed: string[]; nextAfterPostId?: string }> {
  let applied = 0;
  const failed: string[] = [];
  let lastInspected = afterPostId;
  const candidates = [...new Set(postIds)].filter(isLinkId).sort();
  for (const postId of candidates) {
    if (postId <= afterPostId) continue;
    if (!canStart()) return { applied, failed, nextAfterPostId: lastInspected };
    try {
      const post = await reddit.getPostById(postId);
      if (
        post.subredditId === subreddit.id &&
        getPostAvailability(post).status === "active" &&
        post.flair?.templateId !== flairId
      ) {
        if (!canStart())
          return { applied, failed, nextAfterPostId: lastInspected };
        await reddit.setPostFlair({
          subredditName: subreddit.name,
          postId,
          flairTemplateId: flairId,
        });
        applied += 1;
      }
    } catch (error) {
      failed.push(postId);
      logDiagnostic(
        "warn",
        "post_flair_failed",
        { workflow: "subscriber_goal_flair", phase: "backfill", postId },
        error,
      );
    }
    lastInspected = postId;
  }
  return { applied, failed };
}
