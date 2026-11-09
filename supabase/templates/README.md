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
broke it. Each template now builds its own link, from the **Site URL only**:

`{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=<type>&next=<fixed page>`

| Template | `type` | `next` |
|---|---|---|
| `confirmation.html` | `email` | `/pending` |
| `magic_link.html` | `email` | `/dashboard` |
| `invite.html` | `invite` | `/set-password` |
| `email_change.html` | `email_change` | `/dashboard` |
| `recovery.html` | `recovery` | `/reset-password` |

**Never build a link from `{{ .RedirectTo }}`.** That value is the `redirect_to`
whoever called Supabase's public `/recover` or `/otp` endpoint chose (with the
public anon key, for any victim's address). If the Redirect URL allow-list ever
matched a host an outsider can register (for example a `*.vercel.app` wildcard),
the victim's token hash, a complete one-time sign-in, would go to that host
(batch 6 attack audit, A1). `src/lib/auth/emailTemplates.test.ts` fails if any
template references `.RedirectTo`.

What this needs from the project settings (Authentication → URL Configuration):

- **Site URL** = the one origin the e-mails must open: on TEST the Preview alias
  (`https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app`), on
  LIVE the production domain (`https://fanfunnel.vercel.app` until a custom domain
  replaces it). A Preview on another branch receives its links on the alias.
- **Redirect URLs** = exact origins the team owns only (`https://<origin>/**`), no
  `*` in the host. They no longer shape the e-mail link; Supabase still checks
  them for the legacy `?code=` flow.

The app still passes `redirectTo` / `emailRedirectTo` (always
`<this site>/auth/callback?next=<same page as the table>`). The templates ignore
it; it only matters for a project whose templates are not pasted yet (the old
`{{ .ConfirmationURL }}` uses it).

`/auth/confirm` (and `/auth/callback`) verify the hash on the server
(`verifyOtp`, `src/lib/auth/authLink.ts`) and redirect only within this site
(`safeNext`), so the link works on any device. They still accept the old
`?code=` links, so mail already sent, and a project whose templates are not
pasted yet, keep working (same-browser only) until the owner pastes these.
A link that fails for any reason lands on `/login?error=auth_link`, which
explains it and offers a new link.

Owner step: set the Site URL and Redirect URLs as above, then paste the five updated link templates into **TEST now** and into
**LIVE at go-live** (docs/GO_LIVE.md §3). Admin "New account" invites need the
updated `invite.html` (the old one could not finish an invite).
