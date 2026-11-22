import type { RedisClient } from "../types";
import { getJobBackoffDelay } from "../jobs/backoff";
import { createJobCodec, jobRecordFields, textField } from "../jobs/record";

export const appAccountHealthRetryStateKey =
  "app_account_health_v1_retry_state";
export const appAccountHealthMaxRetryAttempts = 3;
export const appAccountHealthBackoff = { baseMs: 60_000, maxMs: 60 * 60_000 };
const maxHealthBackoffAttempts = 7;

const retryCodec = createJobCodec({
  ...jobRecordFields,
  subredditName: textField,
  subredditId: textField,
  language: textField,
});

export type AppAccountHealthRetry = ReturnType<typeof retryCodec.parse>;

export async function readAppAccountHealthRetry(
  redis: RedisClient,
): Promise<AppAccountHealthRetry> {
  return retryCodec.parse(await redis.hGetAll(appAccountHealthRetryStateKey));
}

export async function scheduleAppAccountHealthRetry(
  redis: RedisClient,
  previousAttempts: number | undefined,
  nowMs: number,
  fields: Pick<
    AppAccountHealthRetry,
    "subredditName" | "subredditId" | "language" | "lastError"
  >,
): Promise<void> {
  // Exhaustion ends the short retry series. Periodic verification continues
  // at the one-hour ceiling in case a permission event never arrives.
  const attempts = Math.min(
    maxHealthBackoffAttempts,
    (previousAttempts ?? 0) + 1,
  );
  await redis.hSet(
    appAccountHealthRetryStateKey,
    retryCodec.serialize({
      ...fields,
      status:
        attempts < appAccountHealthMaxRetryAttempts ? "pending" : "exhausted",
      attempts,
      nextRunAt: nowMs + getJobBackoffDelay(appAccountHealthBackoff, attempts),
    }),
  );
}

export function isActiveHealthRetry(retry: AppAccountHealthRetry): boolean {
  return retry.status === "pending" || retry.status === "exhausted";
}

export function healthRetryDeadline(
  retry: AppAccountHealthRetry,
): number | undefined {
  return isActiveHealthRetry(retry) && retry.subredditName
    ? (retry.nextRunAt ?? undefined)
    : undefined;
}
