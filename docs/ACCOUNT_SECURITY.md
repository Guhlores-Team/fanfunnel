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
- **Only this site's own Continue page may spend a link (review A2).** `POST /auth/confirm/verify`
  creates a session, so it runs a strict same-origin check before anything touches Supabase or a
  cookie (`isOwnPagePost` in `src/lib/security/sameOrigin.ts`): `Sec-Fetch-Site` must be
  `same-origin` (`none`, `same-site` and `cross-site` are refused); when that header is absent
  (Safari before 16.4, older Firefox) the `Origin` must be the request's own origin, the
  `NEXT_PUBLIC_SITE_URL` origin or `https://` + the host the browser connected to; a POST with
  neither header is refused. This holds with or without cookies: a cross-site form holding an
  attacker's own token could otherwise sign a visitor's browser in as the attacker (login CSRF),
  which needs no cookie, so the proxy's `/api` check (cookie-carrying requests only) is the wrong
  rule here. A refused POST answers 303 back to `/auth/confirm?…&retry=origin` with the token
  unspent, so a human still has to press Continue on our page. The landing page must keep the
  site-wide `Referrer-Policy: strict-origin-when-cross-origin`: under `no-referrer` browsers send
  `Origin: null` on form POSTs. Other non-`/api` handlers checked: `POST /auth/signout` (keeps the
  cookie-gated check: without a session cookie there is nothing to sign out), `GET /auth/callback`
  (a PKCE code is useless without the verifier cookie only the requesting browser holds),
  `GET /signup` (redirect only). There are no Server Actions.
- **The verify POST is throttled, and a failure that decided nothing is not "used" (review A3).**
  `limitRoute(req, "auth-confirm-verify:POST", "costly")` (30 a minute per client) runs after the
  origin check and before the provider call. A limiter refusal, a provider 429 / 5xx, a non-JSON
  answer or a network error goes back to the Continue page (`retry=busy`: "nothing was used up,
  your link is still good, try again in a few minutes"). A blocked account (`user_banned`) lands on
  `reason=banned` with its own sentence and no offer of a new link. Only `otp_expired` (or a bare
  403) reads "already used or has expired" (`verifyFailureFor` in `src/lib/auth/authLink.ts`).
- **A failed link says why, per type (WU-03).** `/login?error=auth_link&type=<type>&reason=<expired|invalid|malformed|banned|busy>`
  (`src/lib/auth/authCopy.ts`): a used confirmation says "already confirmed? sign in", an expired
  invitation offers "ask for a new invitation" and the reset link (a recovery link also confirms an
  invited address), an e-mail change points at Settings. Supabase reports a used link as
  `otp_expired`, so "expired" always covers "already used". Nothing says "same browser": the
  links work on any device. Supabase's own error redirect of a legacy link
  (`?error=access_denied&error_code=otp_expired`) gets the expired copy, not "incomplete".
- **A link opened while signed in (reviews A4, A5, A6).** The verify route asks the Auth server who
  is signed in before it spends the token (`verifiedSession`, only when a session cookie is
  present). The Continue page says "You're signed in as X. Continuing will switch this browser to
  the account this link belongs to." (it runs behind the proxy with the nonce policy, so the
  session read keeps its cookies). After a successful verify the session the cookies held
  before is ended at the Auth server with its own token (`revokeSession`, `POST /logout?scope=local`,
  no service key), and when it belonged to a DIFFERENT account the landing page carries `?switched=1`: the dashboard, `/pending` and the
  new-password screens then show "You're now signed in as <e-mail>", the e-mail read from the
  session on the server, never from the URL (`SessionNotices`, `switchedNoticeFor`). When a link
  FAILS while a session exists, the visitor is not sent to `/login` (the proxy would pass them on
  with no explanation): a used reset or invitation link goes to its new-password page, whose own
  rule decides (this is the double tap and Back-then-Continue case); anything else goes to
  `/dashboard?auth_link=<reason>&type=<type>`, a fixed-text notice saying why nothing changed
  (`signedInLinkFailurePath` in `src/lib/auth/linkNotice.ts`). The proxy applies the same rule to a
  signed-in visitor on `/login?error=auth_link…`. The dashboard forwards the flags to `/pending`
  for an account that is not approved and a suspended account sees them above its read-only
  dashboard, so neither loops. The Continue button disables itself after the first tap and is a
  plain form without JavaScript.
