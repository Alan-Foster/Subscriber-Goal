# S9 review: crosspost and utils

Sweep #238 (section 9), sub-tasks "`src/server/crosspost/**`" and
"`src/server/utils/**`, including `requestErrorBoundary.ts` and
`runtimeValidation.ts`".

## Crosspost (`src/server/crosspost/`)

16 catches across `dispatch.ts`, `ingestion.ts`, `moderation.ts` and
`pending.ts`. Every one logs, through `logDiagnostic` or `logCrosspostEvent`,
and per-run summaries (`crosspost_retry_succeeded`, "scheduler ingestion
summary") report counts. `bookkeeping.ts`, `mappingCleanup.ts` and
`summary.ts` have no catches; their errors propagate to logged callers.

The problem is classification, not logging: **`R-S9-11`**. Three sites
decide "target missing / permanent" by matching
`/not[\s-]?found|does not exist|deleted|no longer exists/i` against any error
text. This is the opposite of the core classifier, which is too narrow
(`R-W6-01`).

## Utils (`src/server/utils/`)

| File                               | Catches | Verdict                                                                                                    |
| ---------------------------------- | ------: | ---------------------------------------------------------------------------------------------------------- |
| `communityHighlights.ts`           |       8 | OK: every write, rollback, cleanup and verification failure is logged and returned as a typed issue        |
| `requestErrorBoundary.ts`          |       1 | OK: logs, then a localized error with `operationId` (language lookup failure logged too)                   |
| `runtimeValidation.ts`             |       1 | OK: the marker reason holds (logged below without contents)                                                |
| `redisOwnedLock.ts`                |       3 | OK: logged or rethrown; TTL as cleanup fallback                                                            |
| `highlightFailureNotifications.ts` |       2 | OK                                                                                                         |
| `actorAuthorization.ts`            |       1 | OK                                                                                                         |
| `subredditBlacklist.ts`            |       2 | OK                                                                                                         |
| `redditUtils.ts`                   |       1 | OK: `wiki_fetch_failed` logged with duration                                                               |
| `crosspostLogs.ts`                 |       2 | OK: the logger's own fallback transport                                                                    |
| `redditPermissionErrors.ts`        |       0 | Text-matching classifier (`PERMISSION_DENIED`, `403 Forbidden: private`); add to the error-shape inventory |
| `emergencyGoalRecovery.ts`         |       0 | **`R-S9-12`**: the fallback is logged but never saved, so it repeats every minute                          |
