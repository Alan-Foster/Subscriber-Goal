import { reddit, redis } from "@devvit/web/server";
import { type ServerAppSettings } from "../settings";
import {
  crosspostWikiPages,
  isProcessedRevision,
  parseNewPostDispatchReason,
  parsePostActionDispatchReason,
} from "../data/crosspostData";
import { safeGetWikiPageRevisions } from "../utils/redditUtils";
import { isLinkId, type LinkId } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";
import {
  shouldLogUnexpectedRevision,
  isTerminalRevisionMarked,
} from "./bookkeeping";
import { withErrorMessage } from "./summary";

export type NewPostEvent = {
  postId: LinkId;
  revisionId: string;
  goal: number;
  revisionDateMs?: number;
};

export type PostActionEvent = {
  postId: LinkId;
  revisionId: string;
  action: "remove" | "approve" | "delete";
};

export async function getNewPosts(appSettings: ServerAppSettings): Promise<{
  events: NewPostEvent[];
  revisionsFetched: number;
  ok: boolean;
  errorMessage?: string;
}> {
  const result = await safeGetWikiPageRevisions(
    reddit,
    appSettings.promoSubreddit,
    crosspostWikiPages.newPost,
  );
  if (!result.ok) {
    return {
      events: [],
      revisionsFetched: 0,
      ok: false,
      ...withErrorMessage(result.errorMessage),
    };
  }

  const newPosts: Set<NewPostEvent> = new Set();
  for (const revision of result.revisions) {
    if (
      (await isProcessedRevision(redis, revision.id)) ||
      (await isTerminalRevisionMarked(redis, revision.id))
    ) {
      continue;
    }

    const parsedReason = parseNewPostDispatchReason(revision.reason);
    if (!parsedReason) {
      if (
        await shouldLogUnexpectedRevision(
          redis,
          revision.id,
          "unexpected_new_post_reason",
        )
      ) {
        logDiagnostic("warn", "crosspost_revision_skipped", {
          workflow: "crosspost",
          phase: "unexpected_new_post_reason",
          recordId: revision.id,
        });
      }
      continue;
    }
    const { postId, goal } = parsedReason;
    if (!postId || Number.isNaN(goal) || !isLinkId(postId)) {
      if (
        await shouldLogUnexpectedRevision(
          redis,
          revision.id,
          "invalid_new_post_payload",
        )
      ) {
        logDiagnostic("warn", "crosspost_revision_skipped", {
          workflow: "crosspost",
          phase: "invalid_new_post_payload",
          recordId: revision.id,
        });
      }
      continue;
    }

    const event: NewPostEvent = {
      postId,
      revisionId: revision.id,
      goal,
      ...(typeof revision.dateMs === "number"
        ? { revisionDateMs: revision.dateMs }
        : {}),
    };
    newPosts.add(event);
  }

  return {
    events: Array.from(newPosts),
    revisionsFetched: result.revisions.length,
    ok: true,
  };
}

export async function getNewPostActions(
  appSettings: ServerAppSettings,
  actionType: "remove" | "approve" | "delete",
): Promise<{
  events: PostActionEvent[];
  revisionsFetched: number;
  ok: boolean;
  errorMessage?: string;
}> {
  const result = await safeGetWikiPageRevisions(
    reddit,
    appSettings.promoSubreddit,
    crosspostWikiPages.action[actionType],
  );
  if (!result.ok) {
    return {
      events: [],
      revisionsFetched: 0,
      ok: false,
      ...withErrorMessage(result.errorMessage),
    };
  }

  const newPosts: Set<PostActionEvent> = new Set();
  for (const revision of result.revisions) {
    if (await isProcessedRevision(redis, revision.id)) {
      continue;
    }

    const parsedReason = parsePostActionDispatchReason(
      revision.reason,
      actionType,
    );
    if (!parsedReason) {
      if (
        await shouldLogUnexpectedRevision(
          redis,
          revision.id,
          `unexpected_action_reason_${actionType}`,
        )
      ) {
        logDiagnostic("warn", "crosspost_revision_skipped", {
          workflow: "crosspost",
          phase: "unexpected_action_reason",
          category: actionType,
          recordId: revision.id,
        });
      }
      continue;
    }
    const { postId } = parsedReason;
    if (!postId || !isLinkId(postId)) {
      if (
        await shouldLogUnexpectedRevision(
          redis,
          revision.id,
          `invalid_action_post_id_${actionType}`,
        )
      ) {
        logDiagnostic("warn", "crosspost_revision_skipped", {
          workflow: "crosspost",
          phase: "invalid_action_post_id",
          category: actionType,
          recordId: revision.id,
        });
      }
      continue;
    }

    newPosts.add({
      postId,
      revisionId: revision.id,
      action: actionType,
    });
  }

  return {
    events: Array.from(newPosts),
    revisionsFetched: result.revisions.length,
    ok: true,
  };
}
