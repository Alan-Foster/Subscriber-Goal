# S9 review: core

Sweep #238 (section 9), sub-task "`src/server/core/**`: every `catch`,
fallback value and cleanup path". 24 files contain catches.

Method: every catch that doesn't rethrow was read in context. Most log
through `logDiagnostic`, or hand off to a failure handler that logs (onboarding,
AutoGoal, deletion, creation, highlight repair). Transaction cleanup catches
rethrow. Fallback values and cleanup paths that were already recorded
elsewhere are not repeated.

## New records

| Location                                          | Verdict                                                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `onboardingLifecycle.ts:99` + `appChanged.ts:127` | **`R-S9-17`**: a busy lease skips install/upgrade reconciliation until the next upgrade; the reason is dropped |
| `onboardingWarning.ts:463`                        | **`R-S9-18`**: a busy lease returns `notDue()` with no log                                                     |

## Already recorded

| Location                                                         | Record               |
| ---------------------------------------------------------------- | -------------------- |
| `onboardingSubscriberGoal.ts:595`, `:615` busy locks             | `R-W5-03`            |
| `onboardingSubscriberGoal.ts:670`, `:750` unparseable state      | `R-W5-02`            |
| `autoCreateNextGoal.ts:168`, `:176`, `:186`, `:278` silent skips | `R-W5-08`            |
| `autoCreateNextGoal.ts:286` silent successor cancel              | `R-W5-07`            |
| `sourcePostDeletion.ts:164`, `:240` silent retries               | `R-S9-01`            |
| `postRetirement.ts:31` narrow missing-post classifier            | `R-W6-01`, `R-S9-11` |
| `goalDiscovery.ts:34` search cap                                 | `R-W5-04`            |

## OK

Catches that log and continue by design: `appAccountHealth.ts` (unknown
health → logged and retried), `appAccountRecovery.ts` (notification failure
saved and logged), `appRepair.ts` (each phase logged; busy lease deferred at
`info`), `createSubscriberGoal.ts`, `subscriberGoalCreationSteps.ts`
(replacement, revalidation and highlight failures logged),
`milestoneNotifications.ts` (uncertain debit or refund saved as `unresolved`,
then rethrown), `postRetirement.ts` (failed phases collected and logged),
`scheduledPostDisplacement.ts`, `subscriberGoalPostFlair.ts`.
