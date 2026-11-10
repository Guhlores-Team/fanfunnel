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

## Batch 7 auth rules (sign-in family)

- **E-mail links are spent on POST only (WU-02 / WA-05).** Every template links to
  `{{ .SiteURL }}/auth/confirm?token_hash=…&type=…&next=…`. That page shows a Continue button;
  its form POSTs to `/auth/confirm/verify`, the only call to `verifyOtp` (`src/lib/auth/authLink.ts`).
  A GET never verifies a `token_hash` (mail scanners and link previews fetch every link), and no
  script auto-submits the form (sandboxes run scripts too). `/auth/callback` still exchanges the
  legacy PKCE `?code=` on GET (useless without the requesting browser's cookie) and forwards any
  `token_hash` to the landing page unspent.
- **A failed link says why, per type (WU-03).** `/login?error=auth_link&type=<type>&reason=<expired|invalid|malformed>`
  (`src/lib/auth/authCopy.ts`): a used confirmation says "already confirmed? sign in", an expired
  invitation offers "ask for a new invitation" and the reset link (a recovery link also confirms an
  invited address), an e-mail change points at Settings. Supabase reports a used link as
  `otp_expired`, so "expired" always covers "already used". Nothing says "same browser": the
  links work on any device.
- **Secure e-mail change is two links (WU-04).** Both the current and the new address get
  `email_change.html`; the first verify answers with no session and lands on `/auth/email-change`
  ("step 1 of 2 done"), never on the dashboard. Keep the Supabase setting ON.
- **Suspended creators keep a read-only dashboard (WU-01 / WG-01).** The proxy no longer bounces
  `is_active=false` to `/login?suspended=1`; `SuspendedBanner` explains on every section and
  `can_act_for()` / `current_user_active()` refuse the writes. The sign-in page still explains the
  old `?suspended=1` links.
- **New-password screens go through `POST /api/account/password/reset` (WU-06 / WU-07).** A
  session opened by a recovery or invite link in the last 2 hours (the token's signed `amr`
  claim, `openedByRecentLink` in `src/lib/auth/assurance.ts`) may set a password outright; any
  other signed-in session must give its current password, checked on a throwaway client like
  Settings › Security; a two-factor account gets `mfa_required` first and the screen shows the
  code step (`TotpChallenge`) instead of the provider's "AAL2 session is required".
- **A password change signs out everywhere else (WG-16 / WU-20).** `/api/account/password`,
  the reset route and `POST /api/account/sessions` ("Sign out other devices") call
  `signOut({ scope: "others" })` with the creator's own session (`src/lib/auth/sessions.ts`);
  no service key is involved and the current session stays.
- **Honest rate limits (WU-05).** Forgot-password and "Resend confirmation" keep the same answer
  for any address, except a Supabase 429 (`over_email_send_rate_limit` /
  `over_request_rate_limit`), which says "too many e-mails just now, try again in N minutes"; that
  reveals nothing about the address.
- **`POST /auth/signout` runs the same-origin check itself (RS-10)**; it is outside `/api/`, so the
  proxy's check never reaches it.

### Re-sending an admin invitation

Invitations expire with the project's Email OTP expiry (1 hour by default, up to 24 h; OWNER_STEPS stage 2 decides it, and the e-mails and pages say "for a limited time" so either value is consistent).
To re-send one: Admin › New account with the same address sends a fresh invite while the address is
still unconfirmed (`src/lib/data/creatorAccount.ts`). The invited person can also self-serve:
"Forgot password" with the invited address sends a recovery link, and verifying it confirms the
address and opens `/reset-password`. An expired link lands on `/login?error=auth_link&type=invite&reason=expired`,
which offers both paths.

### TEST manual checks (need a mailbox; not reproducible in the demo)

1. Request a reset on a laptop, open the mail on a phone: the Continue page shows, the tap lands on
   `/reset-password`, the new password works, and the laptop's session is signed out.
2. Open the same link twice: the second visit lands on `/login?error=auth_link&type=recovery&reason=expired`.
3. On an Outlook / Microsoft 365 mailbox: Safe Links fetches the URL, the human's tap still works.
4. A creator with two-factor on: the reset shows the code step before the password form.
5. Signed in normally, open `/reset-password`: the current password is required; a wrong one is refused.
6. Change e-mail with Secure email change ON: the first link lands on `/auth/email-change`, the second
   on the dashboard with the new address.
7. Ask for three resets within a minute: the third says "too many e-mails" (with the built-in mailer the
   project cap is 2 per hour; custom SMTP lifts it).
8. Invite a new account, let the invitation expire (or do not open it), then use "Forgot password"
   with the invited address: the link opens the new-password page and the account can sign in.