- **Secure e-mail change is two links (WU-04).** Both the current and the new address get
  `email_change.html`; the first verify answers with no session and lands on `/auth/email-change`
  ("step 1 of 2 done"), never on the dashboard. Keep the Supabase setting ON.
- **Suspended creators keep a read-only dashboard (WU-01 / WG-01).** The proxy no longer bounces
  `is_active=false` to `/login?suspended=1`; `SuspendedBanner` explains on every section and
  `can_act_for()` / `current_user_active()` refuse the writes. The sign-in page still explains the
  old `?suspended=1` links.
- **New-password screens go through `POST /api/account/password/reset` (WU-06 / WU-07, review A1).**
  A session that an e-mail link or e-mail code opened in the last **hour** may set a password
  outright: its token's signed `amr` claim holds one of `otp`, `recovery`, `invite`, `magiclink`
  with the Auth server's own timestamp (`openedByRecentLink` / `LINK_SESSION_METHODS` in
  `src/lib/auth/assurance.ts`). `otp` is what Supabase Auth records for every `verifyOtp`, so it is
  what the current templates' `token_hash` links produce, whatever their type (a confirmation or
  e-mail change link too: each proves control of the mailbox, which is also all a reset needs);
  `recovery` / `invite` / `magiclink` only appear through the legacy PKCE code exchange. Because the
  rule covers every e-mail link, the window is one hour (it was two) and counts from when the link
  was opened; a token refresh does not extend it. Any other signed-in session (`password`, with or
  without a `totp` entry, and everything else) must give its current password, checked on a
  throwaway client like Settings › Security. A two-factor account gets `mfa_required` first, before
  the link rule and before any limiter, and the screen shows the code step (`TotpChallenge`)
  instead of the provider's "AAL2 session is required". A custom access-token hook that emits `amr`
  as bare strings, or an entry without a timestamp, fails closed. **Keep phone (SMS) sign-in off:**
  an SMS code is also recorded as `otp` and would count as a link session.
  What the unit tests can and cannot show: the claims are synthetic, and
  `src/lib/auth/linkFlow.test.ts` runs the real routes and clients against an in-memory Auth server
  that issues `otp`. Which method the hosted Auth server really issues is asserted only by
  `scripts/security/link-session-runtime-test.mjs` (TEST project; CI's hosted job runs it after the
  RLS runtime test). The installed `@supabase/auth-js` lists `otp` and `magiclink` among its amr
  methods and neither `recovery` nor `invite`; the Auth server's source is not in this repository.
- **Reset limits (review A9).** Ten password attempts an hour per account (`pwreset:<user>`); the
  screen's empty-body probe has its own limit (120 an hour, `pwreset-probe:<user>`), so reloading
  the page cannot use up the attempts.
- **A password change signs out everywhere else (WG-16 / WU-20).** `/api/account/password`,
  the reset route and `POST /api/account/sessions` ("Sign out other devices") call
  `signOut({ scope: "others" })` with the creator's own session (`src/lib/auth/sessions.ts`);
  no service key is involved and the current session stays.
