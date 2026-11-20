# FanFunnel: every step to go live (the simple version)

One box at a time, top to bottom. Each step is one click or one thing to type.

- 👤 = you do it. 🤖 = I do it (just tell me the words in quotes). 🤝 = together.
- **Never paste a password, key or code into the chat.** Keys go only into the website the step names, and into
  your password manager. If a step asks you to "copy" something, paste it where the very next step says.
- Stuck? Send me a screenshot and the part number + step number (e.g. "Part 3, step 3.7").
- The detailed version of every step (for me or a helper) is `docs/handoff/OWNER_STEPS.md`; this file is the
  same list made simple.

---

## ✅ Already done

**Progress (2026-11-20):** Part 2 done except 2.9; Parts 3 and 4 done except 3.18 and 4.4 (wait for Supabase Pro) and 4.6 (go-live day).
**Pick up at Part 5.**


- ✅ Domain `fanfunnel.app` bought (auto-renews), connected, padlock on, `www` goes to it.
- ✅ Every `@fanfunnel.app` address forwards to **fanfunnelsupport@gmail.com** (ImprovMX).
- ✅ The support Gmail sends as **FanFunnel Support &lt;support@fanfunnel.app&gt;** (Resend, all checks PASS).
- ✅ Live site settings: site address, admin e-mails, "always use the real database", e-mail sender.
- ✅ Vercel Pro.
- ✅ The new version passes every automatic check and runs on the Preview (test copy).

---

## Part 1: Supabase Pro (5 minutes, ~$25–35/month)

**Owner's choice (2026-11-19): do this LAST, but at least 2 days before go-live day** (the first daily backup
appears about a day after upgrading, and the release needs one). Steps 3.18 and 4.4 wait for it. Until then the
free TEST database may fall asleep after a quiet week: if the Preview stops working, open
https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu and click **Restore project**.

**Why you need it:** the release button refuses to update the live database unless Supabase made a backup in
the last 36 hours. Only Pro makes daily backups. Pro also stops the database from falling asleep (like the test
one did today) and turns on the "leaked password" blocker.

- [ ] 1.1 👤 Open https://supabase.com/dashboard/org/gmsididujlbybxtzhgxl/billing
- [ ] 1.2 👤 Click **Change subscription plan** (or **Upgrade**).
- [ ] 1.3 👤 Pick **Pro** → enter your card → confirm.
- [ ] 1.4 👤 Tell me "Supabase Pro done". Tomorrow, open
      https://supabase.com/dashboard/project/ttlogfmogcccwiraaoae/database/backups/scheduled and check that one
      backup is listed. Tell me yes or no.

Optional, not needed now: **Point-in-Time Recovery** (undo to any minute, about $100/month). Skip it at launch.

---

## Part 2: Lock your accounts (30 minutes)

For each account: turn on two-step login with an **authenticator app** (Google Authenticator, Authy or your
password manager), not text messages. When it shows **recovery codes**, save them in your password manager
in a note named after the account.

- [x] 2.1 👤 Personal Gmail: https://myaccount.google.com/signinoptions/twosv → **Get started** → follow it.
- [x] 2.2 👤 Support Gmail (log in as fanfunnelsupport@gmail.com first): same link, same steps.
- [x] 2.3 👤 GitHub: https://github.com/settings/security → **Enable two-factor authentication**.
- [x] 2.4 👤 Vercel: https://vercel.com/account/settings/authentication → **Two-Factor Authentication** → Enable.
- [x] 2.5 👤 Supabase: https://supabase.com/dashboard/account/security → **Add new app** (under Multi-Factor).
- [x] 2.6 👤 Resend: https://resend.com/settings → **Security** → turn on two-factor.
- [x] 2.7 👤 Upstash: https://console.upstash.com → your avatar → **Account** → **Security**. (If you log in
      with GitHub, step 2.3 already covers it; skip.)
- [x] 2.8 👤 ImprovMX: https://app.improvmx.com → **Account** → **Security** → two-factor.
- [ ] 2.9 (only their Gmail matters: they use no other account) 👤 Ask ashandlynx to do the same for every account they can log in to.

---

## Part 3: Supabase settings on the TEST database (20 minutes)

Do these on TEST first, because the Preview tests in Part 8 need them.
TEST project = **fanfunnel test** (`snmcrmhgevfqggxdiomu`). Supabase sometimes renames buttons; if a name
does not match exactly, pick the closest one and send me a screenshot if unsure.

