import { describe, expect, it } from "vitest";
import {
  backgroundLockTtlMs,
  boundedLockTtlMs,
  devvitWebMaximumRequestMs,
  LockTtlOutOfBoundsError,
  maximumLockTtlMs,
  perPostLockTtlMs,
  userFacingLockTtlMs,
} from "./lockTtl";

describe("boundedLockTtlMs", () => {
  it.each([30_001, 45_000, 60_000, 90_000])("accepts %i ms", (ttlMs) => {
    expect(boundedLockTtlMs("test_lock", ttlMs)).toBe(ttlMs);
  });

  it.each([0, 30_000, 90_001, 15 * 60 * 1000, Number.NaN, Infinity])(
    "rejects %s ms",
    (ttlMs) => {
      expect(() => boundedLockTtlMs("test_lock", ttlMs)).toThrow(
        LockTtlOutOfBoundsError,
      );
    },
  );

  it("names the lock in the error", () => {
    expect(() => boundedLockTtlMs("test_lock", 30_000)).toThrow(/test_lock/);
  });

  it("keeps every tier above the request limit and within the cap", () => {
    expect(devvitWebMaximumRequestMs).toBe(30_000);
    expect(maximumLockTtlMs).toBe(90_000);
    for (const ttlMs of [
      perPostLockTtlMs,
      userFacingLockTtlMs,
      backgroundLockTtlMs,
    ]) {
      expect(ttlMs).toBeGreaterThan(devvitWebMaximumRequestMs);
      expect(ttlMs).toBeLessThanOrEqual(maximumLockTtlMs);
    }
  });
});
