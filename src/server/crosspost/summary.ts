export type CrosspostIngestionStatus = 'success' | 'partial' | 'failed';

export type CrosspostIngestionSummary = {
  status: CrosspostIngestionStatus;
  revisionsFetched: number;
  newPostsSeen: number;
  crosspostsCreated: number;
  crosspostsSkipped: number;
  crosspostsFailed: number;
  actionsMirrored: number;
  actionsFailed: number;
  crosspostsCreatedThisRun: number;
  crosspostsBlockedByRunCap: number;
  crosspostsBlockedByHourlyCap: number;
  crosspostPersistenceFailedAfterCreate: number;
  crosspostsSkippedBySourceCooldown: number;
  crosspostsSkippedByInFlight: number;
  crosspostsSkippedByExistingDetection: number;
  errorMessage?: string;
};

export function emptySummary(): CrosspostIngestionSummary {
  return {
    status: 'success',
    revisionsFetched: 0,
    newPostsSeen: 0,
    crosspostsCreated: 0,
    crosspostsSkipped: 0,
    crosspostsFailed: 0,
    actionsMirrored: 0,
    actionsFailed: 0,
    crosspostsCreatedThisRun: 0,
    crosspostsBlockedByRunCap: 0,
    crosspostsBlockedByHourlyCap: 0,
    crosspostPersistenceFailedAfterCreate: 0,
    crosspostsSkippedBySourceCooldown: 0,
    crosspostsSkippedByInFlight: 0,
    crosspostsSkippedByExistingDetection: 0,
  };
}

export const withErrorMessage = (
  errorMessage?: string
): { errorMessage?: string } => (errorMessage ? { errorMessage } : {});

export type CrosspostIngestionOptions = {
  sourcePostFreshnessWindowMs: number;
  revisionFreshnessWindowMs: number;
  maxCrosspostsPerRun: number;
  maxCrosspostsPerHour: number;
};