**3A. Make a Resend key for TEST e-mail**
- [x] 3.1 👤 Open https://resend.com/api-keys → **Create API key**.
- [x] 3.2 👤 Name: `fanfunnel-supabase-test`. Permission: **Sending access**. Domain: **fanfunnel.app**. → **Add**.
- [x] 3.3 👤 Click the copy button. Keep this tab open (you paste it in step 3.8).

**3B. E-mail sending (SMTP)**
- [x] 3.4 👤 Open https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu/auth/smtp
- [x] 3.5 👤 Turn on **Enable Custom SMTP**.
- [x] 3.6 👤 Sender email: `account@fanfunnel.app`. Sender name: `FanFunnel`.
- [x] 3.7 👤 Host: `smtp.resend.com`. Port: `465`. Username: `resend`.
- [x] 3.8 👤 Password: paste the key from step 3.3. → **Save**.

**3C. Sign-in rules** (open https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu/auth/providers →
click **Email**)
- [x] 3.9 👤 **Confirm email**: ON.
- [x] 3.10 👤 **Secure email change**: ON.
- [x] 3.11 👤 **Minimum password length**: `8`.
- [x] 3.12 👤 **Email OTP Expiration**: `86400`. → **Save**.

**3D. Address settings** (open https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu/auth/url-configuration)
- [x] 3.13 👤 **Site URL**: `https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app` → **Save**.
- [x] 3.14 👤 Under **Redirect URLs**, the list must contain exactly these two (add what is missing with **Add URL**):
      `https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/**` and `http://localhost:3000/**`.
- [x] 3.15 👤 Delete every other entry that has a `*` before `.vercel.app` (trash icon next to it).

**3E. The e-mail templates** (7 of them; each is copy, then paste)
- [x] 3.16 👤 Open https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu/auth/templates
- [x] 3.17 👤 For each row below: open the GitHub link, click the **Copy raw file** button (two overlapping
      squares, top right of the file), go back to Supabase, click the template name, select everything in the
      **Body** box (Ctrl+A / ⌘+A), paste (Ctrl+V / ⌘+V), click **Save**.

| Supabase template | GitHub file to copy |
|---|---|
| Confirm signup | https://github.com/Guhlores-Team/fanfunnel/blob/dashboard-redesign/supabase/templates/confirmation.html |
| Invite user | https://github.com/Guhlores-Team/fanfunnel/blob/dashboard-redesign/supabase/templates/invite.html |
| Magic link | https://github.com/Guhlores-Team/fanfunnel/blob/dashboard-redesign/supabase/templates/magic_link.html |
| Change email address | https://github.com/Guhlores-Team/fanfunnel/blob/dashboard-redesign/supabase/templates/email_change.html |
| Reset password | https://github.com/Guhlores-Team/fanfunnel/blob/dashboard-redesign/supabase/templates/recovery.html |
| Password changed (turn it **ON** first) | https://github.com/Guhlores-Team/fanfunnel/blob/dashboard-redesign/supabase/templates/password_changed.html |
| Email address changed (turn it **ON** first) | https://github.com/Guhlores-Team/fanfunnel/blob/dashboard-redesign/supabase/templates/email_address_changed.html |

**3F. Leaked-password blocker** (works after Part 1)
- [ ] 3.18 👤 Open https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu/auth/protection → turn on
      **Prevent use of leaked passwords** → **Save**.
- [ ] 3.19 👤 Tell me "TEST Supabase done".

---

## Part 4: The same on the LIVE database (15 minutes)

LIVE project = `ttlogfmogcccwiraaoae`. Same clicks as Part 3, with these differences only.

- [x] 4.1 👤 New Resend key exactly like 3.1–3.3, but named `fanfunnel-supabase-live`.
- [x] 4.2 👤 SMTP like 3.4–3.8 at https://supabase.com/dashboard/project/ttlogfmogcccwiraaoae/auth/smtp
      (paste the **live** key from 4.1).
- [x] 4.3 👤 Sign-in rules like 3.9–3.12 at https://supabase.com/dashboard/project/ttlogfmogcccwiraaoae/auth/providers
- [ ] 4.4 👤 Leaked passwords like 3.18 at https://supabase.com/dashboard/project/ttlogfmogcccwiraaoae/auth/protection
- [x] 4.5 👤 Addresses at https://supabase.com/dashboard/project/ttlogfmogcccwiraaoae/auth/url-configuration :
      **Site URL** `https://fanfunnel.app`. **Redirect URLs**: add `https://fanfunnel.app/**`, keep
      `https://fanfunnel.vercel.app/**`, delete anything with a `*` before `.vercel.app`.
- [ ] 4.6 **Do NOT paste the templates on LIVE yet.** We do that together on go-live day (Part 11), because
      the old live version does not have the pages the new templates link to.

---

