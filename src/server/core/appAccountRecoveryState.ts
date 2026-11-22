import type { RedisClient } from "../types";

export const appAccountRecoveryStateKey = "app_account_recovery_v1_state";

export type RecoveryStatus =
  | "pending"
  | "processing"
  | "healthy"
  | "missing"
  | "insufficient_permissions"
  | "acceptance_failed"
  | "verification_failed"
  | "exhausted";

export function toRecoveryResultStatus(
  value: string | undefined,
): RecoveryStatus {
  const statuses = new Set<RecoveryStatus>([
    "pending",
    "processing",
    "healthy",
    "missing",
    "insufficient_permissions",
    "acceptance_failed",
    "verification_failed",
    "exhausted",
  ]);
  return statuses.has(value as RecoveryStatus)
    ? (value as RecoveryStatus)
    : "pending";
}

export function isTerminalRecoveryStatus(status: string | undefined): boolean {
  return [
    "missing",
    "insufficient_permissions",
    "acceptance_failed",
    "verification_failed",
    "exhausted",
  ].includes(status ?? "");
}

/** Update only the incident and verification generation that was inspected. */
export async function updateRecoveryState(
  redis: RedisClient,
  expected: Record<string, string>,
  fields: Record<string, string>,
): Promise<boolean> {
  const tx = await redis.watch(appAccountRecoveryStateKey);
  let inMulti = false;
  try {
    const current = await redis.hGetAll(appAccountRecoveryStateKey);
    if (
      ["incidentToken", "status", "verificationToken"].some(
        (key) => current[key] !== expected[key],
      )
    ) {
      await tx.unwatch();
      return false;
    }
    await tx.multi();
    inMulti = true;
    await tx.hSet(appAccountRecoveryStateKey, fields);
    return (await tx.exec()).length > 0;
  } catch (error) {
    if (inMulti) await tx.discard();
    else await tx.unwatch();
    throw error;
  }
}
