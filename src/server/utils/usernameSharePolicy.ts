export function resolveShareUsername(
  requestedShareUsername: boolean,
  isNsfw: boolean
): boolean {
  if (isNsfw) {
    return false;
  }

  return requestedShareUsername;
}
