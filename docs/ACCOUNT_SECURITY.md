# Account security and consent lifecycle

Migration0062 follows0059,0060 and0061 in numeric order. The integrated
schema, generated types, configured Auth runtime and Preview must all be verified
before release.
No hosted execution or deployment is established by this document.

Creators choose whether to enroll two-factor sign-in. Once Auth contains a
verified factor, their authenticated business reads/writes and agency authority
require the signed session's aal2 claim. Unverified enrollment does not force the
step. Factor state comes from auth.mfa_factors, roles/activity/approval come from
profiles; editable user/app metadata supplies neither. Admin tools retain
mandatory aal2. Public token-bound fan routes, reward history and trusted service
maintenance do not acquire a creator-login dependency.

Shared SQL predicates gate RLS and authenticated admission to service work.
Password/email/reset and first-admin bootstrap apply explicit request-bound
step-up before mutation. Recovery opens the existing authenticator page in a new
tab with a fixed safe return destination. The original tab retains unresolved
intents/drafts; no passwords or payloads enter URLs/storage and no action retries
automatically. Return after verification and submit manually. Same-origin auth
cookies upgrade both tabs; actual session refresh/retry must be browser-verified
on the configured TEST Preview, retaining any original economic operation UUID.

Pending agency invitations last AGENCY_INVITE_TTL_DAYS=7 days. SQL checks its
persisted deadline against the wall clock after recipient/invitation locks.
Repeated sends leave a live deadline unchanged. Expiry refuses acceptance;
reissue creates a new UUID, and old/accepted IDs cannot accept a new invitation.
Both inboxes omit expired rows; the incoming inbox explicitly filters the verified
user email. Owner mutations use consent RPCs; direct authenticated lifecycle
insert/update/delete is revoked. Expired records are pruned 90 days after expiry;
accepted records retain their account lifecycle.

The active-admin invariant counts role=admin AND is_active. Inactive admins do
not justify removing the last active admin. Direct demotion/suspension/deletion
and both deletion reservations share serialization before profile row locking;
no operation locks other admin rows after its target. The 0058 durable account
gateway acquires the same ordering, retaining restore_allowed, manifests and
uncertain-dispatch fences. Trusted bootstrap from zero administrators remains
possible: since 0065 it is the single service RPC `bootstrap_first_admin`, which
takes this same active-admin fence before any profile row, refuses once any admin
exists, requires the account's own confirmed email and fails closed, so racing
claims yield exactly one admin (after the route's allow-list and MFA step-up). Refusal leaves all rows unchanged and tells the owner to add/reactivate
another admin first.

Local tests exercise authenticated RLS, seven-day expiry/reissue, expiry after a
lock wait, concurrent admin removals, deletion/security ordering and prior storage
restoration races. TEST runtime source enrolls/verifies TOTP only for a disposable
fixture with fresh password/challenged sessions. Secret/code/URI/tokens remain in
memory; factor/user cleanup is in finally. Missing MFA capability fails its
positive check. Actual hosted proof remains a release gate.

Admin mutation failures are explicit: last_admin and account_cleanup_pending
return409 with readable recovery guidance. The route records success audit events
only after an updated row is returned; missing/RLS-filtered rows and rejected
mutations do not produce success events. Focused tests cover those cases and
anonymous/non-admin refusals through the actual guard/data-helper/route chain.

## Separate creator and service requests

An authenticated request mints `issue_creator_actor_context(creator, permission)`
using its actual signed session. The database records the actor, Auth session ID,
creator, scope and signed assurance, never editable metadata. A capability expires
within60seconds, the JWT expiry and session deadline. Revoked/deleted Auth sessions
invalidate it immediately. A verified factor added after an AAL1 mint also prevents
business access. Current profiles-backed role/agency permissions are checked again
after mutation admission locks. Grant, game-edit, reconciliation and system-health
scopes cannot substitute for one another; system-health issuance requires the real
active administrator with AAL2 and creator bound to that same administrator.

The separate service JWT never supplies creator assurance. Private SQL plumbing
restores request claims after evaluating the existing permission matrix using only
the validated stored capability. No caller GUC, browser flag or raw actor ID is
accepted in place of that capability. Old service overloads are owner-only and old
impersonation helpers fail closed. Fan token-bound reads/play and server maintenance
remain independent. Existing actor-only reconciliation can still return a bare known
terminal outcome after MFA/permission loss; private business receipts require current
authority. An HTTP retry mints fresh authority but retains its original economic UUID
and exact payload, so a lost response cannot create another grant.

Issuance has a database-enforced32-live-context limit per actor, serialized only in
its own advisory namespace. It does not nest the active-admin, profile, fan or inventory
locks. Expired rows are pruned before mint and by retention; Auth deletion cascades.
Capabilities have no browser table grants, client storage, logs or privacy exports.
They contain existing account/session identifiers and assurance, without new contact
information. The active-admin serialization identity/order and0058 restore fence are
unchanged.0063 explicit canary initialization must use the system-health scope;
empty-inventory bootstrap remains its separate server-only maintenance path.

Invitation acceptance and decline recheck current activity, approval and verified-factor MFA after acquiring the recipient profile lock. A suspension, approval withdrawal or factor verification committed during that wait leaves both membership and invitation status unchanged.
The invitation sender also rechecks current owner/MFA/approval authority after its existing recipient and invitation lock waits, before creating or reusing an invitation. This adds no lock and preserves the existing recipient-before-invitation ordering.

## Batch 6 attack-audit rules

- **Cross-origin writes (N5):** a cookie-carrying `/api` write passes the origin check when
  `Sec-Fetch-Site` is `same-origin`, or its `Origin` names `Host` or `NEXT_PUBLIC_SITE_URL`.
  `X-Forwarded-Host` counts only when the server runs on Vercel (`VERCEL=1`) **and** the request
  carries Vercel's own `x-vercel-id` and `x-vercel-deployment-url` (the edge overwrites all three);
  anywhere else it is client input (`src/lib/security/sameOrigin.ts`).
- **Signed-out dashboard calls (N1):** with Supabase configured, an `account`-tier route answers
  401 when the request has no Supabase session cookie (`limitRoute`, `src/lib/api/limit.ts`); the
  route's session/RLS check stays the authority for a cookie that is present.
- **Win claim codes (C4):** the 6-character code on a win card is an HMAC of the share id under a
  key derived from `REWARD_CODE_FINGERPRINT_KEY` (`src/lib/rewards/claimCode.ts`), sent only in the
  winner's spin response. A creator checks it on `/verify/<share id>`. It proves the sender holds
  the fan's win page (or was given the code), not who they are.
- **Report tokens (N4):** a fan report stores `t1:<last 4>:<sha256>` of the link token, never the
  token (`src/lib/reports/reportToken.ts`).
