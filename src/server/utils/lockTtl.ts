/**
 * Expiry rules for Redis locks.
 *
 * Every lock in the app is acquired and released inside one request or job
 * run, and Devvit stops each run after 30 seconds:
 * https://developers.reddit.com/docs/guides/faq#limits-and-policies
 *
 * A lock's expiry only matters when its release fails or its run is killed.
 * It must outlast the longest possible holder, so it stays above the request
 * limit. Beyond that, a longer expiry only lengthens the outage after a failed
 * release, so it is capped at 90 seconds.
 *
 * Deduplication markers (keys that record that something already happened)
 * are not locks and do not use these values.
 */

/** Devvit Web requests and scheduled runs stop after 30 seconds. */
export const devvitWebMaximumRequestMs = 30 * 1000;

/** Longest allowed lock expiry: three request limits. */
export const maximumLockTtlMs = 90 * 1000;

/** Locks that moderators or viewers wait on: clear quickly after a failure. */
export const userFacingLockTtlMs = 60 * 1000;

/** Background locks that only stop a job from running twice. */
export const backgroundLockTtlMs = maximumLockTtlMs;

/** Short per-post locks: the smallest expiry with margin over a request. */
export const perPostLockTtlMs = 45 * 1000;

export class LockTtlOutOfBoundsError extends Error {
  constructor(name: string, ttlMs: number) {
    super(
      `Lock expiry for ${name} must be over ${devvitWebMaximumRequestMs} ms and at most ${maximumLockTtlMs} ms (got ${ttlMs} ms).`,
    );
    this.name = "LockTtlOutOfBoundsError";
  }
}

/**
 * Returns `ttlMs` after checking it fits the lock expiry rules. Call it where
 * a lock expiry constant is declared, so a bad value fails at startup.
 */
export function boundedLockTtlMs(name: string, ttlMs: number): number {
  if (
    !Number.isFinite(ttlMs) ||
    ttlMs <= devvitWebMaximumRequestMs ||
    ttlMs > maximumLockTtlMs
  ) {
    throw new LockTtlOutOfBoundsError(name, ttlMs);
  }
  return ttlMs;
}
