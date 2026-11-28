# S9 review: route-level catches and success reporting

Sweep #238 (section 9), sub-task "`src/server/routes/**`: route-level catches,
menu and form toasts that may report success on failure (9.08)". Reviewed on
the `claude/238-s9-markers` tip.

Method: every success toast in `src/server/routes/` was traced back to the
work it reports, checking whether any branch reaches it after a step failed
or was skipped. Every route-level `catch` was checked for a `logDiagnostic`
and a failure toast.

## Success toasts

| Route                                               | Toast                                                                                              | Verdict                                                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Create (`internalUi.createGoal.ts`, final response) | `create.success` / `create.degraded` / `create.crosspostFailed`, plus flair and crosspost warnings | OK: highlight issues, crosspost failure and omitted flair each change the message, and highlight failures notify moderators     |
| Create recovery (`respondToMissingFollowUpDraft`)   | `create.success` when recovery is `complete`                                                       | OK for success; **`R-S9-06`** (question): always labelled "goal"                                                                |
| Developer self-post                                 | `developer.success` after `submitPost` returns                                                     | OK: a throw gives `developer.failed` and logs                                                                                   |
| Delete (`finishGoalDeletion`)                       | `delete.success` / `cleanupDispatched` / `cleanupQueued`                                           | OK: uncertain deletion → `outcomeUncertain`; any cleanup failure or pending records → `cleanupPending`, logged                  |
| Erase another user's data                           | `data.eraseSuccess`                                                                                | **`R-S9-04`** (suspected, 7): the user-ID branch skips the username-based recent-subscriber cleanup                             |
| Erase another user's data, identity lookup failed   | `data.availableErased` with a warning                                                              | OK: the warning is shown and logged                                                                                             |
| Remove my own data                                  | `data.selfSuccess`                                                                                 | **`R-S9-05`** (suspected, 6): the username lookup failure is logged, but the cleanup step is skipped and success is still shown |

## Route-level catches

All route-level catches in `internalUi.createGoal.ts`, `internalUi.deleteGoal.ts`
and `internalUi.eraseData.ts` log a `logDiagnostic` with the error and return a
failure toast that includes an `operationId` where one exists.
`src/shared/diagnosticsAudit.test.ts` already enforces the logging half. Uncaught
errors fall through to `unhandledRequestErrorHandler`
(`src/server/utils/requestErrorBoundary.ts`), which logs and shows
`errors.request.actionFailed`.

## Not covered here

Public API routes (`src/server/routes/public/**`) report success through JSON,
not toasts. Their outcomes are assessed per path by the workflow issues
(#250, #247, #251), and their catches by the remaining S9 sub-tasks.
