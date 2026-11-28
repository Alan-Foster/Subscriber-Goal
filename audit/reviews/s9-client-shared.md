# S9 review: client and shared

Sweep #238 (section 9), sub-tasks "`src/client/**`: `fetchWithRetry.ts`,
hooks' error states, fallbacks shown as real data" and "`src/shared/**`".

## Client (`src/client/`)

Every catch in the 14 client files with catches either logs with
`logDiagnostic` or carries a reviewed `diagnostic-allow-silent` reason (see
`s9-allow-silent-markers.md`). **All client logging goes to the browser
console only**, so for `devvit logs` every client failure branch is ◐
(partial) until #237's client error route exists.

| Area                                                                                    | Verdict                                                                                               |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `fetchWithRetry.ts`                                                                     | OK: retries are capped and logged; abort during sleep is expected                                     |
| Initial load (`useSubGoalLoading.ts`)                                                   | OK: failure logged and an error state shown                                                           |
| Refresh (`useSubGoalRefresh.ts`)                                                        | **`R-S9-13`**: backs off to 15 minutes and keeps old counts with no stale indicator                   |
| Realtime (`useSubGoalRealtime.ts`)                                                      | OK: logged; refresh is the fallback                                                                   |
| Join (`subscriptionRequests.ts`, `useGoalAppSubscription.ts`, `useTinySubscription.ts`) | OK: logged; reconciliation handles lost responses. Correctness of "joined" is assessed in #247 (2.04) |
| Post-join button (`AfterSubscribeButton.tsx`)                                           | OK: logged, with fallback navigation                                                                  |
| Statistics page                                                                         | OK: shows a load error, not zeros; clipboard failure falls back to manual copy                        |
| Analytics (`goalJourneyAnalytics.ts`, `statisticsAnalytics.ts`)                         | OK: logged; storage fallback reviewed                                                                 |
| `startupPerformance.ts`                                                                 | OK: optional instrumentation                                                                          |

## Shared (`src/shared/`)

Three files have catches: `afterSubscribeAction.ts` (2), `diagnostics.ts` (1)
and `i18n/errors.ts` (1). All carry reviewed `diagnostic-allow-silent` reasons
that hold.
