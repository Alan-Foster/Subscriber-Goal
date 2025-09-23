/**
 * @file Some utility functions for working with the wikis.
 */

/**
 * Normalizes a wiki path by trimming whitespace, removing leading and trailing slashes, and converting to lowercase.
 * @param path - The wiki path to normalize.
 * @returns The normalized wiki path.
 */
export function normalizeWikiPath (path: string): string {
  // Remove leading and trailing slashes as well as whitespace and convert to lowercase
  path = path.trim().toLowerCase(); // Remove whitespace and convert to lowercase
  path = path.replace(/\/{2,}/g, '/'); // Remove multiple consecutive slashes

  // Remove leading and trailing slashes
  if (path.startsWith('/')) {
    path = path.substring(1);
  }
  if (path.endsWith('/')) {
    path = path.substring(0, path.length - 1);
  }

  // Remove leading "wiki/" if it exists
  if (path.startsWith('wiki/')) {
    // We're also removing multiple leading "wiki/" strings, we really don't want to allow top level pages to start with "wiki/" either.
    // A top level wiki page named "wiki" would be indistinguishable from the root of the wiki in an unprocessed user-entered path.
    path = path.replace(/^(wiki\/){1,}/, '');
  }

  if (path === '') {
    throw new Error('Wiki path should not be empty after normalization.');
  }
  return `/${path}`; // Ensure it starts with a single leading slash
}

/**
 * Normalizes a wiki path and ensures it uses the correct format to specify the revision ID.
 * @param path - The wiki path to normalize.
 * @param revisionId - The revision ID to append to the path.
 * @returns The normalized wiki path with the revision ID.
 */
export function normalizeWikiPathWithRevision (path: string, revisionId: string): string {
  const normalizedPath = normalizeWikiPath(path);
  return `${normalizedPath}?v=${revisionId}&raw_json=1&`;
}

/**
 * Reddit's wiki revision reasons must be printable ASCII and no more than 256 bytes in length, this function checks that.
 * It is basically an implementation of the VPrintable function from the legacy Reddit codebase: https://github.com/reddit-archive/reddit/blob/753b17407e9a9dca09558526805922de24133d53/r2/r2/lib/validator/validator.py#L579-L600.
 * @param text - The text to validate as a revision reason.
 * @returns Whether the given text is a valid revision reason.
 */
export function isValidRevisionReason (text: string): boolean {
  // Reddit enforces a maximum length of 256 characters for revision reasons.
  if (new TextEncoder().encode(text).length > 256) {
    return false;
  }

  return [...text].every(ch => ch >= ' ' && ch <= '~');
}
