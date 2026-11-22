export function getRetryWaitMs(
  baseMs: number,
  jitterRatio: number,
  remainingMs: number,
  random = Math.random,
): number {
  if (baseMs <= 0 || jitterRatio <= 0) return Math.min(baseMs, remainingMs);
  const factor = 1 + (random() * 2 - 1) * jitterRatio;
  return Math.min(Math.max(0, Math.round(baseMs * factor)), remainingMs);
}
