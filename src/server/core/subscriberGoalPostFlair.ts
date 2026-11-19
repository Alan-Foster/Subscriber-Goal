import { getPostAvailability } from "../utils/postStatus";
import { isLinkId, type RedditClient, type RedisClient } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";

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
    const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    await redis.set(flairCreationLockKey, token, {
      nx: true,
      expiration: new Date(Date.now() + 60_000),
    });
    const acquired = (await redis.get(flairCreationLockKey)) === token;
    try {
      existing = (await reddit.getPostFlairTemplates(subredditName)).find(
        (template) => template.text === subscriberGoalPostFlairText,
      );
      if (!existing) {
        if (!acquired)
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
      if (acquired && (await redis.get(flairCreationLockKey)) === token) {
        await redis.del(flairCreationLockKey);
      }
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
): Promise<{ applied: number; failed: string[] }> {
  let applied = 0;
  const failed: string[] = [];
  for (const postId of [...new Set(postIds)]) {
    if (!isLinkId(postId)) continue;
    try {
      const post = await reddit.getPostById(postId);
      if (
        post.subredditId !== subreddit.id ||
        getPostAvailability(post).status !== "active"
      )
        continue;
      await reddit.setPostFlair({
        subredditName: subreddit.name,
        postId,
        flairTemplateId: flairId,
      });
      applied += 1;
    } catch (error) {
      failed.push(postId);
      logDiagnostic(
        "warn",
        "post_flair_failed",
        { workflow: "subscriber_goal_flair", phase: "backfill", postId },
        error,
      );
    }
  }
  return { applied, failed };
}
