# S9 review: data layer

Sweep #238 (section 9), sub-task "`src/server/data/**`: Redis read fallbacks
(`?? 0`, `?? []`, `|| null`), parse failures, partial writes".

## Catches

Every catch in `src/server/data/` either logs or rethrows after closing a
failed transaction (`recentSubscriberErasure.ts`,
`scheduledPostDisplacementQueue.ts`, `statisticsAnalytics.ts`). The silent ones
carry reviewed `diagnostic-allow-silent` reasons; the corrupt-record case in
`recentSubscriberOrder.ts` is `R-S9-02`.

## Read fallbacks and parse failures

| Location                                                                                                          | Pattern                               | Verdict                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `subGoalData.ts:290` `completedTime`                                                                              | `parseInt` with no validation         | **`R-S9-15`**: corrupt value → `NaN`, read as "not completed", no log                                          |
| `subGoalData.ts:598` AutoGoal `failureCount`                                                                      | `Number(raw) \|\| 0`                  | **`R-S9-15`**: corrupt counter restarts at 0                                                                   |
| `subGoalData.ts` `goal`                                                                                           | `parsePersistedSubscriberGoal`        | OK: validated; an unusable goal triggers the logged emergency fallback (`R-S9-12`)                             |
| `subGoalData.ts` successor suppression                                                                            | validated                             | OK: unknown values log `stored_state_conflict`                                                                 |
| `subGoalData.ts:506`, `:514`, `:999`, `:1202`                                                                     | `?? ""`                               | OK: these are writes, not reads                                                                                |
| `subGoalData.ts:1317`, `subscriberTracking.ts:173`                                                                | `(await redis.get(...)) ?? ""`        | Baseline in the #257 guard; an empty generation means "no erasure yet", which is correct. Confirm in S5 (#241) |
| `crosspostData.ts`, `createGoalDraft.ts`, `subscriberStats.ts`, `subscriberTracking.ts`, `subscriptionAttempt.ts` | `JSON.parse`                          | OK where checked: parse exceptions are logged                                                                  |
| `sourcePostDeletion.ts:38`, `subscriberTracking.ts:120`, `subscriptionAttempt.ts:80`, `crosspostData.ts:444`      | valid JSON, wrong shape → `undefined` | **`R-S9-16`**: treated as absent with no log                                                                   |

## Partial writes

Registering a goal touches several keys (registry, tracking, update queue,
goal hash) without one transaction. The known half-done states are already
tracked in #208 (unknown manual creation, lost delete response, partial
retirement) and are not re-recorded here. Transaction-level partial writes
(`watch`/`multi`) belong to S7 (#239).
