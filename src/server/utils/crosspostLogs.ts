export type CrosspostLogLevel = 'info' | 'warn' | 'error';

export type CrosspostLogEvent =
  | 'crosspost_attempt_started'
  | 'crosspost_attempt_succeeded'
  | 'crosspost_attempt_failed'
  | 'crosspost_attempt_skipped'
  | 'crosspost_retry_started'
  | 'crosspost_retry_succeeded'
  | 'crosspost_retry_failed'
  | 'crosspost_retry_skipped'
  | 'crosspost_retry_degraded'
  | 'crosspost_persistence_failed_after_create'
  | 'crosspost_finalize_transaction_failed'
  | 'crosspost_reconciliation_started'
  | 'crosspost_reconciliation_succeeded'
  | 'crosspost_reconciliation_failed'
  | 'wiki_fetch_started'
  | 'wiki_fetch_succeeded'
  | 'wiki_fetch_failed';

export type CrosspostLogPayload = {
  event: CrosspostLogEvent;
  sourcePostId?: string;
  targetSubreddit?: string;
  crosspostId?: string;
  reason?: string;
  revisionId?: string;
  errorMessage?: string;
  page?: string;
  status?: 'success' | 'partial' | 'failed';
  revisionsFetched?: number;
  newPostsSeen?: number;
  crosspostsCreated?: number;
  crosspostsSkipped?: number;
  crosspostsFailed?: number;
  actionsMirrored?: number;
  actionsFailed?: number;
  durationMs?: number;
  consecutiveFailures?: number;
  currentInstallSubreddit?: string;
  authoritySubreddit?: string;
  ingestionAllowed?: boolean;
  freshnessWindowMs?: number;
  revisionFreshnessWindowMs?: number;
  crosspostsCreatedThisRun?: number;
  crosspostsBlockedByRunCap?: number;
  crosspostsBlockedByHourlyCap?: number;
  crosspostPersistenceFailedAfterCreate?: number;
  crosspostsSkippedBySourceCooldown?: number;
  crosspostsSkippedByInFlight?: number;
  crosspostsSkippedByExistingDetection?: number;
  reconciliationAttemptCount?: number;
  persistenceFailureReason?: string;
};

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logCrosspostEvent(
  payload: CrosspostLogPayload,
  level: CrosspostLogLevel = 'info'
): void {
  const compactPayload: Record<string, unknown> = {
    event: payload.event,
  };
  for (const [key, value] of Object.entries(payload)) {
    if (
      key === 'event' ||
      value === undefined ||
      (typeof value === 'number' && value === 0)
    ) {
      continue;
    }
    compactPayload[key] = value;
  }
  const logLine = JSON.stringify(compactPayload);

  try {
    if (level === 'error') {
      console.error(`[crosspost] ${logLine}`);
      return;
    }
    if (level === 'warn') {
      console.warn(`[crosspost] ${logLine}`);
      return;
    }
    console.info(`[crosspost] ${logLine}`);
  } catch {
    try {
      const fallbackLine = `[crosspost:fallback:${level}] ${logLine}\n`;
      if (level === 'error') {
        process.stderr.write(fallbackLine);
      } else {
        process.stdout.write(fallbackLine);
      }
    } catch {
      // swallow logger failures to avoid affecting ingestion control flow
    }
  }
}
