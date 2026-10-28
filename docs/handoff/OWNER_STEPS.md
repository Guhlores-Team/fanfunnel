# FanFunnel — your steps to go live (owner checklist)

Tick each box as you go. "Me" = Claude does it; "You" = only you can (accounts, payments, legal).
Never paste passwords or API keys into chat — put keys straight into the service that needs them.

## Stage 1 — Lock down your accounts (free, ~30 min, do now)

- [ ] 1. **Gmail 2-step verification** (your login email for everything)
      https://myaccount.google.com/signinoptions/twosv → Get started → use an authenticator app or passkey (not SMS if you can avoid it).
- [ ] 2. **GitHub 2FA** — https://github.com/settings/security → Two-factor authentication → Enable.
- [ ] 3. **Vercel 2FA** — https://vercel.com/account → Settings → Authentication → Two-Factor Authentication → Enable.
- [ ] 4. **Supabase 2FA** — https://supabase.com/dashboard/account/security → Multi-Factor Authentication → Add.
- [ ] 5. **Resend 2FA** — https://resend.com → avatar → Settings → Security → Two-factor authentication.
- [ ] 6. **Upstash 2FA** — https://console.upstash.com → Account → Security (if you signed in with GitHub, step 2 covers it).
- [ ] 7. Have your partner do 1–6 for their own accounts too (anyone with access).
- [ ] 8. Save every 2FA **recovery code** in a password manager (1Password / Bitwarden / iCloud Keychain).

## Stage 2 — Supabase safety settings (free, ~10 min)

- [ ] 9. **Leaked-password protection** (blocks passwords found in breaches):
      Live: https://supabase.com/dashboard/project/ttlogfmogcccwiraaoae/auth/protection
      Test: https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu/auth/protection
      → turn on "Prevent use of leaked passwords" (may require Pro — then do it after step 16).
- [ ] 10. **Confirm email stays ON** (Sign In / Providers → Email → "Confirm email") in both projects.
- [ ] 11. **Site URL** (default link target):
      Live → https://supabase.com/dashboard/project/ttlogfmogcccwiraaoae/auth/url-configuration → Site URL = `https://fanfunnel.vercel.app` (change to the new domain in Stage 4)
      Test → https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu/auth/url-configuration → Site URL = `https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app`

## Stage 3 — GitHub safety settings (free, ~10 min)

- [ ] 12. **Secret scanning + push protection** (stops keys being committed):
      https://github.com/Guhlores-Team/fanfunnel/settings/security_analysis → enable Secret scanning and Push protection (and Dependabot alerts).
- [ ] 13. **Production approval gate** for live database migrations:
      https://github.com/Guhlores-Team/fanfunnel/settings/environments → `production` → Required reviewers → add yourself.
- [ ] 14. **Protect `main`** (needs GitHub Team on a private repo, ~$4/user/mo — optional):
      https://github.com/Guhlores-Team/fanfunnel/settings/branches → Add rule for `main` → require PR + passing checks.

## Stage 4 — Buy & connect (paid)

- [ ] 15. **Domain** — pick one (e.g. `fanfunnel.app` $9.99 then $15/yr). Buy at https://vercel.com/domains,
      or tell me the exact domain and I'll buy it through Vercel after you confirm the price.
      Then: turn on auto-renew. (Me: connect it to the site, DNS, Resend verification, anti-spam records,
      Supabase URLs, email sender, Terms/Privacy contact.)
- [ ] 16. **Supabase Pro** for the live project (~$25/mo — daily backups, no auto-pause):
      https://supabase.com/dashboard/org/gmsididujlbybxtzhgxl/billing → Upgrade.
      Optional add-on: Point-in-Time Recovery (undo to any minute).
- [ ] 17. **Vercel Pro** (~$20/mo/member — Hobby is non-commercial only):
      https://vercel.com/easy-simple-sites → Settings → Billing → Upgrade to Pro.
- [ ] 18. **support@ inbox** on the new domain — free forwarding to Gmail (e.g. https://improvmx.com),
      or Google Workspace (~$7/mo). (Me: add the DNS records once you pick.)

## Stage 5 — Keys & alerts (after the monitoring feature lands)

- [ ] 19. **Resend API key for error alerts** — https://resend.com/api-keys → Create → Permission "Sending access" → domain = your domain.
      Paste it ONLY into Vercel: https://vercel.com/easy-simple-sites/fanfunnel/settings/environment-variables
      → `RESEND_API_KEY` (Production), and `ALERT_EMAIL_TO` = the address(es) that should get alerts.
- [ ] 20. **Two-factor login inside FanFunnel** for your admin accounts (after the privacy & safety pack lands — I'll walk you through enrolling).

## Stage 6 — Legal & decisions

- [ ] 21. Read the new Terms & Privacy on the Preview (/terms, /privacy) and tell me changes.
- [ ] 22. **Lawyer review** — bring `docs/LEGAL_NOTES.md` (prize-wheel/sweepstakes question, adult-content rules, GDPR).
- [ ] 23. Optional: form an **LLC** (Massachusetts) — then I swap the operator name in one place.
- [ ] 24. Walk through the ~15 product decisions with me (a few at a time).

## Stage 7 — Test everything (on the Preview)

- [ ] 25. Work through `e2e/MANUAL-CHECKLIST.md` on real phones (iPhone + Android), as creator and as fan, including "Add to Home Screen".
- [ ] 26. Tell me which test accounts/fans to keep for live (I'll dry-run the copy and show you first).

## Stage 8 — Go-live day (together)

- [ ] 27. Me: copy chosen test data → live (after your OK on the dry run).
- [ ] 28. Me: apply database changes to live → merge `dashboard-redesign` into `main` (only on your explicit "go").
- [ ] 29. You + me: live smoke test (MANUAL-CHECKLIST §4).
- [ ] 30. Me: turn the Vercel Preview login back ON. You: confirm you can still reach the Preview while logged in.
- [ ] 31. Uptime alert (free): https://uptimerobot.com → New monitor → your domain → alert to your email.
