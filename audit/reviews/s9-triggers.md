# S9 review: trigger handlers' error and skip responses

Sweep #238 (section 9), sub-task "`src/server/triggers/**`: trigger handlers'
error and skip responses". Covers the trigger routes in
`src/server/routes/internalSystem.ts`, plus `appChanged.ts` and `modAction.ts`.
`scheduler.ts` is covered by the cron rule work in #255.

## Trigger routes (`internalSystem.ts`)

| Trigger        | Error path                            | Skip / invalid path                  | Verdict                                                                                                    |
| -------------- | ------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `onAppInstall` | logged `internal_trigger_failed`, 503 | —                                    | OK. How Devvit handles a 503 from a trigger (retry or drop) is unverified; see #209 for the busy-lock case |
| `onAppUpgrade` | logged, 503                           | —                                    | OK, same note                                                                                              |
| `onModAction`  | logged, 503                           | invalid event logged at error, 400   | OK                                                                                                         |
| `onPostCreate` | logged, 503                           | **invalid payload: 400 with no log** | **`R-S9-09`**                                                                                              |

## `modAction.ts` skip branches (`handleManagedPostModAction`)

| Branch                                                 | Verdict                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| Action not in unsticky/removelink/approvelink/spamlink | OK: intended filter (other actions don't affect managed posts) |
| No target post                                         | OK: logged (`mod_action_validation_failed`)                    |
| App account lookup failed                              | OK: logged (`mod_action_context_missing`)                      |
| The app itself is the moderator                        | OK: intended, avoids reacting to its own actions               |
| Post isn't the app's                                   | OK: intended                                                   |
| Hub (authority) installation                           | OK: intended                                                   |
| Unsticky with no moderator name                        | **`R-S9-10`**: the displacement check is skipped silently      |
| Action with no mapped crosspost action                 | OK: intended                                                   |
