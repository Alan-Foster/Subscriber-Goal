# Subscriber Goal 1.9.1 release review

## Dependency audit exception

`npm audit --omit=dev` reports four high-severity findings through the Devvit
0.14.3 CLI dependency chain: `image-size`, `js-yaml`, `@devvit/cli`, and
`devvit`. The vulnerable packages were not found in the generated `dist`
application output. npm's available remediation is the semver-major Devvit
1.0.0 upgrade.

For the 1.9.1 patch, retain Devvit 0.14.3 and treat these findings as a reviewed
build/deployment-tooling exception. Evaluate Devvit 1.0.0 compatibility,
generated output, permissions, lifecycle triggers, and all release checks in a
separate upgrade before adopting it.

## Rollout checks

- Confirm install onboarding in the development subreddit.
- Confirm an upgrade does not send onboarding modmail or arm an automatic post.
- Remove Manage Posts from the app account and verify one recovery alert.
- Restore Manage Posts and verify post creation succeeds.
- Monitor onboarding, app-account health, migration, and lock diagnostics for
  the first 24 hours after publication.

## Release hardening

- Upgrades persist a durable repair marker; Reddit-heavy discovery, flair,
  sticky, and migration work runs from the bounded scheduler instead of the
  lifecycle request.
- Permission lookup failures are recorded as unknown and retried. Moderator
  recovery messages are sent only after a successful lookup confirms that
  Manage Posts permission is absent.
- Manual, onboarding, and successor post creation use stable operation IDs so
  a submitted post can be recovered after an internal persistence failure.
- Automatic successor creation is protected by an owner-token lock and a
  persisted source-to-successor relationship.
- Most Upvoted Today (`top-post-day`) is the localized blue default CTA.
