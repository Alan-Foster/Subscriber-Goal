import { context, reddit } from "@devvit/web/server";
import {
  defaultSubGoalLanguage,
  resolveSubGoalLanguage,
  type SubGoalLanguage,
} from "../../shared/subGoalPostI18n";
import { translate } from "../../shared/i18n/catalog";
import { logDiagnostic } from "../../shared/diagnostics";
import {
  getCurrentActorAuthority,
  type ActorAuthorityRequirement,
} from "../utils/actorAuthorization";

export async function resolveCurrentSubredditLanguage(): Promise<SubGoalLanguage> {
  try {
    return resolveSubGoalLanguage(
      (await reddit.getCurrentSubreddit()).language,
    );
  } catch {
    // diagnostic-allow-silent: the default language is safe when subreddit metadata is unavailable.
    return defaultSubGoalLanguage;
  }
}

export async function requireCurrentActorAuthority({
  requirement,
  language,
}: {
  requirement: ActorAuthorityRequirement;
  language: unknown;
}): Promise<
  | {
      authorized: true;
      userId: string;
      subreddit: Awaited<ReturnType<typeof reddit.getCurrentSubreddit>>;
    }
  | { authorized: false; message: string }
> {
  const userId = context.userId;
  if (!userId) {
    return {
      authorized: false,
      message: translate(language, "moderator.authorization.loginRequired"),
    };
  }
  let subreddit: Awaited<ReturnType<typeof reddit.getCurrentSubreddit>>;
  try {
    subreddit = await reddit.getCurrentSubreddit();
    const authority = await getCurrentActorAuthority({
      reddit,
      actorUserId: userId,
      subredditName: subreddit.name,
      requirement,
    });
    if (authority.status === "authorized") {
      return { authorized: true, userId, subreddit };
    }
    return {
      authorized: false,
      message: translate(
        language,
        authority.status === "denied"
          ? requirement === "manage-posts"
            ? "moderator.authorization.managePostsRequired"
            : "moderator.authorization.moderatorRequired"
          : "moderator.authorization.retry",
      ),
    };
  } catch (error) {
    logDiagnostic(
      "warn",
      "actor_authority_context_failed",
      { workflow: "actor_authorization", phase: "trusted_context" },
      error,
    );
    return {
      authorized: false,
      message: translate(language, "moderator.authorization.retry"),
    };
  }
}
