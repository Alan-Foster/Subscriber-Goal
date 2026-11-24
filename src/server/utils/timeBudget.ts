export function deadlineFrom(nowMs: number, budgetMs: number): number {
  return nowMs + Math.max(0, budgetMs);
}

export function remainingMs(
  deadlineMs: number,
  reserveMs = 0,
  nowMs = Date.now(),
): number {
  return Math.max(0, deadlineMs - reserveMs - nowMs);
}
