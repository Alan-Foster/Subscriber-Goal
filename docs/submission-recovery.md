# Ambiguous post submission recovery

Subscriber Goal writes an opaque creation marker to the operation record before
calling Reddit and includes the same marker in the custom post's `postData`.
When a response or the returned post ID is lost, a retry holds the normal
community and operation locks, scans at most 100 newest posts in the expected
subreddit, and reads their `postData`. Exactly one marker match is adopted and
continues through normal registration. A missing match, more than one match, a
listing failure, or any unreadable candidate remains blocked; a miss never
authorizes another submission.

Manual form drafts expire after 30 minutes. While the original draft remains
valid, retrying that same submitted form can reconcile and finish the original
attempt. After the draft expires, the app must not reconstruct creation settings
from stale callback values, so it cannot resume registration. The separate
`manual-v2` operation record remains available for 24 hours only for status
lookup and navigation when creation already completed. An ambiguous post may
still exist: moderators must inspect recent posts before starting a deliberate
new form. After the operation record expires, the marker and expected-subreddit
evidence are also gone. A future moderator-assisted recovery tool would need the
original marker (or other proof that uniquely verifies the post), the post ID,
and the expected subreddit. Legacy ambiguous records without a marker remain
blocked unless the original post can otherwise be verified.

Automatic creation uses six bounded reconciliation scans, scheduled 1, 5, 15,
30, 60, and 120 minutes after the preceding state transition or inconclusive
scan. The operation record owns this schedule; AutoGoal mirrors `nextRunAt` into
its existing queue and onboarding mirrors it into its existing state. After the
sixth inconclusive scan, reconciliation is exhausted and automatic scans stop
without changing ordinary creation retry counts.

The installed Devvit SDK provides bounded subreddit listings through
`getNewPosts` and marker reads through `getPostData`. Listings run through the
app account and do not expose a `runAs` option; they are expected to include
posts submitted with `runAs: "USER"`, but that visibility must be confirmed in
a live Devvit installation.
