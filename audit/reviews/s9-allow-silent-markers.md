# S9 review: `diagnostic-allow-silent` markers

Sweep #238 (section 9, Error Handling and Recovery), sub-task "Review each
`diagnostic-allow-silent` marker and confirm its reason". Reviewed at the
`claude/236-path-inventory` tip, which includes `main` at `10ad373`.

There are **28** markers in production code (the earlier count of 24 missed
multi-marker files). Verdicts:

- **OK**: the reason holds; the failure is reported elsewhere, or silence is
  genuinely the right behavior.
- **Record**: the reason is too broad, or the silence hides a real failure. A
  record was written.

|   # | Location                                                         | Reason given                                                                      | Verdict                                                                       |
| --: | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
|   1 | `src/client/analytics/statisticsAnalytics.ts:33`                 | Storage unavailable in privacy modes; in-memory ID is safe                        | OK                                                                            |
|   2 | `src/client/app/components/afterSubscribeTargetValidation.ts:39` | Malformed navigation targets are validation input                                 | OK                                                                            |
|   3 | `src/client/hooks/subGoal/stateValidation.ts:32`                 | URL parsing is a validation probe                                                 | OK                                                                            |
|   4 | `src/client/utils/fetchWithRetry.ts:182`                         | Abort during retry sleep is expected cancellation                                 | OK                                                                            |
|   5 | `src/client/utils/startupPerformance.ts:21`                      | Optional timing instrumentation                                                   | OK                                                                            |
|   6 | `src/client/utils/startupPerformance.ts:38`                      | Optional timing instrumentation                                                   | OK                                                                            |
|   7 | `src/server/core/goalHealth.ts:183`                              | Outer handler logs the original error                                             | OK (cleanup inside a catch that rethrows)                                     |
|   8 | `src/server/core/onboardingSubscriberGoal.ts:736`                | Failure handler logs the replay or retry outcome                                  | OK (`handleOnboardingCreationFailure` logs)                                   |
|   9 | `src/server/core/onboardingWarning.ts:569`                       | Failure handler logs the dispatch or retry outcome                                | OK                                                                            |
|  10 | `src/server/core/sourcePostDeletion.ts:241`                      | Lookup failures classified into missing evidence or retry state                   | **Record `R-S9-01`**: the retry state is saved silently; only exhaustion logs |
|  11 | `src/server/data/postKindMigration.ts:189`                       | Preserve the original transaction error                                           | OK                                                                            |
|  12 | `src/server/data/recentSubscriberErasure.ts:186`                 | Preserve the original erasure or retirement error                                 | OK                                                                            |
|  13 | `src/server/data/recentSubscriberOrder.ts:37`                    | Legacy posts have no ordering record                                              | **Record `R-S9-02`**: also hides a corrupt record                             |
|  14 | `src/server/data/scheduledPostDisplacementQueue.ts:35`           | Retain the original transaction error                                             | OK                                                                            |
|  15 | `src/server/data/statisticsAnalytics.ts:131`                     | Preserve the original claim error                                                 | OK                                                                            |
|  16 | `src/server/jobs/queue.ts:55`                                    | Rethrow the original transaction failure                                          | OK                                                                            |
|  17 | `src/server/routes/internalUi.common.ts:20`                      | Default language is safe when metadata is unavailable                             | **Record `R-S9-03`**: safe fallback, but hides Reddit failures                |
|  18 | `src/server/routes/public/afterSubscribeTarget.ts:134`           | URL parsing is a validation probe                                                 | OK                                                                            |
|  19 | `src/server/routes/public/afterSubscribeTarget.ts:286`           | Malformed candidate URLs fall back to `post.url`                                  | OK                                                                            |
|  20 | `src/server/routes/public/refresh.ts:136`                        | Keep the API response; log the original permission error if rate limiting is down | OK (returns `true`, so the original error is still logged)                    |
|  21 | `src/server/utils/crosspostLogs.ts:92`                           | Compatibility logger attempting its fallback transport                            | OK                                                                            |
|  22 | `src/server/utils/crosspostLogs.ts:101`                          | No logging transport remains                                                      | OK                                                                            |
|  23 | `src/server/utils/redisOwnedLock.ts:110`                         | Preserve the primary transaction failure; the lease TTL is the cleanup fallback   | OK                                                                            |
|  24 | `src/server/utils/runtimeValidation.ts:30`                       | Logs invalid data below without its contents                                      | OK                                                                            |
|  25 | `src/shared/afterSubscribeAction.ts:280`                         | Malformed legacy URLs use fallback behavior                                       | OK                                                                            |
|  26 | `src/shared/afterSubscribeAction.ts:298`                         | URL parsing is a validation probe                                                 | OK                                                                            |
|  27 | `src/shared/diagnostics.ts:98`                                   | Logging must never break control flow                                             | OK                                                                            |
|  28 | `src/shared/i18n/errors.ts:16`                                   | A compatible English message remains the wire fallback                            | OK                                                                            |

New markers added by the audit's own PRs (#255, #256) are reviewed in those PRs:
`src/server/utils/cronRun.ts` (an unreadable failure record counts as a fresh
failure) and `src/server/core/communityGoalLeaseDiagnostics.ts` (an
unreadable holder only removes context from a contention log).
