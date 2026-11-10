# Auth review of the merged batch-7 sign-in changes (read-only reviewer, on orch/fixes 3169542)

A1 HIGH (functional). Reset and invite cannot set a password via the new token_hash links.
- src/lib/auth/assurance.ts:75-79 `openedByRecentLink` accepts only amr `recovery` / `invite`; used at src/app/api/account/password/reset/route.ts:54-57.
- supabase/auth `internal/api/verify.go` verifyPost issues the session with `models.OTP` for EVERY type, so a session opened by `verifyOtp({ token_hash, type })` has amr `[{method:"otp", timestamp}]`. `recovery` / `invite` / `magiclink` only appear through the legacy PKCE code exchange. auth-js AMRMethods (node_modules/@supabase/auth-js/src/lib/types.ts:349-362) lists neither.
- Sequence: forgot-password → mail (recovery.html) → Continue → verify → /reset-password → probe answers 403 current_password_required → the form demands the forgotten password. Invite → /set-password the same; the invited creator never had a password.
- Tests miss it: route.test.ts and linkSession.test.ts use synthetic claims; e2e/auth-b7.mjs uses a fake token in demo mode.

A2 MEDIUM. Login CSRF on POST /auth/confirm/verify.
- src/lib/auth/authLink.ts:76-100, src/app/auth/confirm/verify/route.ts:8-10: no Origin or Sec-Fetch-Site check. The proxy check only runs for /api/ (src/proxy.ts:30-40) and `isCrossOriginWrite` returns false without a Cookie header (src/lib/security/sameOrigin.ts:94); login CSRF needs no cookie. SameSite=Lax is irrelevant; CSP form-action only constrains this site's pages; Next origin-checks Server Actions only.
- Exploit: attacker obtains a token_hash for their OWN account; evil.example auto-submits a top-level form POST to /auth/confirm/verify with it; the 303 sets the attacker's session cookies in the victim's browser, replacing the victim's session.

A3 LOW-MEDIUM. Verify is unthrottled; non-expiry failures read as "already used".
- authLink.ts:89-91 no app limiter; :67-69 `reasonFor` maps 429, 5xx and network errors to `invalid` → "already used or has expired" although the token is unspent. A banned user (403) also reads as expired.

A4 LOW. Opening a link while signed in as someone else silently switches accounts (authLink.ts:89-99); the old session is not revoked; an aal2 session is replaced by aal1.

A5 LOW. Double-click or Back on Continue burns the link (src/app/auth/confirm/page.tsx:48-59, plain form, nothing disables the button). Back then Continue while signed in: /login?error=… is redirected to /dashboard, so a recovery user ends on the dashboard, not /reset-password.

A6 LOW. Signed-in users never see the failed-link notice: src/lib/supabase/middleware.ts:124-129 redirects /login → /dashboard with search = "".

A7 LOW. ForgotPasswordForm.tsx:36-40 and ResendConfirmation.tsx:46-47: the comment "the rate limit reveals nothing about the address" is wrong for the per-address 60 s cooldown (unknown address → 200 twice; existing → 429 on the second). The oracle exists at the Supabase endpoint with the anon key regardless of this UI.

A8 LOW. ForgotPasswordForm.tsx:31-40 reports "Check your inbox" on any non-429 failure (offline, 5xx).

A9 LOW. src/app/api/account/password/reset/route.ts:46: the limiter runs before the body is read, so the empty-body session probe from NewPasswordForm.tsx:98 spends the 10/hour reset budget.

INFO: email_change.html says "tap the button in both" (wrong only if Secure email change is OFF; owner is told to keep it ON). `/signup?next=…` drops next. Legacy PKCE error redirects (?error=access_denied&error_code=otp_expired) fall to "malformed" copy (authLink.ts:137).

Checked and sound: redirects (safeNext), GET never spends a token, type/token_hash validated, no token logging, framing blocked, reset route trusts getUser()-validated claims, MFA accounts get mfa_required first, password change signs out other sessions, templates use {{ .SiteURL }}/auth/confirm?token_hash=…&type=….
