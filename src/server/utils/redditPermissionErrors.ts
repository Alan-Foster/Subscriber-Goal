export function isPrivateSubredditAccessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /PERMISSION_DENIED|403\s+Forbidden:\s*private/i.test(message);
}
