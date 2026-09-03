import { isLinkId, type RedditClient } from "../types";

export const subscriberGoalPostFlairText = "Subscriber Goal";
export const subscriberGoalPostFlairBackgroundColor = "#FF4500";

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
  subredditName: string,
): Promise<{ id: string }> {
  const templates = await reddit.getPostFlairTemplates(subredditName);
  const matches = templates.filter(
    (template) => template.text === subscriberGoalPostFlairText,
  );
  if (matches.length > 1) {
    console.warn(
      `[flair] multiple Subscriber Goal templates found; reusing ${matches[0]!.id}: subreddit=${subredditName} count=${matches.length}`,
    );
  }
  const existing = matches[0];
  if (!existing) {
    const created = await reddit.createPostFlairTemplate({
      subredditName,
      ...canonicalFlairSettings,
    });
    console.info(
      `[flair] created Subscriber Goal template: subreddit=${subredditName} flairId=${created.id}`,
    );
    return created;
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
      if (post.subredditId !== subreddit.id) continue;
      await reddit.setPostFlair({
        subredditName: subreddit.name,
        postId,
        flairTemplateId: flairId,
      });
      applied += 1;
    } catch (error) {
      failed.push(postId);
      console.warn(
        `[flair] failed to backfill Subscriber Goal post: subreddit=${subreddit.name} postId=${postId} error=${String(error)}`,
      );
    }
  }
  return { applied, failed };
}
