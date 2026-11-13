import type { RedditClient } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";

export type ActorAuthorityRequirement = "moderator" | "manage-posts";

export type ActorAuthorityResult =
  | { status: "authorized"; username: string; permissions: string[] }
  | { status: "denied" }
  | { status: "inconclusive" };

const normalize = (value: string): string => value.trim().toLowerCase();
const moderatorPermissions = new Set([
  "all",
  "wiki",
  "posts",
  "access",
  "mail",
  "config",
  "flair",
  "chat_operator",
  "chat_config",
  "channels",
  "community_chat",
]);

/**
 * Resolves fresh moderator evidence for the authenticated actor.  The
 * username-filtered SDK lookup is not trusted unless the returned account id
 * and username both match the current authenticated user.
 */
export async function getCurrentActorAuthority({
  reddit,
  actorUserId,
  subredditName,
  requirement,
}: {
  reddit: RedditClient;
  actorUserId: string;
  subredditName: string;
  requirement: ActorAuthorityRequirement;
}): Promise<ActorAuthorityResult> {
  try {
    const actor = await reddit.getCurrentUser();
    const username = actor?.username?.trim();
    if (
      !actor ||
      actor.id !== actorUserId ||
      !username ||
      !subredditName.trim()
    ) {
      return { status: "inconclusive" };
    }

    const moderators = await reddit
      .getModerators({
        subredditName,
        username,
        limit: 2,
        pageSize: 2,
      })
      .all();
    if (moderators.length === 0) return { status: "denied" };
    if (moderators.length !== 1) return { status: "inconclusive" };

    const moderator = moderators[0];
    if (
      !moderator ||
      moderator.id !== actorUserId ||
      normalize(moderator.username ?? "") !== normalize(username) ||
      !Array.isArray(moderator.moderatorInfo?.modPermissions)
    ) {
      return { status: "inconclusive" };
    }
    const permissions = moderator.moderatorInfo.modPermissions;
    if (
      !permissions.every(
        (permission) =>
          typeof permission === "string" &&
          moderatorPermissions.has(permission),
      )
    ) {
      return { status: "inconclusive" };
    }
    if (requirement === "moderator") {
      return { status: "authorized", username, permissions };
    }
    return permissions.includes("all") || permissions.includes("posts")
      ? { status: "authorized", username, permissions }
      : { status: "denied" };
  } catch (error) {
    logDiagnostic(
      "warn",
      "actor_authority_lookup_failed",
      {
        workflow: "actor_authorization",
        phase: "moderator_lookup",
        subredditName,
        actorUserId,
        requirement,
      },
      error,
    );
    return { status: "inconclusive" };
  }
}
