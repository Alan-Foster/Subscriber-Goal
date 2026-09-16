# Subscriber Goal 2.1.3 release review

## Pre-publish smoke test

- Upgrade one public SFW playtest subreddit and confirm onboarding is scheduled.
- Upgrade one NSFW playtest subreddit and confirm onboarding becomes terminally
  ineligible with `subreddit_not_sfw`; no reminder or post should be created.
- Confirm manual goals remain available in the NSFW subreddit, crossposting is
  disabled, and subscriber usernames are not shared.

## Rollout monitoring

Monitor diagnostics for 48 hours after publication. The configured rollout can
create its latest goals roughly 41 hours after upgrade.

- Compare eligibility counts for `subreddit_not_public`,
  `subreddit_not_sfw`, and missing safety metadata.
- Monitor reminder sent/cancelled and goal created/skipped/failed/retry events.
- Confirm NSFW crosspost attempts and NSFW username-sharing events remain zero.

If most communities unexpectedly fail SFW eligibility or automatic creation
failures spike, set `AUTOMATIC_ONBOARDING_ENABLED` to `false` and publish the
kill-switch patch before resuming the rollout.
