# Logging spec: no silent failures

This spec comes from the silent-error audit (#234, #237). Every audit issue's
"Patch command-line error output" step follows it. The goal: every location
that passes data prints an error to `devvit logs` when it fails, and nothing a
cron job does repeats silently.

## Platform limits

- `devvit logs` keeps at most **5,000 events or seven days**, whichever comes
  first ([Devvit FAQ](https://developers.reddit.com/docs/versioned_docs/version-0.15/guides/faq),
  "Building and Testing"). `posts-updater-job` runs every minute (1,440 runs a
  day), so each line it prints on every run uses about 29% of that budget for
  one day. Log failures and actions taken on their own lines; put
  deliberate skips and no-op outcomes in the run summary.
- Server code logs with `console.info` / `console.warn` / `console.error`.
  Client code only reaches the browser console. Client failures need the
  client error route (to be added under #237) before they show in
  `devvit logs`.

## The one logging channel

Use `logDiagnostic(level, event, context, error?)` from
`src/shared/diagnostics.ts`. It prints `[diagnostic] {json}`, sanitizes
usernames, user IDs, tokens and paths, and caps text length and context
fields. Don't change existing event names. Never log usernames or user IDs.

### Context fields

| Field                   | Meaning                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `workflow`              | The workflow, ideally the audit path id from `audit/paths.json` (e.g. `C5-queued-post-update`) |
| `phase`                 | The step within the workflow                                                                   |
| `area`                  | Optional: the inspection area id a log exists to cover (e.g. `"7.08"`)                         |
| `reason`                | Why something was skipped, deferred or rejected                                                |
| `operationId`, `postId` | Correlation ids when known                                                                     |

## Handoff points

Each of these must print a `warn` or `error` line with context when it fails:

- client → server request, and the client's handling of the response
- Reddit API call
- Redis read, write or transaction (including `exec()` returning `null`)
- trigger and scheduler entry
- job enqueue, dequeue and `runJob`
- realtime publish
- parse, serialize and validate
- every action a repeating cron job performs

Internal function-to-function calls are excluded unless they cross a category
boundary.

## Levels

| Outcome                                          | Level                                                     | Notes                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Failure                                          | `error` (or `warn` when it will be retried automatically) | Include the error object                                                                             |
| Deliberate skip, deferral, busy lock, ineligible | `info` with `reason`                                      | In a cron job, record it with `run.skip()` so it appears in the summary instead                      |
| Success of a request-driven workflow             | `info`, only at the final outcome                         | Not at every step                                                                                    |
| A location that genuinely can't log              | none                                                      | Add a `diagnostic-allow-silent: <reason>` comment; `src/shared/diagnosticsAudit.test.ts` enforces it |

## Cron jobs: `startCronRun`

`src/server/utils/cronRun.ts` implements the cron rule. `onPostsUpdaterJob`
(`src/server/triggers/scheduler.ts`) is the reference implementation.

```ts
const run = await startCronRun(redis, "posts_updater");
await run.action("queued_post_updates", () =>
  updateQueuedPosts(appSettings, subreddit),
);
if (!allowed) run.skip("automatic_goal_retry", "permission_work_paused");
await run.finish();
```

- `run.action(name, fn, outcomeOf?)` runs one action. If it throws, the error is
  logged as `cron_action_failed` with `repeatCount`, `firstSeenAt` and
  `recurring`, and the run continues with the next action. `outcomeOf` can
  map the result to `acted` / `skipped` / `idle`. A failed gate counts as
  closed (confirmation rule).
- Failure counts persist across runs in the Redis hash
  `cron_action_failures_v1:<job>` (field per action, 7-day expiry). The first
  success after failures logs `cron_action_recovered` and clears the field.
- `run.finish()` prints one `cron_run_summary` line per run: duration, failure
  counts, and `a_<action>` = `ran` / `acted(...)` / `skipped(reason)` /
  `failed(xN)` with each action's duration. That line also proves the job ran.
  It's `warn` when any action failed, `info` otherwise.

## Tests

Each logging change adds a test that the diagnostic fires on the failure
branch. See `src/server/utils/cronRun.test.ts` and the
"keeps running later actions when one throws" case in
`src/server/triggers/scheduler.test.ts`.
