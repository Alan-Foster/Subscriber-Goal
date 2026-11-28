# S9 review: job failure handling and success reporting

Sweep #238 (section 9), sub-task "`src/server/jobs/**`: job failure handling
and success reporting". Reviewed on the `claude/238-s9-routes` tip.

## Shared runner (`runner.ts`, `queue.ts`, `record.ts`, `backoff.ts`)

| Behavior                                         | Verdict                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| A worker's `handle` throws                       | OK: logged (`job_runner_job_failed`), converted to `retry` with backoff                              |
| Retries run out                                  | OK: logged (`job_runner_attempts_exhausted`), status `exhausted`                                     |
| The time budget runs out                         | OK: logged (`job_runner_budget_deferred`) with the remaining count                                   |
| Indexing a job fails                             | OK: logged, and the run continues                                                                    |
| A due member has no matching worker              | **`R-S9-07`**: skipped silently, never cleared, and still takes one of 25 batch slots                |
| The worker lock is busy                          | **`R-S9-08`**: returns `not_due` with no log                                                         |
| Per-job results (`complete`/`retry`/`exhausted`) | **`R-S9-08`**: discarded by the callers, so a job retrying every minute is invisible until exhausted |

## Job entry points

| File                                                                      | Verdict                                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `scheduled.ts` (app repair, source deletion, scheduled-post displacement) | Result discarded (`R-S9-08`); displacement is omitted without a subreddit (`R-S9-07`)                                                |
| `onboarding.ts`                                                           | OK: dispatch failure logged (`scheduler_task_failed`); `remove` when nothing is due is intended, and the job is re-indexed every run |
| `automaticGoalRetry.ts`                                                   | OK: failures logged; behavior inside is assessed in #245 (`R-W5-07`, `R-W5-08`)                                                      |
| `milestoneNotificationRecovery.ts`                                        | OK: failures logged                                                                                                                  |
| `submissionReconciliation.ts`                                             | OK: four catches, all logged                                                                                                         |
| `appAccountHealth.ts`, `appAccountRecovery.ts`                            | No catches; errors propagate to the logged callers                                                                                   |

Retry caps: every runner job goes through `getJobRetry` with an exhausted
state, so 7.08 is satisfied for the runner itself. Caps outside the runner
are the S7 sweep's (#239).
