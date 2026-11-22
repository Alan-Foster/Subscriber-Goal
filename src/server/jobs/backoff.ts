export type BackoffPolicy = {
  baseMs: number;
  maxMs: number;
  jitterFraction?: number;
  maxAttempts?: number;
};

export function getJobRetry(
  policy: BackoffPolicy,
  failedAttempts: number,
  random = Math.random,
): { exhausted: true } | { exhausted: false; delayMs: number } {
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
  policy: BackoffPolicy,
  failedAttempts: number,
  random = Math.random,
): number {
  const delay = Math.min(
    policy.maxMs,
    policy.baseMs * 2 ** Math.max(0, failedAttempts - 1),
  );
  const jitter = policy.jitterFraction ?? 0;
  return Math.min(
    policy.maxMs,
    Math.floor(jitter ? delay * (1 + random() * jitter) : delay),
  );
}
