# Auth email templates

Branded HTML for Supabase Auth emails. Supabase does not read these files from
the repo for hosted projects: paste each one into **Authentication → Emails →
Templates** in BOTH the test and prod projects whenever it changes.

| File | Template | Subject |
|---|---|---|
| `recovery.html` | Reset password | Reset your password |
| `confirmation.html` | Confirm signup | Confirm your email |
| `magic_link.html` | Magic link | Your sign-in link |
| `invite.html` | Invite user | You're invited |
| `email_change.html` | Change email address | Confirm your new email |
| `password_changed.html` | Security → Password changed (turn on) | Your password was changed |
| `email_address_changed.html` | Security → Email address changed (turn on) | Your email address was changed |

Reauthentication and the phone / sign-in method / MFA-factor notices keep
Supabase's defaults: there is no phone auth or linked identities, and the
two-factor (authenticator app, TOTP) notices are not customised yet. Two-factor
itself is on: admins must use it and creators can turn it on in Settings ›
Security.

Every link template shows the link twice (button + plain URL) because Gmail disables
buttons in mail it files as spam, and some clients strip styled anchors.

## Links work in any browser (token_hash)

The five link templates no longer use `{{ .ConfirmationURL }}`. That link ends in
a PKCE `?code=`, which only the browser that asked for the e-mail can use: a reset
requested on a laptop failed on the phone, and in-app mail/Instagram browsers
broke it. Each template now builds its own link:

- the app's own redirect (`{{ .RedirectTo }}`, always `…/auth/callback?next=…`)
  plus `&token_hash={{ .TokenHash }}&type=…`, or
- when Supabase had no allowed redirect (`.RedirectTo` equals `.SiteURL`, e.g. a
  reset or invite sent from the Supabase dashboard): `{{ .SiteURL }}/auth/confirm?next=…`
  plus the same two parameters.

`/auth/callback` and `/auth/confirm` verify the hash on the server
(`verifyOtp`), so the link works on any device. They still accept the old
`?code=` links, so mail already sent, and a project whose templates are not
pasted yet, keep working (same-browser only) until the owner pastes these.
A link that fails for any reason lands on `/login?error=auth_link`, which
explains it and offers a new link. Every `redirectTo` the app passes must keep
its `?next=…` query (`src/lib/auth/emailTemplates.test.ts` checks), because the
templates append `&token_hash=…`.

Owner step: paste the five updated link templates into **TEST now** and into
**LIVE at go-live** (docs/GO_LIVE.md §3). Admin "New account" invites need the
updated `invite.html` (the old one could not finish an invite).
