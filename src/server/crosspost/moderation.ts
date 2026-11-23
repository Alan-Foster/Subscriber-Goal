import { reddit, redis } from "@devvit/web/server";
import { type ServerAppSettings } from "../settings";
import {
  getCorrespondingPost,
  removeCorrespondingPost,
  storeProcessedRevision,
  storeCrosspostDeletionMarker,
} from "../data/crosspostData";
import { logCrosspostEvent } from "../utils/crosspostLogs";
import { isLinkId, type LinkId } from "../types";
import { type CrosspostIngestionSummary } from "./summary";
import { type PostActionEvent } from "./wikiRevisions";

const isPermanentMirrorError = (errorMessage: string): boolean =>
  /only allowed inside (the )?current subreddit/i.test(errorMessage);

export async function mirrorPostAction(
  appSettings: ServerAppSettings,
  summary: CrosspostIngestionSummary,
  nowMs: number,
  postAction: PostActionEvent,
): Promise<void> {
  let terminal = false;
  let mirrored = false;
  try {
    if (postAction.action === "delete") {
      await storeCrosspostDeletionMarker(
        redis,
        postAction.postId,
        postAction.revisionId,
        nowMs,
      );
      await storeProcessedRevision(
        redis,
        postAction.revisionId,
        postAction.postId,
      );
      summary.crosspostsSkipped += 1;
      logCrosspostEvent({
        event: "crosspost_attempt_started",
        sourcePostId: postAction.postId,
        targetSubreddit: appSettings.promoSubreddit,
        reason: "action_delete_cleanup_queued",
        revisionId: postAction.revisionId,
      });
      return;
    }
    const crosspostId = await getCorrespondingPost(redis, postAction.postId);
    if (!crosspostId) {
      summary.crosspostsSkipped += 1;
      logCrosspostEvent({
        event: "crosspost_attempt_skipped",
        sourcePostId: postAction.postId,
        targetSubreddit: appSettings.promoSubreddit,
        reason: `action_${postAction.action}_missing_mapping`,
        revisionId: postAction.revisionId,
      });
      console.info(
        `[crosspost] no mapping found for action; marking processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId}`,
      );
      terminal = true;
      await storeProcessedRevision(
        redis,
        postAction.revisionId,
        postAction.postId,
      );
      return;
    }

    if (!isLinkId(crosspostId)) {
      summary.crosspostsSkipped += 1;
      logCrosspostEvent(
        {
          event: "crosspost_attempt_skipped",
          sourcePostId: postAction.postId,
          targetSubreddit: appSettings.promoSubreddit,
          crosspostId,
          reason: `action_${postAction.action}_invalid_target`,
          revisionId: postAction.revisionId,
        },
        "warn",
      );
      await removeCorrespondingPost(redis, postAction.postId);
      terminal = true;
    } else {
      const crosspost = await getCrosspostOrSkip(
        appSettings,
        summary,
        postAction,
        crosspostId,
      );
      if (!crosspost) {
        terminal = true;
      } else {
        if (postAction.action === "remove") await crosspost.remove(false);
        else await crosspost.approve();
        mirrored = true;
      }
    }
    if (mirrored) {
      terminal = true;
      summary.actionsMirrored += 1;
      logCrosspostEvent({
        event: "crosspost_attempt_succeeded",
        sourcePostId: postAction.postId,
        targetSubreddit: appSettings.promoSubreddit,
        crosspostId,
        reason: `action_${postAction.action}_mirrored`,
        revisionId: postAction.revisionId,
      });
      console.info(
        `[crosspost] mirrored action and marked processed: revisionId=${postAction.revisionId} action=${postAction.action} sourcePostId=${postAction.postId} crosspostId=${crosspostId}`,
      );
    }
  } catch (e) {
    const errorText = e instanceof Error ? e.message : String(e);
    const missingCrosspost =
      /not[\s-]?found|does not exist|deleted|no longer exists/i.test(errorText);
    const permanentMirrorFailure = isPermanentMirrorError(errorText);
    if (missingCrosspost || permanentMirrorFailure) {
      terminal = true;
      summary.crosspostsSkipped += 1;
      logCrosspostEvent(
        {
          event: "crosspost_attempt_skipped",
          sourcePostId: postAction.postId,
          targetSubreddit: appSettings.promoSubreddit,
          reason: missingCrosspost
            ? `action_${postAction.action}_target_missing`
            : `action_${postAction.action}_terminal_context_error`,
          revisionId: postAction.revisionId,
          errorMessage: errorText,
        },
        "warn",
      );
      if (missingCrosspost) {
        await removeCorrespondingPost(redis, postAction.postId);
      }
    } else {
      summary.actionsFailed += 1;
      logCrosspostEvent(
        {
          event: "crosspost_attempt_failed",
          sourcePostId: postAction.postId,
          targetSubreddit: appSettings.promoSubreddit,
          reason: `action_${postAction.action}_mirror_failed`,
          revisionId: postAction.revisionId,
          errorMessage: errorText,
        },
        "error",
      );
    }
  }

  if (terminal) {
    await storeProcessedRevision(
      redis,
      postAction.revisionId,
      postAction.postId,
    );
  }
}
async function getCrosspostOrSkip(
  appSettings: ServerAppSettings,
  summary: CrosspostIngestionSummary,
  postAction: PostActionEvent,
  resolvedCrosspostId: LinkId,
) {
  const expectedSubreddit = appSettings.promoSubreddit.toLowerCase();
  const crosspost = await reddit.getPostById(resolvedCrosspostId);
  if (!crosspost) {
    summary.crosspostsSkipped += 1;
    logCrosspostEvent(
      {
        event: "crosspost_attempt_skipped",
        sourcePostId: postAction.postId,
        targetSubreddit: appSettings.promoSubreddit,
        crosspostId: resolvedCrosspostId,
        reason: `action_${postAction.action}_target_missing`,
        revisionId: postAction.revisionId,
      },
      "warn",
    );
    await removeCorrespondingPost(redis, postAction.postId);
    return null;
  }

  if (crosspost.subredditName.toLowerCase() !== expectedSubreddit) {
    summary.crosspostsSkipped += 1;
    logCrosspostEvent(
      {
        event: "crosspost_attempt_skipped",
        sourcePostId: postAction.postId,
        targetSubreddit: appSettings.promoSubreddit,
        crosspostId: resolvedCrosspostId,
        reason: `action_${postAction.action}_wrong_subreddit`,
        revisionId: postAction.revisionId,
      },
      "warn",
    );
    await removeCorrespondingPost(redis, postAction.postId);
    return null;
  }

  return crosspost;
}
