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
  | 'crosspost_persistence_partial'
  | 'crosspost_persistence_failed_after_create'
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
  crosspostPersistencePartial?: number;
  crosspostPersistenceFailedAfterCreate?: number;
  crosspostsSkippedBySourceCooldown?: number;
  crosspostsSkippedByInFlight?: number;
  crosspostsSkippedByExistingDetection?: number;
};

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logCrosspostEvent(
  payload: CrosspostLogPayload,
  level: CrosspostLogLevel = 'info'
): void {
  const logLine = JSON.stringify({
    event: payload.event,
    sourcePostId: payload.sourcePostId ?? null,
    targetSubreddit: payload.targetSubreddit ?? null,
    crosspostId: payload.crosspostId ?? null,
    reason: payload.reason ?? null,
    revisionId: payload.revisionId ?? null,
    errorMessage: payload.errorMessage ?? null,
    page: payload.page ?? null,
    status: payload.status ?? null,
    revisionsFetched: payload.revisionsFetched ?? null,
    newPostsSeen: payload.newPostsSeen ?? null,
    crosspostsCreated: payload.crosspostsCreated ?? null,
    crosspostsSkipped: payload.crosspostsSkipped ?? null,
    crosspostsFailed: payload.crosspostsFailed ?? null,
    actionsMirrored: payload.actionsMirrored ?? null,
    actionsFailed: payload.actionsFailed ?? null,
    durationMs: payload.durationMs ?? null,
    consecutiveFailures: payload.consecutiveFailures ?? null,
    currentInstallSubreddit: payload.currentInstallSubreddit ?? null,
    authoritySubreddit: payload.authoritySubreddit ?? null,
    ingestionAllowed: payload.ingestionAllowed ?? null,
    freshnessWindowMs: payload.freshnessWindowMs ?? null,
    revisionFreshnessWindowMs: payload.revisionFreshnessWindowMs ?? null,
    crosspostsCreatedThisRun: payload.crosspostsCreatedThisRun ?? null,
    crosspostsBlockedByRunCap: payload.crosspostsBlockedByRunCap ?? null,
    crosspostsBlockedByHourlyCap: payload.crosspostsBlockedByHourlyCap ?? null,
    crosspostPersistencePartial: payload.crosspostPersistencePartial ?? null,
    crosspostPersistenceFailedAfterCreate:
      payload.crosspostPersistenceFailedAfterCreate ?? null,
    crosspostsSkippedBySourceCooldown:
      payload.crosspostsSkippedBySourceCooldown ?? null,
    crosspostsSkippedByInFlight: payload.crosspostsSkippedByInFlight ?? null,
    crosspostsSkippedByExistingDetection:
      payload.crosspostsSkippedByExistingDetection ?? null,
  });

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
