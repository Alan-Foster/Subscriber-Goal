type ExponentialBackoffPolicy = {
  baseMs: number;
  maxMs: number;
  jitterFraction?: number;
  maxAttempts?: number;
};

export type BackoffPolicy =
  ExponentialBackoffPolicy | { delaysMs: readonly number[] };

export function getJobRetry(
  policy: BackoffPolicy,
  failedAttempts: number,
  random = Math.random,
): { exhausted: true } | { exhausted: false; delayMs: number } {
  if ("delaysMs" in policy) {
    const delayMs = policy.delaysMs[failedAttempts - 1];
    return delayMs === undefined
      ? { exhausted: true }
      : { exhausted: false, delayMs };
  }
  if (
    policy.maxAttempts !== undefined &&
    failedAttempts >= policy.maxAttempts
  ) {
    return { exhausted: true };
  }
  return {
    exhausted: false,
    delayMs: getJobBackoffDelay(policy, failedAttempts, random),
  };
}

export function getJobBackoffDelay(
  policy: ExponentialBackoffPolicy,
  failedAttempts: number,
  random = Math.random,
): number {
  const delay = getExponentialJobBackoffCap(policy, failedAttempts);
  const jitter = policy.jitterFraction ?? 0;
  return Math.min(
    policy.maxMs,
    Math.floor(jitter ? delay * (1 + random() * jitter) : delay),
  );
}

export function getExponentialJobBackoffCap(
  { baseMs, maxMs }: ExponentialBackoffPolicy,
  failedAttempts: number,
): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, failedAttempts - 1));
}