- **One answer for any address (WU-05, reviews A7 / A8).** Forgot-password and "Resend
  confirmation" show "If an account exists for that address, an e-mail is on its way. You can ask
  again in a minute." for every address, including when Supabase refused the send with
  `over_email_send_rate_limit`: its per-address 60 second cooldown and the hourly e-mail cap only
  ever answer for an address that exists (an unknown one gets 200 and no mail), so wording them
  differently made the page an account oracle. Honest wording stays where the refusal does not
  depend on the address: a per-network limit (`over_request_rate_limit`: "too many requests from
  this network") and a request that got no answer (offline, a 5xx, a thrown error: "We couldn't
  send that just now. Check your connection and try again."), see `emailRequestOutcome` in
  `src/lib/auth/authCopy.ts`. **What the app cannot change:** anyone holding the public anon key
  can call Supabase's `/auth/v1/recover` and `/auth/v1/resend` directly and see 200 versus 429 for
  the second request inside a minute, and a provider 500 while the mailer is down also only
  happens for an existing address. Closing that needs a CAPTCHA on the Auth endpoints (Supabase
  Auth › Attack Protection, hCaptcha or Turnstile, plus the widget on these two forms and on
  sign-up): an owner decision, not built.
- **`POST /auth/signout` runs the same-origin check itself (RS-10)**; it is outside `/api/`, so the
  proxy's check never reaches it.

### Re-sending an admin invitation

Invitations expire with the project's Email OTP expiry (1 hour by default, up to 24 h; OWNER_STEPS stage 2 decides it, and the e-mails and pages say "for a limited time" so either value is consistent).
To re-send one: Admin › New account with the same address sends a fresh invite while the address is
still unconfirmed (`src/lib/data/creatorAccount.ts`). The invited person can also self-serve:
"Forgot password" with the invited address sends a recovery link, and verifying it confirms the
address and opens `/reset-password`. An expired link lands on `/login?error=auth_link&type=invite&reason=expired`,
which offers both paths.
An invited person who opens the link but waits more than an hour before choosing a password is
asked for a current password they do not have; the screen offers "Send a new reset link", which is
the same self-serve path.

### TEST manual checks (need a mailbox; not reproducible in the demo)

1. Request a reset on a laptop, open the mail on a phone: the Continue page shows, the tap lands on
   `/reset-password`, the new password works, and the laptop's session is signed out.
2. Open the same link twice: in a browser that is not signed in (a private window, another device)
   the second tap lands on `/login?error=auth_link&type=recovery&reason=expired`; in the browser the
   first tap signed in, it lands on `/reset-password` again (check 13).
3. On an Outlook / Microsoft 365 mailbox: Safe Links fetches the URL, the human's tap still works.
4. A creator with two-factor on: the reset shows the code step before the password form.
5. Signed in normally, open `/reset-password`: the current password is required; a wrong one is refused.
6. Change e-mail with Secure email change ON: the first link lands on `/auth/email-change`, the second
   on the dashboard with the new address.
7. Ask for three resets within a minute, for an address with an account and for one without: every
   answer is the same sentence ("If an account exists for that address, an e-mail is on its way. You
   can ask again in a minute."); no "too many e-mails" line appears for either (with the built-in
   mailer the project cap is 2 per hour; custom SMTP lifts it).
8. Invite a new account, let the invitation expire (or do not open it), then use "Forgot password"
   with the invited address: the link opens the new-password page and the account can sign in.
9. **The link-session rule (review A1), by hand.** Request a reset for an account whose password you
   will not use, open the mail, tap Continue: `/reset-password` must show ONLY "New password" (no
   "Current password" field, no amber notice). Set a password; it must work. Then invite a brand-new
   address from Admin › New account, open that mail, tap Continue: `/set-password` must show only
   the password field, and setting it must work. If either screen asks for a current password, the
   hosted Auth server does not issue an `amr` method the rule accepts: do not ship; run check 10 and
   send its output.
10. **The same rule, by script.** With the TEST project's URL, anon key and service-role key in the
    environment (never production; the script refuses it):
    `npx tsx scripts/security/link-session-runtime-test.mjs`. It generates a recovery link, a magic
    link and an invitation without sending mail, opens each the way the app does, prints the
    session's `amr` (`LINK_SESSION_AMR {…}`, expected `otp` for all three), sets a password through
    the app's rule and deletes its users. CI's hosted job runs it after the RLS runtime test.
11. Open a reset link, wait 61 minutes on `/reset-password`, reload: the screen now asks for the
    current password and offers "Send a new reset link".
12. Signed in as creator A, open a reset link for creator B and tap Continue: before the tap the page
    says "You're signed in as A…"; afterwards `/reset-password` says "You're now signed in as B",
    and A's other tab is signed out on its next action.
13. Double-tap Continue on a reset link (or tap it, press Back, tap again): you end on
    `/reset-password` and can still set the password; never on the dashboard without a word.
14. Signed in, open an already used e-mail change link and tap Continue: the dashboard shows "That
    e-mail change link was already used or has expired. Nothing was changed by it…".
15. Unplug the network (or use DevTools › Offline) and submit Forgot password: "We couldn't send that
    just now. Check your connection and try again.", never "Check your inbox".
16. On an iPhone (Safari) and in Firefox, open a reset link and tap Continue: it must reach
    `/reset-password` (the origin check is unit-tested for both browsers' headers; this is the
    real-device confirmation). If the Continue page comes back saying "we only accept this step
    from this page", report the browser and version.
