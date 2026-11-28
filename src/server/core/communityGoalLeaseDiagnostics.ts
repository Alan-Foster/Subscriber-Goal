import { logDiagnostic } from "../../shared/diagnostics";
import type { RedisClient } from "../types";

// Timing and contention evidence for the community-wide mutation lease
// (silent-error audit #237, record R-S7-01). Diagnostics never change lease
// behavior: every Redis call here is best-effort and logged on failure.

/** Who last took the lease, for "lock busy" logs. Expires with the lease. */
export const communityGoalMutationHolderKey =
  "subscriber_goal_community_mutation_v1_holder";
/** Waits at or above this are logged even when the lease was acquired. */
export const leaseWaitLogThresholdMs = 1_000;
/** Holds at or above this are logged at release. */
export const leaseHoldLogThresholdMs = 5_000;

type Holder = { label: string; since: number };

function parseHolder(raw: string | undefined | null): Holder | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<Holder>;
    if (typeof value.label === "string" && typeof value.since === "number") {
      return { label: value.label, since: value.since };
    }
  } catch {
    // diagnostic-allow-silent: an unreadable holder record only removes context from a contention log.
  }
  return undefined;
}

export async function recordLeaseHolder(
  redis: RedisClient,
  label: string,
  nowMs: number,
  ttlMs: number,
): Promise<void> {
  try {
    await redis.set(
      communityGoalMutationHolderKey,
      JSON.stringify({ label, since: nowMs } satisfies Holder),
      { expiration: new Date(nowMs + ttlMs) },
    );
  } catch (error) {
    logDiagnostic(
      "warn",
      "community_lease_holder_unrecorded",
      { workflow: "community_goal_mutation", phase: "record_holder", label },
      error,
    );
  }
}

export async function logLeaseBusy(
  redis: RedisClient,
  label: string,
  waitedMs: number,
  nowMs: number,
): Promise<void> {
  let holder: Holder | undefined;
  try {
    holder = parseHolder(await redis.get(communityGoalMutationHolderKey));
  } catch (error) {
    logDiagnostic(
      "warn",
      "community_lease_holder_unreadable",
      { workflow: "community_goal_mutation", phase: "read_holder", label },
      error,
    );
  }
  logDiagnostic("info", "community_lease_busy", {
    workflow: "community_goal_mutation",
    phase: "acquire",
    reason: "lock_busy",
    label,
    waitedMs,
    holder: holder?.label ?? "unknown",
    holderHeldMs: holder ? nowMs - holder.since : undefined,
  });
}

export function logLeaseTiming(
  label: string,
  waitedMs: number,
  heldMs: number,
): void {
  if (waitedMs < leaseWaitLogThresholdMs && heldMs < leaseHoldLogThresholdMs)
    return;
  logDiagnostic("info", "community_lease_timing", {
    workflow: "community_goal_mutation",
    phase: "release",
    label,
    waitedMs,
    heldMs,
  });
}
