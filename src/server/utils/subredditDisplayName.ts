import { translate } from "../../shared/i18n/catalog";

export function validateSubredditDisplayName(
  input: string | undefined,
  canonicalSubredditName: string,
  language?: unknown,
): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) {
    return translate(language, "moderator.validation.displayNameRequired");
  }

  if (trimmed.toLowerCase() !== canonicalSubredditName.toLowerCase()) {
    return translate(language, "moderator.validation.displayNameMismatch");
  }

  return undefined;
}
