# AGENTS.md: Subscriber Goal

Subscriber Goal is a Reddit Developer Platform (Devvit Web) app. It shows subscriber-goal posts with a progress bar, creates follow-up goals automatically (AutoGoal), keeps goals highlighted, crossposts to the hub subreddit, and sends milestone notifications. It runs on thousands of subreddits, so a bug ships to all of them at once. Correctness beats brevity.

## Platform version: read this first

- This app is pinned to **Devvit 0.15.4**. Every `@devvit/*` package in `package.json` uses that exact version.
- Do not upgrade, add, or remove `@devvit/*` packages, and do not run `npm audit fix --force`, unless the task explicitly asks for it.
- The documentation tools describe the **latest** Devvit release, which may be newer than 0.15.4. If the docs describe an API, option, or behavior that the installed types in `node_modules/@devvit/*` do not have, stop and report the mismatch. Never "upgrade" the code to match the docs.

## Devvit documentation is required

Before you write or change code that touches any Devvit or Reddit capability, check the official documentation at https://developers.reddit.com/docs and follow it. That covers:

- Redis (commands, transactions, limits)
- The scheduler and cron jobs
- Triggers (install, upgrade, mod actions, post events)
- The Reddit API client (posts, highlights, flair, modmail, wiki, users)
- Settings, forms, menu actions, realtime, notifications, analytics
- `devvit.json`, permissions, and request or storage limits

How to check, in order of preference:

1. Use the `devvit_search` tool from the `devvit` MCP server. For Redis commands, search `redis.<command>`, for example `redis.zRange`.
2. If that tool is unavailable, read the docs index at https://developers.reddit.com/docs/llms.txt and fetch the specific `.md` pages it lists.
3. Confirm signatures against the installed type definitions in `node_modules/@devvit/*`. The installed types win over the docs (see "Platform version").

Do not rely on memory for Devvit behavior. If the docs do not answer the question, say so in the PR. Do not guess.

### Known platform limits (confirmed)

- A server request or scheduled job must finish within **30 seconds**. Any loop over posts, users, or Redis keys must be bounded and batched, and must save a cursor to resume on the next run.
- The scheduler allows **10 live recurring actions** per installation. `runJob()` allows up to **60 calls per minute** and **60 deliveries per minute** per installation. See [Scheduler limitations](https://developers.reddit.com/docs/capabilities/server/scheduler#limitations).
- Redis storage is capped at **5 GB** for published apps and **100 MB** for unpublished (playtest) apps. Every new key needs an expiration or a cleanup path.
- `reddit.getPostById` is typed as `Promise<Post>` (never `undefined`). Code must still handle a post that has been deleted or removed. Wrap the call and check the post's status.

Add to this list only from the docs or from a confirmed answer by the Devvit AI assistant, with a link or date.

## Project rules

### Redis data safety

- **Never rename, reformat, or change the value of an existing Redis key or field name.** Stored data on live subreddits must stay readable. To move a key constant, move the declaration and re-export it. Keep the string byte-for-byte identical.
- Any change to a stored data format needs a migration plus code that still reads the old format, and must survive running twice (replay-safe).
- Prefer atomic writes (`watch`/`multi`, `SET NX`) over read-then-write when two runs could overlap. Assume every scheduled job and trigger can run twice, run concurrently, or be killed halfway.

### Locks, retries, timers

- Release locks only through `releaseOwnedRedisLock` (`src/server/utils/redisOwnedLock.ts`). Never `get` a lock and then `del` it: if the lock expired in between, that deletes another run's lock.
- Do not create a new hand-written lock, backoff formula, or "next run at" state machine when an existing helper or state can be reused. Search for one first and name it in the PR.
- Retries must have a cap and an exhausted state that is logged or reported. Never retry silently forever.

### Code size and structure

- Reuse before you write: search `src/` for an existing helper before adding a new one.
- Do not add to files over 1,500 lines (`onboardingSubscriberGoal.ts`, `modAction.ts`, `publicApi.ts`, `internalUi.ts`, `onboardingReminder.ts`, `subGoalData.ts`) when the new code can live in its own module.
- Keep new functions under about 80 lines. Split long flows into named steps.
- Don't make style-only rewrites of code you weren't asked to change.
- Don't add entries to `eslint-suppressions.json`; split the function instead. Run `npx eslint ./src --prune-suppressions` in refactor PRs to remove fixed violations.

### Behavior policies (intended, do not "fix")

- After a moderator unhighlights the canonical goal, the app highlights it again (since commit `d70b036`).
- Reconciliation keeps one app-managed highlight. It prefers the newest unfinished goal, then the newest goal completed less than 24 hours ago, then the newest Tiny or Action Button post. Other app-managed highlights are removed after verification, including app posts manually pinned by a moderator. When capacity is full, repair can free one app-managed slot before pinning and attempts to restore it if verification fails. Moderator-owned posts and ambiguous posts are preserved.
- Removed or spam-filtered goal posts are reversible (they may be approved later). Author-deleted posts are permanent.

## Commands

| Purpose                   | Command             |
| ------------------------- | ------------------- |
| Install                   | `npm ci`            |
| Unit tests (CI runs this) | `npm run test:unit` |
| Lint (CI runs this)       | `npm run lint:ci`   |
| Full local check          | `npm run check`     |
| Build                     | `npm run build`     |
| Playtest                  | `npm run dev`       |

- `npm run check` **rewrites files**: it runs `eslint --fix` and `prettier --write .`. Commit only formatting changes to files your task touched. Discard formatting changes to unrelated files.
- Never run `npm run deploy` or `npm run launch`. Never run `devvit upload` or `devvit publish`.
- Regenerate `package-lock.json` only when dependencies change, and confirm the diff has no unrelated changes (an older npm once dropped `libc` fields from it).

## Tests

- Every bug fix adds a test that fails before the fix.
- Every new scheduled job, retry, or lock gets tests for: running twice, two concurrent runs, a failure partway through, and a retry after that failure.
- Don't weaken, skip, or delete an existing test to make a change pass. If a test's expectation is wrong, explain why in the PR.

## Pull requests

Every PR description includes:

1. **What changed and why**, linking the issue.
2. **Docs consulted**: the Devvit doc pages (URLs) behind each platform API used or changed, or "No Devvit APIs touched".
3. **Data compatibility**: any Redis key, field, or stored format added or changed, and how old data is handled.
4. **Verification**: the commands you ran and their results.

## Review guidelines

When reviewing a PR in this repository, flag:

- A Devvit or Reddit API used or changed without a docs link in the PR, or used in a way that contradicts the docs or the 0.15.4 types.
- A loop or job that could exceed the 30-second limit or is not bounded and batched.
- A new Redis key without an expiration or cleanup path, or any change to an existing key's string.
- A read-then-write on shared Redis state where concurrent or repeated runs could corrupt it.
- A lock released without `releaseOwnedRedisLock`, or a new hand-written lock, backoff, or timer state where an existing one could be used.
- A retry without a cap or an exhausted state.
- New duplicate logic when an existing helper already does the job.
- Missing tests for the cases listed under "Tests".
- Changes to the intended policies above, unless the linked issue asks for them.
