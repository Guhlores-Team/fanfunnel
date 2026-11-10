# FanFunnel — your steps to go live (owner checklist)

Tick each box as you go. "Me" = the agent does it; "You" = only you can (accounts, payments, legal).
Never paste passwords or API keys into chat — put keys straight into the service that needs them.
Once live, the daily / weekly / release routine is `docs/OWNER_CHECKLIST.md`; incidents are `docs/RUNBOOK.md`.

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
- [ ] 11. **Site URL** (every sign-in, reset and invitation e-mail links to this address and nothing else):
      Live → https://supabase.com/dashboard/project/ttlogfmogcccwiraaoae/auth/url-configuration → Site URL = `https://fanfunnel.vercel.app` (change to the new domain in Stage 4)
      Test → https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu/auth/url-configuration → Site URL = `https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app`
- [ ] 11a. **Redirect URLs, exact only** (same two pages, "Redirect URLs"): keep exactly
      Live: `https://fanfunnel.vercel.app/**` — Test: `https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/**` and `http://localhost:3000/**`.
      **Delete** any entry with a `*` in the host, such as `https://*.vercel.app/**` or `https://fanfunnel-*-easy-simple-sites.vercel.app/**`: an outsider can register a Vercel site with a matching name.
- [ ] 11b. **Paste the five e-mail templates** (without them a link only works in the browser that asked for it):
      Test now: https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu/auth/templates — Live at go-live: https://supabase.com/dashboard/project/ttlogfmogcccwiraaoae/auth/templates
      For each of **Confirm signup, Invite user, Magic link, Change email address, Reset password**: open the matching file in `supabase/templates/` (`confirmation.html`, `invite.html`, `magic_link.html`, `email_change.html`, `recovery.html`), copy the whole file, paste it over the template body, Save. Then, on the same page, turn **on** the two notices **Password changed** and **Email address changed** and paste `password_changed.html` / `email_address_changed.html`. Check on Test: request a reset on your laptop, open the link on your phone → it must reach the new-password page.
