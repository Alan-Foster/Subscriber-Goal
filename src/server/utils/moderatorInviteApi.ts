import { ModerationDefinition, type Moderation } from "@devvit/protos";
import { getDevvitConfig } from "@devvit/shared-types/server/get-devvit-config.js";

export class ModeratorInviteRejectedError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join("\n") || "Reddit rejected the moderator invitation.");
    this.name = "ModeratorInviteRejectedError";
    this.errors = errors;
  }
}

/**
 * Devvit Web 0.15.1 does not expose moderator-invite acceptance on the public
 * Reddit client. Keep this unsupported API access narrow and lazy so tests and
 * unrelated server imports do not require an initialized Devvit runtime.
 */
export async function acceptModeratorInvite(
  subredditName: string,
): Promise<void> {
  const moderation = getDevvitConfig().use<Moderation>(ModerationDefinition);
  const response = await moderation.AcceptModeratorInvite({
    subreddit: subredditName,
  });
  const errors = response.json?.errors ?? [];
  if (errors.length > 0) throw new ModeratorInviteRejectedError(errors);
}