## Part 5: GitHub settings (30 minutes)

**5A. Security switches**
- [x] 5.1 👤 Open https://github.com/Guhlores-Team/fanfunnel/settings/security_analysis
- [x] 5.2 👤 Turn on: **Private vulnerability reporting**, **Dependabot alerts**, **Dependabot security updates**,
      **Malware alerts** (skip it if it asks for payment). Secret scanning and Push protection are paid extras on a
      private repository ("Secret Protection"): **skip them, buy nothing.**

**5B. Gather the values you will need** (put each one in your password manager note "FanFunnel GitHub")
- [x] 5.3 👤 **New Supabase access token:** https://supabase.com/dashboard/account/tokens → **Generate new token**
      → name `github-ci-live`, **Project** access to only `fanfunnel` (LIVE), preset **Full access**, expires Never
      → copy it into the note. **Don't revoke the older token yet:** the automatic tests still
      use it until step 5.7 is done. You revoke it in step 5.12.
- [x] 5.4 👤 **TEST database password:** if you don't have it saved, open
      https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu/settings/database → **Reset database password**
      → **Generate a password** → copy it → **Reset password**. (Resetting TEST is safe.)
- [x] 5.5 👤 **TEST connection string:** open https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu?showConnect=true
      → **Session pooler** → copy the line that starts with `postgresql://` → in your note, replace
      `[YOUR-PASSWORD]` (brackets too) with the password from 5.4.
- [x] 5.6 👤 **LIVE database password:** reset at https://supabase.com/dashboard/project/ttlogfmogcccwiraaoae/database/settings
      and saved (the site never uses it; only the GitHub `production` job does).

