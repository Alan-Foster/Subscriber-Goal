# Milestone notification replay safety

Production delivery remains disabled by `MILESTONE_NOTIFICATION_DELIVERY_ENABLED`.

A campaign is eligible from its recorded `completedTime` until, but not
including, seven days later. Page state is retained until fourteen days after
completion. A page is identified by the installation-scoped Redis namespace,
`postId`, `completedTime`, and the input cursor (including the empty first-page
cursor).

Each page uses a durable Redis state machine and a 60-second ownership lease.
Only untouched, prepared, or definitely funded work can be taken over. An
uncertain debit, uncertain refund, or started enqueue is retained as unresolved
and is never sent automatically again. This intentionally prefers a missed push
over a duplicate. A confirmed enqueue means the notification API accepted the
request; per-recipient failures are part of that confirmed result and do not
cause the page to be resent.

The confirmed result and exact child payload are written atomically with a
sorted-set recovery entry. The normal posts updater processes a bounded set of
due entries, revalidates the goal and deadline, and resubmits only that saved
payload. Failures are isolated and retried with exponential backoff. A scheduler
acceptance followed by a lost response may create duplicate child jobs, which
converge on the child's page identity. Recipient opt-ins can change between
distinct pages because each page still uses the notification API's cursor
semantics.

This protection begins once a page job reaches its registered handler. The
existing initial `runJob` call is unchanged: if it fails before accepting the
first-page job, no page record or updater recovery entry exists, so that initial
scheduling failure is a separate case and is not recovered by this mechanism.
