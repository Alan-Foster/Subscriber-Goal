# Ambiguous post submission recovery

Subscriber Goal writes an opaque creation marker to the operation record before
calling Reddit and includes the same marker in the custom post's `postData`.
When a response or the returned post ID is lost, a retry holds the normal
community and operation locks, scans at most 100 newest posts in the expected
subreddit, and reads their `postData`. Exactly one marker match is adopted and
continues through normal registration. A missing match, more than one match, a
listing failure, or any unreadable candidate remains blocked; a miss never
authorizes another submission.

Manual `manual-v2` operation records are retained for 24 hours. During that
window, reopening the same submitted form can reconcile and finish the original
attempt. After the record expires, the marker and expected-subreddit evidence
needed to connect that form attempt to an unregistered Reddit post are gone, so
automatic recovery is no longer possible. The post itself may still exist. A
moderator must inspect recent posts before starting a deliberate new form; a
future moderator-assisted recovery tool would need the original marker (or
other proof that uniquely verifies the post), the post ID, and the expected
subreddit. Legacy ambiguous records without a marker remain blocked unless the
original post can otherwise be verified.

The installed Devvit SDK provides bounded subreddit listings through
`getNewPosts` and marker reads through `getPostData`. Listings run through the
app account and do not expose a `runAs` option; they are expected to include
posts submitted with `runAs: "USER"`, but that visibility must be confirmed in
a live Devvit installation.