**5C. Environments** (open https://github.com/Guhlores-Team/fanfunnel/settings/environments)
- [x] 5.7 👤 Click **test** (or **New environment** → name `test` → **Configure**). Under **Environment secrets**
      click **Add environment secret** four times:

| Name | Value |
|---|---|
| `SUPABASE_TEST_DB_URL` | the connection string from 5.5 |
| `SUPABASE_TEST_PROJECT_REF` | `snmcrmhgevfqggxdiomu` |
| `SUPABASE_TEST_DB_PASSWORD` | the password from 5.4 |
| `SUPABASE_TEST_ACCESS_TOKEN` | a new Supabase token `github-ci-test`: **Project** access to only `fanfunnel test`, preset **Full access**, expires Never |

- [x] 5.8 👤 Back to Environments → **production** (or **New environment** → `production`).
- [x] 5.9 👤 Tick **Required reviewers** → add yourself → **Save protection rules**. Leave "Prevent self-review" OFF.
- [x] 5.10 👤 **Deployment branches and tags** → **Selected branches and tags** → **Add deployment branch or tag
      rule** → type `main` → **Add rule**.
- [x] 5.11 👤 Add three environment secrets:

| Name | Value |
|---|---|
| `SUPABASE_PROD_PROJECT_REF` | `ttlogfmogcccwiraaoae` |
| `SUPABASE_PROD_DB_PASSWORD` | the live password (5.6) |
| `SUPABASE_ACCESS_TOKEN` | the token from 5.3 |

- [x] 5.12 👤 Open https://github.com/Guhlores-Team/fanfunnel/settings/secrets/actions . Under **Repository
      secrets**, delete (trash icon) only these if they are there: `SUPABASE_PROD_DB_PASSWORD`,
      `SUPABASE_PROD_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`, `VERCEL_TOKEN`, `FANFUNNEL_TEST_CRON_SECRET`.
      **Keep** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and
      anything starting with `SUPABASE_TEST_`. Then, at https://supabase.com/dashboard/account/tokens , click
      **Delete** every token except `github-ci-live`.

**5D. Dependabot needs the TEST trio too**
- [x] 5.13 👤 Open https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu/settings/api-keys and keep it open.
- [x] 5.14 👤 Open https://github.com/Guhlores-Team/fanfunnel/settings/secrets/dependabot → **New repository secret**
      three times, with the **TEST** values (never live ones):

| Name | Value (from the TEST Supabase page) |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://snmcrmhgevfqggxdiomu.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the **anon / public** key |
| `SUPABASE_SERVICE_ROLE_KEY` | the **service_role / secret** key (click Reveal, copy) |

**5E. Branch protection**
- [x] 5.15 👤 Open https://github.com/Guhlores-Team/fanfunnel/settings/rules → **New ruleset** → **New branch ruleset**.
- [x] 5.16 👤 Name `main`. Enforcement **Active**. **Add target** → **Include by pattern** → `main`.
- [x] 5.17 👤 Tick **Restrict deletions**, **Require a pull request before merging**, **Block force pushes**.
- [x] 5.18 👤 Tick **Require status checks to pass** → **Add checks** → add `verify`, `schema-drift`, `supabase`,
      `login-ui`, `test` → **Create**.
- [x] 5.19 👤 New ruleset again: name `dashboard-redesign`, target `dashboard-redesign`, tick only
      **Restrict deletions** and **Block force pushes** → **Create**.

**5F. Actions permissions** (open https://github.com/Guhlores-Team/fanfunnel/settings/actions)
- [x] 5.20 👤 Tick **Require actions to be pinned to a full-length commit SHA**.
- [x] 5.21 👤 **Fork pull request workflows**: **Require approval for all external contributors**.
- [x] 5.22 👤 **Workflow permissions**: **Read repository contents and packages permissions**. Untick
      **Allow GitHub Actions to create and approve pull requests**. → **Save**.
- [ ] 5.23 🤖 Old pull request #42 is unsafe to keep around. Say **"close PR 42"** and I close it and delete its branch.
- [ ] 5.24 👤 Tell me "GitHub done". I check that the automatic checks still pass with the new settings.

---

## Part 6: Vercel settings

- [x] 6.1 🤖 Say **"do the Vercel settings"**. I check and fix: Node.js version 22, Fluid compute on, Git fork
      protection on, the Vercel Toolbar off on Previews. I report back what I changed.
- [x] 6.2 Skipped (2026-11-20): a second Upstash store is paid-only on this account, and rate-limit keys are
      already split by environment (`rl:preview:` / `rl:production:`, `src/lib/rateLimit.ts`). Original steps, for later:
  - Open https://vercel.com/easy-simple-sites/~/stores → **Create Database** → **Upstash** (Redis) → **Continue**.
  - Name `fanfunnel-preview`, free plan → **Create**.
  - **Connect Project** → `fanfunnel` → tick **Preview** only (untick Production and Development) → **Connect**.
  - Open https://vercel.com/easy-simple-sites/fanfunnel/settings/environment-variables . For each of
    `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_URL`, `REDIS_URL`, `KV_REST_API_READ_ONLY_TOKEN` that shows
    **Production and Preview** and belongs to the OLD store: **⋯** → **Edit** → untick **Preview** → **Save**.
  - If anything looks confusing (two of the same name), stop and send me a screenshot.

---

## Part 7: The live keys in Vercel (45 minutes)

Where every key goes: https://vercel.com/easy-simple-sites/fanfunnel/settings/environment-variables
For each key: **Add New** (or **Add Environment Variable**) → **Key** = the name → **Value** = the value →
Environments: tick **Production** only → if the table says *Sensitive: yes*, switch **Sensitive** on → **Save**.

**7A. Open the Terminal** (it makes random secret keys on your own computer)
- [ ] 7.1 👤 Mac: press ⌘ + Space, type `Terminal`, press Enter. Windows: Start, type `PowerShell`, Enter.
- [ ] 7.2 👤 Create a password-manager note **"FanFunnel LIVE keys"**. Everything below goes there first, then Vercel.

**7B. The two reward keys (MOST IMPORTANT: back them up; if lost, unclaimed reward codes are gone forever)**
- [ ] 7.3 👤 Paste this into the Terminal and press Enter:
      Mac: `openssl rand -base64 32`
      Windows: `$b=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)`
- [ ] 7.4 👤 It prints one line ending in `=`. Copy it into your note as **REWARD_ENCRYPTION_KEY**.
- [ ] 7.5 👤 Press the up-arrow key, then Enter (same command again). Copy the new, different line into the note as
      **REWARD_CODE_FINGERPRINT_KEY**.
- [ ] 7.6 👤 Add both in Vercel (Production, **Sensitive ON**).

**7C. The nightly-job secret**
- [ ] 7.7 👤 Terminal: Mac `openssl rand -hex 32` · Windows
      `$b=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b|%{$_.ToString('x2')})`
- [ ] 7.8 👤 Save it in the note as **CRON_SECRET**, then add it in Vercel (Production, **Sensitive ON**).

**7D. Phone notification keys**
- [ ] 7.9 👤 Terminal: `npx web-push generate-vapid-keys` → if it asks "Ok to proceed?", type `y` and Enter.
      If it says `command not found`: install Node from https://nodejs.org (big green **LTS** button, open the
      download, click through), close and reopen the Terminal, try again.
- [ ] 7.10 👤 It prints a **Public Key** and a **Private Key**. Save both in the note. Add in Vercel:

| Name | Value | Sensitive |
|---|---|---|
| `VAPID_PUBLIC_KEY` | the Public Key | no |
| `VAPID_PRIVATE_KEY` | the Private Key | **yes** |
| `VAPID_SUBJECT` | `mailto:support@fanfunnel.app` | no |

**7E. E-mail key and where alerts go**
- [ ] 7.11 👤 https://resend.com/api-keys → **Create API key** → name `fanfunnel-live` → **Sending access** →
      domain **fanfunnel.app** → **Add** → copy.
- [ ] 7.12 👤 Add in Vercel:

| Name | Value | Sensitive |
|---|---|---|
| `RESEND_API_KEY` | the key from 7.11 | **yes** |
| `ALERT_EMAIL_TO` | `fanfunnelsupport@gmail.com` | no |

**7F. "Is the site up?" alarms** (both free; sign up with fanfunnelsupport@gmail.com)
- [ ] 7.13 👤 https://uptimerobot.com → sign up → **New monitor** → type **HTTP(s)** → URL
      `https://fanfunnel.app/api/health` → interval 5 minutes (60 seconds if offered) → alert contact = your
      e-mail → **Create**.
- [ ] 7.14 👤 https://healthchecks.io → sign up → **Add Check** → name `fanfunnel-nightly` → Period **1 day**,
      Grace **6 hours** → **Save** → copy its **ping URL** (starts with `https://hc-ping.com/`).
- [ ] 7.15 👤 Add in Vercel: `HEARTBEAT_URL` = that ping URL (Production, **Sensitive ON**).
- [ ] 7.16 👤 Tell me **"keys are in"** (no values!). I check the list of names and that nothing is missing.
      (The keys only switch on at the go-live update, so nothing changes on the live site yet.)

---

## Part 8: Test everything on the Preview (2–3 hours, split it up)

- [ ] 8.1 👤 Do Parts 3 first (e-mails fail on TEST without them).
- [ ] 8.2 👤 Open `docs/handoff/OWNER_STEPS.md`, section **Stage 7**, and work through steps 1–85 on
      https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app
- [ ] 8.3 👤 For each step write PASS, FAIL or NOT RUN. For a FAIL, send me the step number and a screenshot
      (cover any fan link, code or e-mail address).
- [ ] 8.4 🤖 I fix every FAIL, then tell you which steps to repeat.
- [ ] 8.5 👤 Tell me which test creators should be copied to the live site (only their setup moves, no fans or plays).

---

## Part 9: Legal (in parallel)

- [ ] 9.1 👤 Read https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/terms and `/privacy`.
      Send me anything you want changed.
- [ ] 9.2 👤 Book a lawyer. Bring `docs/LEGAL_NOTES.md` and `docs/LAWYER_QUESTIONS.md`, plus: "someone else owns
      fanfunnel.com; is the name FanFunnel safe to use?"
- [ ] 9.3 👤 Optional: an LLC. If you form one, tell me its exact name and I update the pages.

---

## Part 10: Quick answers I need from you (reply in one message, any time)

1. Upstash: which plan is the live store on? (https://console.upstash.com → the database → **Plan**)
2. Resend: free plan (100 e-mails/day) or paid? Free is fine at launch; upgrade if you expect big events.
3. Second admin: is it ashandlynx@gmail.com? They need their own account with two-factor before go-live.
4. Vercel team: is it just you? (Fan links appear in Vercel's logs, so keep the team small.)
5. GitHub: keep the code public, or make it private?
6. Sign-in links: valid for 24 hours (recommended, set in 3.12) or 1 hour?
7. Who presses Merge on go-live day? (Should be you.)

---

## Part 11: Go-live day (🤝 together, about 1 hour, pick a quiet time)

- [ ] 11.1 🤝 Check that today's live backup is listed (Part 1.4 link).
- [ ] 11.2 🤝 Run the read-only pre-checks together (I tell you exactly what to click and paste).
- [ ] 11.3 🤝 Copy the chosen test creators' setup to live (you run one command, I guide).
- [ ] 11.4 👤 Press **Merge** on the pull request. 👤 Then **Approve** the database update GitHub asks about.
- [ ] 11.5 🤝 Paste the e-mail templates on LIVE (like 3.16–3.17, live project).
- [ ] 11.6 🤖 I make the old `fanfunnel.vercel.app` address send everyone to `fanfunnel.app`.
- [ ] 11.7 🤝 The 5-minute check: site opens with the padlock, sign in, one test fan link, a password-reset
      e-mail arrives, an e-mail to support@ arrives, monitors are green.
- [ ] 11.8 🤖 I turn the Preview login protection back on.
- [ ] 11.9 👤 From then on, the 5-minute morning routine is `docs/OWNER_CHECKLIST.md`.