- [ ] 11c. **Custom SMTP through Resend** (the built-in mailer sends at most 2 e-mails per hour for the whole project; past that, resets silently never arrive):
      Test: https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu/settings/auth → "SMTP Settings" → Enable Custom SMTP → Sender e-mail `account@easysimplesites.org`, Sender name `FanFunnel`, Host `smtp.resend.com`, Port `465`, Username `resend`, Password = a Resend API key with Sending access (create it at https://resend.com/api-keys, name `fanfunnel-supabase-test`; paste it only here). Live: same page under `ttlogfmogcccwiraaoae` with a second key named `fanfunnel-supabase-live`.
- [ ] 11d. **E-mail OTP expiry** (Authentication → Providers → Email → "Email OTP Expiration"): raise it from 3600 to `86400` seconds (24 h) in both projects, so an admin invitation opened after lunch still works. (If you prefer the stricter 1 hour, tell me and the RUNBOOK's "re-send an invitation" step stays the answer.)
- [ ] 11e. **Secure email change** (Authentication → Providers → Email → "Secure email change"): decide. **ON** (recommended, the default): the old AND the new address each get a link and both must be opened; the app shows "step 1 of 2 done" after the first. **OFF**: one link to the new address only (an attacker in a signed-in session can move the account). Tell me which, so the Settings copy says the same.
- [ ] 11f. **Minimum password length = 8** (Authentication → Providers → Email → "Minimum password length") in both projects. The app's own rule (8+, a letter and a digit) runs in the browser only; the project default of 6 would accept a weaker password sent straight to the sign-in API.

## Stage 3 — GitHub safety settings (free, ~10 min)

- [ ] 12. **Code security, all five switches** (checked 2026-11-10: all still off):
      https://github.com/Guhlores-Team/fanfunnel/settings/security_analysis → enable **Dependabot alerts**, **Dependabot security updates**, **Secret scanning**, **Push protection** (stops keys being committed) and **Private vulnerability reporting** (an outside researcher can tell you privately; `SECURITY.md` points there).
- [ ] 13. **GitHub environments** (three; each takes a minute):
      https://github.com/Guhlores-Team/fanfunnel/settings/environments
      - `production` → Required reviewers = you ("Prevent self-review" off) → Deployment branches and tags = **Selected branches** → add `main` → description "Approve only after today's LIVE backup is listed" → environment secrets `SUPABASE_PROD_PROJECT_REF`, `SUPABASE_PROD_DB_PASSWORD`, `SUPABASE_ACCESS_TOKEN`. This is the human click before anything touches the live database; the job then also refuses to run without a backup from the last 36 hours.
      - `test` → environment secrets `SUPABASE_TEST_DB_URL`, `SUPABASE_TEST_PROJECT_REF`, `SUPABASE_TEST_DB_PASSWORD` only (`docs/handoff/GO_LIVE_KEYS.md` step 9). Every pull request can reach this one, so nothing with live reach goes here.
      - `test-maintenance` (new) → Required reviewers = you → Deployment branches = **Selected** → `dashboard-redesign` → environment secrets `SUPABASE_ACCESS_TOKEN`, `VERCEL_TOKEN`, `FANFUNNEL_TEST_CRON_SECRET`. The manual TEST jobs (maintenance scheduler, Preview measurements) read them from here.
      Then delete the repository-level copies of those five names at https://github.com/Guhlores-Team/fanfunnel/settings/secrets/actions (keep the three `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` TEST secrets), and revoke + re-create the Supabase access token at https://supabase.com/dashboard/account/tokens.
- [ ] 14. **Rulesets for `main` and `dashboard-redesign`** (free on a public repository; `main` is already protected since batch 6 — this makes the list of required checks complete):
      https://github.com/Guhlores-Team/fanfunnel/settings/rules → New branch ruleset → target `main` → require a pull request, block force pushes and deletions, **Require status checks to pass** = `verify`, `schema-drift`, `supabase`, `login-ui` and `test` (the migration job). A second ruleset for `dashboard-redesign`: block force pushes and deletions only.
      Also https://github.com/Guhlores-Team/fanfunnel/settings/actions → Workflow permissions = **Read repository contents**; untick "Allow GitHub Actions to create and approve pull requests"; Fork pull request workflows = **Require approval for all external contributors**; tick **Require actions to be pinned to a full-length commit SHA**.
- [ ] 14a. **Same test-database secrets for Dependabot** (missing secrets FAIL the security checks; only fork PRs skip; since batch 7 the migration `test` job skips visibly on Dependabot PRs that change no database file):
      https://github.com/Guhlores-Team/fanfunnel/settings/secrets/dependabot → add `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` with the TEST project's values (never the live ones).
- [ ] 14b. **Hold live deploys until the database is ready** (Vercel Deployment Checks, see `docs/GO_LIVE.md` §5):
      https://vercel.com/easy-simple-sites/fanfunnel/settings/build-and-deployment#deployment-checks → Add Checks → GitHub → require `db-migrations-production`.
      Then https://vercel.com/easy-simple-sites/fanfunnel/settings/environments/production → keep automatic aliasing for Production ON.
      **Prove it before the real release** with a one-line code-only PR to `main` (I prepare it, you merge and approve): the new deployment must sit un-aliased (also the plain `fanfunnel.vercel.app` address, not only a custom domain) until the job is green.
- [ ] 14c. **Fork protection and the branch allow-list**: https://vercel.com/easy-simple-sites/fanfunnel/settings/git → **Git Fork Protection** on. Since batch 7 `vercel.json` builds only `main` from Git (every other branch is off); after the first merge, confirm a Production deployment was created (`docs/PREVIEW_DEPLOY.md` says what to do if not).
- [ ] 14d. **Close the stale pull request #42** (the `eager-volta-l8juq7` branch): it still carries the old workflow with the account token at job level; any push to it runs that file. Close it and delete the branch; delete other stale branches (keep `archive/*` as tags).

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
- [ ] 19a. **Live reward keys and cron secret** (missing from Production as of 2026-11-04, with `ADMIN_EMAILS`, `FF_REQUIRE_SUPABASE`, the VAPID trio and the alert pair; Preview already has the two reward keys).
      **Step by step, in order, with the exact names: `docs/handoff/GO_LIVE_KEYS.md`.** In short:
      on the same page, scope **Production** only, generate fresh values (never copy Preview's):
      `REWARD_ENCRYPTION_KEY` and `REWARD_CODE_FINGERPRINT_KEY` (each `openssl rand -base64 32`, mark Sensitive,
      back both up privately, never rotate them to silence an error) and `CRON_SECRET` (`openssl rand -hex 32`).
      Without them the live System health page stays red and the nightly retention cron / error alerts refuse to run.
- [ ] 19b. **Fluid compute** — https://vercel.com/easy-simple-sites/fanfunnel/settings/functions → **Fluid compute** must be **on** (the nightly job and the slow-database paths rely on its 300-second default duration). Tell me what the page shows.
- [ ] 19c. **Second Upstash store for Preview** — today every branch build holds a write token to the live site's rate limits. `docs/handoff/GO_LIVE_KEYS.md` step 7 (create `fanfunnel-preview`, connect it to Preview only, untick Preview on the five old variables). Which Upstash plan the live store is on, and its monthly command allowance (item 33), decides whether an alert is needed there too.
- [ ] 19d. **Monitor accounts** — create https://uptimerobot.com (monitor on `https://<site>/api/health`, every 60 s, alert to your e-mail) and https://healthchecks.io (one check, period 1 day, grace 6 hours; its ping URL becomes `HEARTBEAT_URL`, GO_LIVE_KEYS step 6b) under your own e-mail with two-factor on. Tell me which e-mail they alert so the RUNBOOK's "what a down e-mail means" matches.
- [ ] 20. **Two-factor login inside FanFunnel** for your admin accounts (after the privacy & safety pack lands — I'll walk you through enrolling).

## Stage 6 — Legal & decisions

- [ ] 21. Read the new Terms & Privacy on the Preview (/terms, /privacy) and tell me changes.
- [ ] 22. **Lawyer review** — bring `docs/LEGAL_NOTES.md` (prize-wheel/sweepstakes question, adult-content rules, GDPR) and the open questions in `docs/LAWYER_QUESTIONS.md`.
- [ ] 23. Optional: form an **LLC** (Massachusetts) — then I swap the operator name in one place.
- [ ] 24. Walk through the ~15 product decisions with me (a few at a time).

## Stage 7 — Test everything (on the Preview): the owner test script

One numbered run that covers every feature in `e2e/MANUAL-CHECKLIST.md` and the batch-6 Preview
re-test list (the mapping is at the end). Where: the Preview
https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app (teal "PREVIEW · TEST database"
badge on every page; if it is red, stop). Use disposable TEST accounts, fans, photos and dummy
codes. Never paste a fan link, export, code or password into chat; report the step number and
what you saw. **P** = on your phone (iPhone and, where it says, Android too), **D** = desktop
browser, **P+D** = either. The expected result follows the arrow. Tick each step PASS / FAIL /
NOT RUN with the date. Stage 2 items 11b (templates) and 11c (SMTP) must be done on TEST first,
or every e-mail step fails for the wrong reason.

- [ ] 25. Work through the 85 steps below; record the Preview commit you tested.
- [ ] 26. Tell me which creators to keep for live. Only their setup (look, games, prizes, campaigns, templates) moves — not fans, plays, balances, reward codes or photos (`docs/GO_LIVE.md` §6). Each one first needs an approved live account.

### A. Before you start (D, 5 min)
1. D · Open `/api/health` → `{"ok":true}`.
2. D · Open `/` → badge says PREVIEW · TEST database and shows the commit (the SHA I named, or later).
3. D · Have ready: your approved TEST creator, a second TEST creator, a TEST admin with two-factor, your phone(s), a request-bin URL (e.g. webhook.site), two harmless SFW photos, dummy reward codes from the engineer.

### B. Creator onboarding (D unless noted)
4. D · In a private window, `/login` → **Request access** → sign up with a fresh TEST e-mail and a display name → confirmation e-mail arrives; open it in a *different* browser than the one you signed up in → it still signs you in (batch-6 item 7; needs 11b).
5. D · You land on `/pending` → fill name, platform, links, audience size → Submit → "Waiting for review"; reload → the form shows what you typed (no blank form).
6. D · As admin (two-factor code asked once) → Admin › Requests shows the request with the account e-mail and a bell item "New access request" → **Reject** asks for a reason → reject, then **Approve** (undo) → the applicant's bell shows "You're approved" and, if mail is set up, an e-mail (batch-6 item 14).
7. D · Sign in as the new creator → Today with "Your first steps" (6 steps); the sample wheel is already live.
8. D · Settings › Profile: change display name → sidebar updates immediately; set the public link slug; Change e-mail asks your current password; with Secure email change ON (11e) both inboxes get a link and the page says "step 1 of 2" after the first.
9. D · Settings › Two-factor: enrol with your authenticator (scan or paste the key) → sign out, sign in → the code is required for Admin and for e-mail/password changes; a creator without a factor keeps the optional flow.

### C. Games (D, then P for the fan side)
10. D · Games: save a wheel with 20+ prizes, reload → all there; set one prize's stock to 0 → its odds show 0 %.
11. D · Manage ⋯ → Duplicate, Archive (Restore), Delete… → each asks/behaves as labelled; "Live for fans now" names the live game with a reason.
12. D · Schedule a second game "Active from" a minute ago → the "Replace … for fans?" box; "Don't schedule" changes nothing; "Yes" switches "Live for fans now"; **Always on** reverts (CHECKLIST §19.3–7).
13. D · Prize & game library: save a prize to the library, add it to another game; save the game as a template, apply it to a new game; delete both.
14. D · New game → Scratch ticket and Bingo appear only if the admin enabled them for this creator (Admin › feature flags); otherwise note what you see.
15. D · Open the same game in two tabs, save in both → the second save is refused with Reload (batch-6 item 12).
16. D · Delivery: set one prize to **Code list** with the dummy codes → stock follows the number of codes; set one to **Instant link** (dummy URL) and one to **Instant text**.

### D. Fans, links, import, templates (D + P)
17. D · Fans › Mint a fan link (handle, 4 spins, $/spin, no campaign) → a card with Copy / Share / QR appears and the new row is highlighted (batch-6 item 8). Leave the handle empty → refused, nothing is created.
18. P · Scan the QR with the phone camera → the fan link opens.
19. D · Fan drawer: Top up spins (preview matches what saves), edit a past grant, add tags (VIP / custom) and a note (saves on click-away), Copy DM (paste it: tokens filled), Message → opens that fan's thread.
20. D · Links in the drawer: Change game → "chosen for this fan only"; archive that game → amber line, link still works; set back to follow campaign (CHECKLIST §19.12–16).
21. D · Import fans: paste three rows (name, spins, amount) → "Create 3 fans" → rows appear with balances; the import never tops up an existing fan.
22. D · Manage messages: add a DM template with `{name} {lastWin} {days} {creator} {link}` → Copy DM on a fan fills every token.
23. D · Block a fan → their link says chat and wishlists are off; Unblock restores. Delete a disposable fan → confirm text names the pending prizes, link stops working.
24. D · Pull the network (airplane mode) and reload Fans → "Couldn't load … Retry", never "No fans yet" (batch-6 item 9). Same for Settings › Public page: no empty form with Save enabled.

### E. Fan experience (P: iPhone, repeat the spin on Android)
25. P · Open the fan link in Instagram's in-app browser → "open in your browser" hint appears; the link still works there (batch-6 item 1).
26. P · Age gate: "FanFunnel is for adults only"; Terms and Privacy links work; both boxes required; with the gate open, chat and leaderboard opt-in are refused (batch-6 item 2).
27. P · Try 200 % text size and landscape → the gate's button is reachable (scrolls), Safety & privacy opens and its Report button is reachable.
28. P · Creator note shows; Prize book lists every prize with a % and "N left"; wishlist star toggles; Message opens chat with the greeting; balance shows your spins.
29. P · SPIN → balance −1, tick sound + haptics, win reveal (rarity build-up on rare+), "You got 1 of the last N!" on limited prizes, a 6-character claim code, "Screenshot this…" (batch-6 item 3).
30. P · Share your win ↗ → the share page shows the card and an image preview; its verify link says "Hash matches"; the public verify page never shows the claim code; the creator's verify page with `?code=` confirms it (batch-6 item 3).
31. P · Close the card → "Your wins" lists the prize with "Waiting for the creator"; later (step 38) it changes to delivered with a time; a cancelled one reads cancelled.
32. P · Win the dummy **code** prize → Copy code; reopen it from "All instant rewards" and after a reload → same code, no new credit; the creator's queue shows Auto and "Viewed by fan N×" (CHECKLIST §11).
33. P · Your play: set a daily reminder (20) and a 24 h break → SPIN disables, the breather card shows; the creator's drawer shows the break; (engineer clears the break fixture).
34. P · Change a prize weight on the dashboard while the fan page is open, then play → "Odds were updated since you opened this page" with a verify link; the next play has no notice. Top the fan up from the dashboard while the page is open → the balance on the phone updates without a reload.
35. P · Pause my link: dialog says it is permanent and to copy codes first → after pausing, a read-only "Your wins" page (prize, date, status, verify link), not a 404 (batch-6 item 4).
36. P · On another disposable fan: Download my data → the file includes messages the creator sent and each win's delivery status (batch-6 item 5); Delete my data → link loses play, chat, wishlist and reward access, including after reopening.
37. P · Type `/spin/abc` a few times → plain "This link isn't active" (never a blank white page); after very many wrong links → "too many requests" (expected) (batch-6 item 6).

### F. Fulfilment, inbox, bell, push (D + P)
38. D · Fulfilment: the win from step 29 is Pending → mark In progress, add a note and a due date (set yesterday → overdue badge), Fulfil → the fan's row (step 31) shows delivered with the time; Cancel a second win (two steps) → the limited prize's stock goes back up by one; Reopen it → stock down again.
39. D · In the queue, the fan's name opens their drawer; Message opens their thread (batch-6 item 13).
40. P+D · The fan sends a chat message → Inbox unread badge; reply → fan sees it on reopen; badges clear.
41. D · Bell: shows the win, the message and a low-stock item; opening clears the count and it stays cleared after reload; each item opens the right section.
42. P · Installed dashboard (Share › Add to Home Screen, named FanFunnel, pink icon, opens /dashboard): Settings › Push to this device → allow → Send a test → generic text arrives; tap opens the right place; with the app closed, a new win arrives once; "Show names and prizes" ON changes the text; Push OFF → no further test arrives (CHECKLIST §10). Repeat on Android.
43. D · Inbox › Auto-messages: set greeting and out-of-spins texts → a fresh fan sees the greeting; a fan at 0 spins sees the out-of-spins message.

### G. Campaigns, packs, boosts (D)
44. D · Create a campaign with a game; mint two links in it → both play that game; Change game → both switch; Archive → "Archived", links keep working; Reactivate; Delete.
45. D · Campaign spin packs: save a Focus preset (price, ×, duration) → in a fan drawer Choose a Focus pack → confirm → the fan page shows "Focus on …" and the prize book's boosted odds; play once → one credit and one focused spin used; Cancel pack releases it (CHECKLIST §13). Chase stays disabled unless the engineer enabled this creator.
46. D · Boosts › Happy hour (×2, next 30 min) → fan page shows the banner and "boosted"; delete asks for confirmation.
47. D · Boosts › Public leaderboard ON → fan opts in with a board name → `/leaderboard/<id>` lists them by spins/rare wins, never spend; opt-out removes them.
48. D · Boosts › Webhooks: add a request-bin URL for "Wins to fulfil" → a manual win delivers with `X-FanFunnel-Signature` (verify with the shown secret); an auto-delivered win does not; a 6th hook and `http://localhost/` are refused; Rotate secret changes it.
49. D · Boosts › Link-in-bio: Copy, Preview page → `/c/<slug>` shows name, tagline, avatar, tip link, "See the odds" with prize names; view source has no `/spin/` link.

### H. Analytics and win-back (D)
50. D · Analytics: Spins and Revenue trends (14 d / 30 d), funnel, What's landing, Rarity mix, Profit & prize costs, LTV, Whales, Cohorts, Heatmap all render with your TEST data (no "couldn't load").
51. D · Win-back (fans quiet 14+ days, engineer backdates): list highest spend first; blocked and paused fans absent; Copy DM fills tokens and marks Contacted; Start win-back queue: Copy & next, Skip, Snooze 30 d, tally; a contacted fan who plays shows "Came back ✓"; Today's "fans have gone quiet" card opens the queue (CHECKLIST §7).
52. D · Today › Needs you now: cards appear from real data; Dismiss and Snooze 3 days work.

### I. Look & feel, photos, icon (D + P)
53. D · Settings › Look & feel: pick a headline font and background → preview updates → Save → survives reload.
54. D · Photo hub: upload two SFW photos with captions and the SFW tick → Move earlier/later → order survives reload; Background photo → text stays readable; Edit caption → Save description; Remove photo (confirm) → background returns to Glow when its photo is removed.
55. P · Open a fan link → theme matches the creator; the game keeps its own brand colour; larger text and reduced motion stay usable with no sideways scroll.
56. D · Admin › Remove photos on the disposable creator → confirmation names the creator → gallery disappears, other creators untouched.
57. P · Home-screen icon: Neutral → install a fan link (iPhone: Share › Add to Home Screen; Android: Install) → named **Spins** with the wheel icon, opens full screen straight to the fan's game, no install card inside; a second fan link installs as a separate app. Then choose My avatar, mint a new link, install → your name and photo (CHECKLIST §6).
58. P · Pause the installed link → reopening the app shows the branded "This link isn't active" page, no error.

### J. Scratch and Bingo (feature-gated TEST creators; P for play)
59. D · Scratch: create a scratch game with disposable prizes → P: each ticket costs one credit; scratch → exactly one matching triple; Reveal all on another ticket → same committed result; reload after a result → it is recovered, not re-charged; verify page shows the replayed ticket (CHECKLIST §14).
60. D · Bingo: Create bingo draft → cannot be used as a paid game until nine eligible prizes, a fallback and a line prize are set; save → P: "Your personal bingo card"; play once → one credit, the ordinary prize wins; complete the line fixture → "Line complete!" bonus with no extra credit; Verify this line bonus; View bonus reward returns the same reward; a second fan has its own card (CHECKLIST §15).
61. D · `/c/<slug>` and a share link from a scratch/bingo fan talk about tickets / bingo, not spins.

### K. Safety, reports, privacy, account (D + P)
62. P · Safety & privacy › Report this creator › "Involves someone under 18" → within a minute the Admin nav shows a count and `ALERT_EMAIL_TO` gets an e-mail naming only the reason and time.
63. D · Admin › Reports: the report is Urgent, names creator, fan and a short link hint; Resolve with a note → moves to Resolved; Activity logs it; a non-admin GET `/api/admin/reports` answers 401/403.
64. D · Admin › Look up a win with a verify link → the win's details, never a fan token; Activity filter and "Load older" work; System health shows config flags (Alert e-mails ON/OFF and the rest), the maintenance line and the commit (batch-6 items 14–15).
65. D · Settings › Download my data (creator) → JSON belongs only to this creator.
66. D · Settings › Clear all data → shows what fans are still owed before the RESET prompt; RESET → a true fresh start, only your data (batch-6 item 10).
67. D · Settings › Close my account on a creator that still has a pending prize → refused with a link to Fulfilment; on a creator with nothing owed → phrase + password + code → old fan links stop working, other creators unaffected (batch-6 item 10).
68. D · Type in Public page text, switch section, come back → text still there; a password form asks before you leave (batch-6 item 11).
69. D · Admin: Suspend a creator → its fan links and `/c/` page are gone (404), reactivate; the suspended creator's own sign-in shows a notice with the support address, not a blank form; role flag; New account → the invite e-mail lands and `/set-password` works; Delete an account (type its e-mail); Reset two-factor on a disposable creator with the second admin (CHECKLIST §16.10).
70. D · Signed in as the second creator → none of the first creator's fans, wins, messages, campaigns or photos appear anywhere.

### L. Agency (four TEST accounts, D)
71. D · Creator with no agency → no Agency item; `/agency` → Create agency → Agency appears under Account.
72. D · Invite creator by e-mail → the creator sees the banner (naming who invites and what they will see), Accept → Open Agency explains the agency (no "Start your agency" form).
73. D · Staff seats: add a chatter (ticked for one creator) and a manager; pending chatter's `/pending` says the seat starts after approval; approve → bell + e-mail; Chatter › Your seat → only that creator, only Inbox; a reply lands in the creator's Inbox; suspend the chatter → seat shows nothing.
74. D · Manager › Campaigns › Working for → create / rename / change game / archive / reactivate / delete a campaign for the creator; no Spin packs or Edit game in seat mode; remove the seat → the creator vanishes from the picker and the request answers 403.
75. D · Expired invitation (engineer fixture) cannot be accepted; a reissued one has a new 7-day deadline.

### M. Resilience and operations (D; engineer prepares fixtures)
76. P · Interrupted play → "Check this spin" returns the committed result without a second debit; "Retry this same spin" reconciles, never a new play (CHECKLIST §16.1–2).
77. D · Interrupted grant/import → "Check outcome" → "No duplicate grant was added"; Cancel uncompleted request → confirm → no replacement until confirmed.
78. D · Admin › System health › Refresh status (not "Demo only") → Run checks now → reward-key canary and inventory/reservation checks report real outcomes; the maintenance line shows a real later timestamp the next day; a redacted TEST alert e-mail arrives in the intended inbox.
79. D · Preview badge shows the commit; `/api/health` stays `{"ok":true}` during the whole session (batch-6 item 16).

### N. Phone layout sweep (P, both platforms)
80. P · Bottom tab bar Today / Inbox / Games / Fans / More switches sections; More sheet has the rest and Sign out (asks when a game has unsaved edits).
81. P · Fan details sheet closes by drag, Close and back gesture; toasts, the Save bar and the bell sit above the tab bar.
82. P · Status bar and home indicator clear; no sideways scroll on any section or fan page; no zoom on input focus.
83. P · Fan page sound + haptics on spin and win; Mute silences.

### O. Load (engineer, local)
84. `npm run stress` passes on the release commit (no FAIL lines).

### P. Sign-off
85. Record PASS / FAIL / NOT RUN per step with the date, device and Preview commit. Any FAIL goes to the engineer with the step number and a redacted screenshot (no fan link, code or e-mail). Only when every step you ran is PASS and you have told me which creators move to live (item 26) do we start Stage 8.

Batch-6 Preview re-test list → steps: 1→25, 2→26, 3→29–30, 4→35, 5→36, 6→37, 7→4, 8→17, 9→24, 10→66–67, 11→68, 12→15, 13→39, 14→6 and 64, 15→64 and 79, 16→1 and 79. Batch-7 additions already folded in: empty handle refused (17), Public page never shows an empty form after a failed load (24), balance updates without reload (34), no blank page on a dead link (37), suspended sign-in notice (69), invite banner names the inviter (72).

## Stage 8 — Go-live day (together)

- [ ] 27. You (with me on the call): run `scripts/golive/carry-over.mjs` as a dry run, review it together, then run it with `--apply` and type the confirmation line yourself. I never hold the live database password.
- [ ] 27a. You: the merge-day checklist in `docs/GO_LIVE.md` §5 (today's LIVE backup listed, the read-only `supabase migration list` of LIVE shows 0001–0038, the multi-agency SQL returns no rows, Production keys complete, the Deployment Check proven on a code-only merge).
- [ ] 28. **You** merge the pull request into `main` (the GitHub "Merge" button, on your decision; I prepare it and never merge). The merge starts the `db-migrations-production` job, which waits for **your approval** in the `production` environment, verifies the backup, applies 0039–0072 to live and reads the history back. Nobody applies live database changes by hand; this is the one story (`docs/GO_LIVE.md` §5 and §8 say the same).
- [ ] 28a. Within the hour after Vercel promotes the new site: Admin › System health → **Run checks now** → initialize the reward canary; schema "as this release expects".
- [ ] 29. You + me: the **LIVE smoke** = `docs/GO_LIVE.md` §9 (no TEST badge, sign in, one controlled fan link and play, a reset e-mail, the support test mail, the monitors). MANUAL-CHECKLIST §4 is the TEST smoke and stays on the Preview.
- [ ] 30. Me: turn the Vercel Preview login back ON. You: confirm you can still reach the Preview while logged in.
- [ ] 31. Uptime alert (free): https://uptimerobot.com → New monitor → `https://<your domain>/api/health` (not the home page, which is cached) → alert to your email. Plus the nightly heartbeat (`HEARTBEAT_URL`): `docs/handoff/GO_LIVE_KEYS.md` step 6b (accounts: item 19d). From then on: `docs/OWNER_CHECKLIST.md` every morning.

## Stage 9 — Open operational checks and questions

Answer or do each of these before real fans arrive (ops audit, batch 6). Incident steps: `docs/RUNBOOK.md`.

- [ ] 32. **Supabase plan for LIVE:** which plan is it on? Is a daily backup listed under Database → Backups? Do you want Point-in-Time Recovery (PITR)? (Free has no self-serve restore and auto-pauses; see step 16.)
- [ ] 33. **Upstash plan for Production:** which plan, and what monthly command allowance? (Estimate: one 30-minute event with 200 fans uses roughly 60–90k commands.) When it runs out, rate limits quietly become per-instance; System health shows the last fallback.
- [ ] 34. **Resend plan and limits:** which plan, what daily/monthly send limit? One account carries alerts, creator account mail and Supabase Auth e-mail (password resets).
- [ ] 35. **Support mailbox:** `easysimplesites.org` has no MX record, so mail to `support@easysimplesites.org` bounces. Which mailbox should it reach (forwarding or Workspace, step 18), and who watches it during events? Then send it a test e-mail (`docs/GO_LIVE.md` §9).
- [ ] 36. **Second admin:** who is it? Enrol them with their own two-factor before go-live, so one lost phone cannot lock everyone out (`docs/RUNBOOK.md`, "Creator locked out").
- [ ] 37. **Vercel team members:** is the team just you? Fan links (`/spin/<token>`) appear in Vercel's request logs, so keep the team to people who may see them, and filter `/spin/*` before adding any log drain.
- [ ] 38. **Ask the lawyer:** is a privacy contact that bounces acceptable for a soft launch (item 35)? Is deleting declined creator requests by hand every 90 days acceptable until it is automated (`docs/DATA_RETENTION.md`)?

Batch-7 open items (audits of 2026-11-10; each is a question or a click only you can do):

- [ ] 39. **Which Supabase plan is LIVE on, and is a daily backup listed?** The production migration job now refuses to run without a backup from the last 36 hours; on a plan without backups you either upgrade (item 16) or set the GitHub variable `PROD_BACKUP_POLICY` = `accept-no-backup` knowingly (`docs/GO_LIVE.md` §5). Do you want PITR, so a restore can go to a new project instead of in place with downtime?
- [ ] 40. **LIVE migration history:** has `docs/auto-migration-reconcile.sql` ever been run on LIVE? Before merge day we run a read-only `supabase migration list` against LIVE together; the result goes into the release note and the top of `.github/workflows/supabase-migrations.yml`.
- [ ] 41. **Vercel:** Deployment Check configured and proven (14b)? Fluid compute on (19b)? Toolbar on Previews: turn it off (Settings → General → Vercel Toolbar) or accept the "CSP blocked vercel.live" rows in Admin › Errors during testing.
- [ ] 42. **GitHub:** the three environments (13), the five security switches (12), the rulesets with all five required checks (14), PR #42 closed (14d). Should the repository stay public, and under which licence line (`LICENSE` or an "All rights reserved" note; the audit notes and your e-mail in it are world-readable)?
- [ ] 43. **Supabase Auth decisions:** Secure email change ON or OFF (11e), OTP expiry 24 h or 1 h (11d), custom SMTP done in both projects (11c)?
- [ ] 44. **Upstash:** second store for Preview (19c) and the live store's plan and monthly command allowance; do you want a quota alert?
- [ ] 45. **Monitors:** UptimeRobot and Healthchecks.io accounts created, under which e-mail (19d)?
- [ ] 46. **Who merges on release day:** you, with the GitHub button, after my "ready" (item 28). Confirm.
- [ ] 47. **Lawyer:** after a database restore, fans' wins since the backup point disappear and spent spins come back; is a notice to affected fans required, and what should it say? (`docs/RUNBOOK.md` § Restore from backup; `docs/LAWYER_QUESTIONS.md`.)
- [ ] 48. **Migration numbers:** once more than one person ships schema changes, who assigns the next number? (Today: the DB builder's brief per batch; `docs/RUNBOOK.md` § When a PR's TEST migration run is stuck.)

## Note — agency staff seats (how onboarding works)

- A staff member (manager, chatter, fulfiller, analyst) needs their **own approved creator
  account** before their seat does anything. They sign up at `/signup`, request access on
  `/pending` (which says so), and an admin approves them in Admin. Approval sends the
  "you're approved" notice and e-mail.
- The agency owner then adds them on **Agency › Staff seats** by the email on that account;
  they get an invite to accept. While their account is waiting for approval, or is
  suspended, the seat does nothing — this is deliberate and stays that way.
- Managers act for every creator in the agency (inbox, fulfilment, campaigns); chatters,
  fulfillers and analysts only for the creators ticked under their seat.
- Everyone with an agency tie (owner, staff, or a creator who accepted an invite) finds it
  under **Agency** in the dashboard's Account menu. Walkthrough: `e2e/MANUAL-CHECKLIST.md` §20.
