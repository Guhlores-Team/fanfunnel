# Storage cleanup protocol

Uploads use immutable `owner UUID/random UUID.webp` paths. A service-only SQL
intent commits before any storage request; the request is dispatched once with
`upsert: false`. Real raster bytes are decoded and reencoded as bounded WebP,
with EXIF/GPS and other metadata removed. Session eligibility is checked before
and after transfer, and SQL locks/checks the server-controlled profile before
publication. The media INSERT trigger repeats the eligibility check. Gallery
publication, row insertion and upload-intent binding commit in one idempotent
transaction keyed by the intent UUID. A lost acknowledgement preserves both
bytes and metadata for reconciliation instead of abandoning them separately.
No URL is issued after a failed post-upload check.

The three work tables have RLS owner/admin read policies and no client mutation
grants. All ten work RPCs are service-only. Work records contain paths,
IDs, states and safe error codes. Account jobs store link SHA256 hashes rather
than bearer links; exports omit those hashes, leases and media bytes/URLs. Work
has no cascading Auth/profile foreign keys, so deletion cannot erase its retry
paths.

## Account deletion and retries

After the existing password/MFA or active-admin/aal2 guard, SQL atomically
reserves the last-admin slot, captures the actual role/active state, creates the
job and quiesces writes. Caller hints cannot grant an admin role. Storage
cleanup covers all registered work and legacy/replaced objects under only that
owner's UID prefix in avatars and creator-media. A future absent bucket is
recognized through successful authenticated bucket metadata; real storage,
permission and network failures are errors.

Auth deletion follows confirmed storage cleanup. SQL checks Auth-user absence
to recover a lost acknowledgement. Tombstones, a single completion audit and
job completion commit atomically. Definite pre-Auth failures pause the job and
restore its captured role/active state; an authorized retry can resume it.
A later role, active-state or approval update invalidates that restoration fence,
including a same-value suspension of an already quiesced account. Ordinary
profile edits do not invalidate it. Direct reactivation is refused while cleanup
is pending. The service-owned pause transition and permitted restoration commit
in one transaction under the profile/job locks, so newer admin security decisions
win in either transaction order. This preserves the existing deletion-reservation
guard; broader last-active-admin protection for direct admin edits is a separate
hardening task and is not claimed by this protocol.
Crash-left pending jobs stay quiesced and use a three-minute worker lease.
Each authorized deletion attempt has its own UUID and persisted removal
manifest. Legacy object discovery rechecks the current attempt and worker after
each read; a stale response cannot authorize removal of newly uploaded objects.
Every destructive Storage or Auth call is registered durably before dispatch.
An outstanding or uncertain call blocks account restoration even after its
worker lease expires. A later worker cannot restore access while an earlier
call could still delete the account or its objects. A definite failure permits
restoration only after all outstanding destructive calls are settled.

Close/admin-delete return `202 {pending:true, reason, reviewRequired}` until
complete. The UI retains the account and never announces deletion for 202 or
malformed successes. Only explicit 200 + `ok:true` is final. POST
`/api/admin/account/storage-retry` retries an existing job after the normal
active-admin/aal2 guard; it cannot start arbitrary deletion. The secret-protected
retention route also processes existing jobs. Media removal is durably queued
before storage removal; its row and exactly-once moderation audit are finalized
only after storage acknowledgement.

## Uncertain transfers and operational limits

The two-minute deadline limits publication, not remote transfer lifetime. If a
process dies after dispatch and bytes are absent, the intent remains unresolved.
If the object appears later, a worker observes, settles and removes it. Work
older than 15 minutes is flagged for review; there is no unsafe timeout-based
force-completion endpoint. A request that never commits may remain pending
until an operator obtains definitive transfer/storage evidence. Such a job must
not be described as deleted.

A maintenance call processes at most 20 ordinary objects/jobs; an account pass
processes at most 100 registered objects, then bounded own-prefix sweeps. Storage
requests retry up to three times. Before inspecting bytes, ordinary work is
claimed atomically and its persisted attempt count, last-attempt time and
next-attempt time advance. Exponential backoff starts at five seconds and caps
at fifteen minutes, including absent uncertain objects. Those rows remain
unresolved but cannot monopolize every batch ahead of newer definite orphans.
Known completed work is retained 30 days;
uncertain/inflight and unfinished jobs never expire merely by age. Retention
returns 202 for pending work and 503 for processing failure with bounded counts.

## Scheduling and rollout

Vercel cron automatically runs only in Production. Preview/TEST needs a
separately configured authenticated scheduler or authorized manual calls.
Durable persistence does not imply that a scheduler has been configured.

An alias swap does not retire immutable old Preview URLs. Those URLs may accept
new calls to old untracked upload endpoints, so draining existing requests is
insufficient. Before claiming complete tracking coverage, retire or disable all
stale TEST Preview deployments with those routes using the authorized process,
verify their endpoints cannot accept uploads, and then check retained storage
work. Root/owner owns that deployment retirement and TEST scheduler setup; this
source change performs neither. Preserve DB-before-code, and make no Production
deployment or configuration change as part of Preview retirement.
