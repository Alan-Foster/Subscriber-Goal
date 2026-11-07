import { logDiagnostic } from "../../shared/diagnostics";
import {
  ctaOnlyPostKind,
  subscriberGoalPostKind,
  subscribeOnlyPostKind,
} from "../../shared/postKind";
import type { RedditClient, RedisClient } from "../types";
import { isLinkId, type LinkId } from "../types";
import { getTerminalRemovedByCategory } from "../utils/postStatus";
import {
  postGoalSuffix,
  postHeightSuffix,
  postKindSuffix,
  subscriberGoalsKey,
} from "./subGoalData";
import { registerSubscriberGoalPost } from "./subscriberGoalPostRegistry";
import { isSubscriberGoalPostRetired } from "../core/postRetirement";

export type LiveSubscriberGoalClassification =
  | "classic"
  | "tiny"
  | "cta"
  | "ambiguous";

export type LiveSubscriberGoalClassificationConfidence =
  | "explicit"
  | "migrated_consistent"
  | "ambiguous";

type LiveCandidatePost = Awaited<ReturnType<RedditClient["getPostById"]>> & {
  postData?: unknown;
  customPostData?: unknown;
  postHeight?: unknown;
};

export type LiveHighlightedSubscriberGoalCandidate = {
  postId: LinkId;
  post: LiveCandidatePost;
  createdAtMs?: number;
  classification: LiveSubscriberGoalClassification;
  classificationConfidence: LiveSubscriberGoalClassificationConfidence;
  discoveryOrder: number;
};

export async function findLiveHighlightedSubscriberGoalCandidates({
  reddit,
  redis,
  subreddit,
  nowMs,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  subreddit: Awaited<ReturnType<RedditClient["getCurrentSubreddit"]>>;
  nowMs: number;
}): Promise<LiveHighlightedSubscriberGoalCandidate[]> {
  const appUser = await reddit.getAppUser();
  if (!appUser?.username) {
    throw new Error(
      "Could not resolve app user while checking live Community Highlights.",
    );
  }

  const highlightedPosts = await subreddit.getHighlightedPosts();
  const candidates: LiveHighlightedSubscriberGoalCandidate[] = [];
  let discoveryOrder = 0;
  for (const highlighted of highlightedPosts) {
    if (!isLinkId(highlighted.postId)) continue;
    const post = (await reddit.getPostById(
      highlighted.postId,
    )) as LiveCandidatePost;
    if (
      (await isSubscriberGoalPostRetired(redis, highlighted.postId)) ||
      getTerminalRemovedByCategory(post) !== undefined ||
      post.authorName?.toLowerCase() !== appUser.username.toLowerCase() ||
      (post.subredditId !== subreddit.id &&
        post.subredditName?.toLowerCase() !== subreddit.name.toLowerCase())
    ) {
      continue;
    }

    const data = post.postData ?? post.customPostData;
    const inline =
      data && typeof data === "object"
        ? (data as { postKind?: unknown; postHeight?: unknown })
        : undefined;
    const [persistedKind, persistedGoal, persistedHeight] = await redis.hMGet(
      subscriberGoalsKey,
      [
        `${post.id}${postKindSuffix}`,
        `${post.id}${postGoalSuffix}`,
        `${post.id}${postHeightSuffix}`,
      ],
    );
    const inlineKind =
      typeof inline?.postKind === "string" ? inline.postKind : undefined;
    const inlineHeight = inline?.postHeight ?? post.postHeight;
    const explicitHeight =
      typeof inlineHeight === "string" ? inlineHeight : undefined;
    const recognizedInlineKind =
      inlineKind === subscriberGoalPostKind ||
      inlineKind === subscribeOnlyPostKind ||
      inlineKind === ctaOnlyPostKind;
    const hasCompatiblePersistedData =
      persistedKind === subscriberGoalPostKind ||
      persistedKind === subscribeOnlyPostKind ||
      persistedKind === ctaOnlyPostKind ||
      (Number.isFinite(Number(persistedGoal)) && Number(persistedGoal) > 0) ||
      persistedHeight === "tiny" ||
      persistedHeight === "cta";
    if (!recognizedInlineKind && !hasCompatiblePersistedData) continue;

    const kinds = new Set([inlineKind, persistedKind].filter(Boolean));
    const heights = new Set([explicitHeight, persistedHeight].filter(Boolean));
    const hasClassic =
      kinds.has(subscriberGoalPostKind) ||
      heights.has("regular") ||
      heights.has("short");
    const hasTiny = kinds.has(subscribeOnlyPostKind) || heights.has("tiny");
    const hasCta = kinds.has(ctaOnlyPostKind) || heights.has("cta");
    const conflicting =
      [hasClassic, hasTiny, hasCta].filter(Boolean).length > 1;
    const postKind = inlineKind ?? persistedKind;
    const postHeight = explicitHeight ?? persistedHeight;
    let classification: LiveSubscriberGoalClassification = "ambiguous";
    let classificationConfidence: LiveSubscriberGoalClassificationConfidence =
      "ambiguous";
    if (!conflicting) {
      if (
        postKind === subscriberGoalPostKind &&
        (postHeight === "regular" || postHeight === "short")
      ) {
        classification = "classic";
      } else if (postKind === subscribeOnlyPostKind && postHeight === "tiny") {
        classification = "tiny";
      } else if (postKind === ctaOnlyPostKind && postHeight === "cta") {
        classification = "cta";
      }
      if (classification !== "ambiguous") {
        classificationConfidence =
          inlineKind !== undefined && explicitHeight !== undefined
            ? "explicit"
            : "migrated_consistent";
      }
    } else {
      logDiagnostic("warn", "subscriber_goal_metadata_conflict_preserved", {
        workflow: "auto_create_next_goal",
        phase: "live_highlight_classification",
        postId: post.id,
        inlineKind: inlineKind ?? "none",
        persistedKind: persistedKind ?? "none",
        inlineHeight: explicitHeight ?? "none",
        persistedHeight: persistedHeight ?? "none",
      });
    }

    const createdAtMs = new Date(post.createdAt).getTime();
    await registerSubscriberGoalPost(
      redis,
      highlighted.postId,
      Number.isFinite(createdAtMs) ? createdAtMs : nowMs,
    );
    candidates.push({
      postId: highlighted.postId,
      post,
      ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
      classification,
      classificationConfidence,
      discoveryOrder: discoveryOrder++,
    });
  }
  return candidates;
}
