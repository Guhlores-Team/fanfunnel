# FanFunnel incident runbook (owner-facing)

What to do when something breaks on the live site. Steps marked **[dashboard]** happen in the
Supabase, Vercel, GitHub or Resend web consoles. Every command, path and button named here
exists in this repository. Never paste keys or passwords into chat.

Where things are:

- **Admin** = sign in as an admin with two-factor → `/admin` (or **Dashboard › Admin**).
- **Errors** = Admin › Errors (`/dashboard?section=admin#errors`).
- **System health** = Admin › System health. **Refresh status** re-reads it; **Run checks now** re-runs
  the key and ledger checks.
- **Health URL** = `https://<site>/api/health`. It answers `200 {"ok":true}` when the database replies
  within 2 seconds, `503 {"ok":false}` when it does not, `429` when one address polls it more than
  30 times a minute (a monitor every 60 s is fine), and `500` when a Production variable is missing
  or mistyped (the site is misconfigured: Vercel → Deployments → latest → Logs says which one,
  "FanFunnel is misconfigured"). It is never cached and never says why.
- **Daily / weekly / release routine** = `docs/OWNER_CHECKLIST.md`. This runbook is for when something
  is wrong.

## Watch it before anything breaks

1. **[dashboard]** UptimeRobot (or similar): a monitor on the health URL, not on `/`. The home page is
   served from the CDN cache and stays green while the database is down.
2. **[dashboard]** A heartbeat monitor (Healthchecks.io, or an UptimeRobot heartbeat). Put its ping URL
   (`https://…`) in the Vercel Production variable `HEARTBEAT_URL`. After each successful daily
   maintenance run, the cron pings it. When the pings stop, the monitor e-mails you. That is the one
   alert that works when our own database or e-mail is down.
3. System health lists each optional service as configured or not set, by name only. On Production,
   **Alert e-mails: OFF** is shown in red and means no error e-mail will reach you. The
   **Maintenance job: last ran …** line turns red after 30 hours without a run.

## The heartbeat monitor says "down" (nightly job did not report)

Healthchecks.io (or the UptimeRobot heartbeat) e-mails "down" when the nightly maintenance run did
not ping `HEARTBEAT_URL`. The ping is sent only after a run that answered below 500. Causes, in
order of likelihood; check System health first:

1. **Maintenance job: last ran …** is red or older than a day → the cron did not run. **[dashboard]**
   Vercel → Settings → Cron Jobs shows `/api/cron/retention` at 04:17 UTC and its last result;
   `CRON_SECRET` must be set on Production (System health lists it as configured). Vercel fires a
   daily cron anywhere inside that hour on the Hobby plan; the monitor's 6-hour grace covers it.
2. "A previous key protection failure still needs acknowledgement" on the System health card → one
   past blip of the reward-key check (even a 3-second timeout at instance start) keeps every
   nightly run at 503 until an admin presses **Run checks now** and it passes. Press it; the next
   night's ping clears the monitor. (Batch-7 OPS3-05: a healthy nightly run is meant to clear this
   itself once that change lands.)
3. A ledger line in red → do not touch balances; tell the operator the same day.
4. The site was paused (`FF_MAINTENANCE=1`): the nightly job is paused with it (see Pause the site).
   Expect a "down" e-mail for every night of a pause.
5. The reward canary was never initialized on LIVE (first days after go-live): System health says
   so; initialize it (`docs/GO_LIVE.md` section 5).
6. The ping itself failed (wrong URL, monitor outage): the cron logs "heartbeat ping failed" on
   Vercel; System health only says whether the URL is set, not whether the last ping was accepted.

## Site down (fans can't load pages)

1. Open the site in a private window.
   - If Vercel's own error page shows: **[dashboard]** Vercel → fanfunnel → Deployments. The latest
     Production deployment should be **Ready**.
   - If our "didn't load" page shows instead, the database is the likely cause. Go to **DB down**.
2. If a deploy just went out, go to **Roll back a deploy**.
3. Open the health URL. A `503` confirms the database is not answering.
4. Errors lists recent server errors. While the database is down, nothing new can be recorded or
   e-mailed. The uptime and heartbeat monitors above are what tell you.

## DB down

1. **[dashboard]** Supabase LIVE (`ttlogfmogcccwiraaoae`): check the project status (paused? over its
   limits?) and https://status.supabase.com.
2. Fans see "Your spin page didn't load… nothing was spent". Leave the site up. Retries lose no data.
3. If you need fans to see a calm page instead of retrying, use **Pause the site** below.
4. When the database is back: open the health URL (expect `200`), then System health → **Refresh
   status** → **Run checks now**. The schema line should read "as this release expects", and the ledger
   checks should pass.

## Pause the site (maintenance mode)

1. **[dashboard]** Vercel → Settings → Environment Variables → Production: add `FF_MAINTENANCE` = `1`.
2. **[dashboard]** Deployments → the current Production deployment → **Redeploy**. **The redeploy is
   mandatory**: Vercel applies an environment change only to a new deployment, and the page
   rewrites are built in at build time. Without it only API writes are paused and every page keeps
   working.
3. While paused (`src/lib/ops/maintenance.ts`, the complete list):
   - **Still open:** `/dashboard`, `/admin`, `/login`, `/mfa`, `/auth/*` (sign-in links), `/maintenance`,
     `/privacy`, `/terms`, the app icons and static files; the APIs `/api/admin/*`, `/api/health`,
     `/api/maintenance`; signed-in dashboard **reads** (polls, lists).
   - **Paused (page shows "We'll be back soon… nothing was spent"):** `/`, every fan link `/spin/*`,
     `/share/*`, `/verify/*`, `/leaderboard/*`, `/c/*`, and also `/signup`, `/pending`, `/agency`,
     `/forgot-password`, `/reset-password` and `/set-password`, so an invited creator cannot finish
     setting up during a pause.
   - **Paused (API, `503 {"error":"maintenance"}` + `Retry-After`):** every cookieless API call
     except health and maintenance, including `/api/cron/retention` (the nightly job fails and the
     heartbeat monitor reports "down" for every night of the pause), `/api/errors` (browser error
     reports) and `/api/push/*`; every signed-in API **write** (saves, grants, fulfilment).
   (Batch-7 OPS3-04 proposes exempting the cron, error reports, push and the account set-up pages;
   until that lands, plan pauses outside 04:00–05:00 UTC and expect the heartbeat e-mail.)
4. To reopen: delete `FF_MAINTENANCE` (or set it to anything but `1`) and redeploy again (mandatory
   for the same reason).

## E-mail down

1. **Symptoms:** no alert e-mails, creators say they got no approval e-mail, password resets go
   missing. Errors shows "Account e-mail was not sent: …" for each refused approval, invitation or
   new-request mail.
2. **[dashboard]** Resend: check that the domain `easysimplesites.org` is verified, and check the
   usage and quota. Also **[dashboard]** Supabase → Authentication → SMTP settings, which use the same
   Resend account.
3. Approved creators can still sign in, and the in-app bell shows the approval. Tell them directly.
4. In Vercel, `RESEND_API_KEY` and `ALERT_EMAIL_TO` must be present on Production. System health shows
   **Alert e-mails: ON/OFF**. Redeploy after any change.

## Push notifications stopped

1. Errors shows "Push delivery failed for a device that is not expired…". At most one is recorded per
   minute per server.
2. System health → **Push notifications (VAPID key pair)** must say configured. A changed or partly
   pasted key pair stops every creator's pushes. Restore the original `VAPID_PUBLIC_KEY`,
   `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`, then redeploy.
3. **Devices do not resume by themselves.** A device that failed 5 deliveries in a row is paused
   (`PUSH_MAX_FAILURES`), and a key mismatch counts as a failure. After the fix, each affected creator
   opens Settings › Notifications on that device and presses **Send a test**: a successful test resets
   the failure count for every device of that creator. Turning push off and on again (re-subscribe)
   also works. Tell creators this in the same message as "it's fixed".

## Rate limits fell back

1. Errors shows "Rate limit store unreachable…". System health shows **Rate-limit store: last fallback
   to per-instance limits <time>**.
2. **[dashboard]** Upstash: check its status and the monthly command quota. Fans keep working, but
   limits only count per server instance until the store is back. Each shared-store call waits at
   most 800 ms.

## Fan says a prize is missing

1. Ask the fan for their win's verify link (`/verify/<id>`), or a screenshot with the time.
2. Admin → **Look up a win** → paste the link → **Look up**. It shows the prize, when it was won, the
   creator, the delivery status with its times, and whether the fan has deleted their data. It never
   shows the fan's link or name. Each lookup is recorded in Activity as "looked up a win".
3. If the delivery status is `pending`, the creator still has to deliver it. Contact the creator
   (Admin › Accounts shows their e-mail).
4. Fallback if Admin is unavailable: **[dashboard]** LIVE SQL editor, read-only query:
   ```sql
   select s.created_at, s.prize_label, s.creator_id, r.status, r.fulfilled_at
   from public.spins s left join public.redemptions r on r.spin_id = s.id
   where s.share_id = '<id from the link>';
   ```
5. Never edit `redemptions`, `spins` or balances by hand. Record what you did.

## A creator's invitation or reset link expired

1. Admin "New account" invitations and reset links expire after the Supabase **Email OTP expiry**
   (default 1 hour; `docs/handoff/OWNER_STEPS.md` Stage 2 raises it). An expired link lands on `/login`
   with an explanation.
2. To re-send an invitation: Admin › Accounts → **New account** again with the same e-mail. For an
   address that has not confirmed yet this re-sends the invitation; nothing is duplicated.
3. For a reset: the creator requests a new one from `/forgot-password`. Tell them the link works on
   any device, and to open the newest e-mail.

## Creator locked out (lost authenticator)

1. Verify their identity. The request must come from the account's own e-mail address. Confirm one
   detail only they would know, such as a recent game name.
2. Admin › Accounts → the account → **Reset two-factor**. This calls `/api/admin/account/mfa-reset`
   and is recorded in Activity as `account.mfa_reset`. An admin cannot reset their own two-factor there.
3. **Break glass (you are the only admin and you are locked out):** **[dashboard]** Supabase LIVE →
   Authentication → Users → your user → remove the MFA factor. Then re-enrol at `/mfa`. Afterwards,
   add a second admin so this is never needed again.

## Suspected abuse

1. Admin › Reports holds fan reports. Admin › Accounts → **Suspend** stops a creator's games for fans.
   It is recorded in Activity. A report with the reason **"Involves someone under 18"** follows the
   next section, not this one.
2. A creator can block a single fan from that fan's drawer (**Block fan**).
3. **Flood of traffic:** **[dashboard]** Vercel → Firewall → Attack Challenge Mode. If you need a calm
   page, use **Pause the site** above. Last resort: **[dashboard]** Vercel → Pause project (fans see a
   generic Vercel page).

## Child-safety report or a request from law enforcement

A fan report with the reason "Involves someone under 18" or "Illegal content or activity" e-mails
`ALERT_EMAIL_TO` at once (reason and time only; nothing else leaves the server) and is listed first
in Admin › Reports. Treat it as the most urgent thing of the day. Steps, in order:

1. **Acknowledge within 24 hours.** Open the report in Admin › Reports (the creator's name, the fan's
   short link hint and the free-text detail are there). Do not resolve it yet.
2. **Preserve, do not delete.** Do not delete the creator account, the fan, the photos or the chat,
   and do not resolve the report, until the matter is closed: deletion scrubs evidence. If the
   content is a photo, Admin › **Remove photos** takes it off the public page while the rows stay.
3. **Stop the harm.** Admin › Accounts → **Suspend** the creator (their fan links and public page go
   dark at once). Suspension is reversible; deletion is not.
4. **Do not tell the creator why.** The suspension notice names the support address only. Do not
   forward the report, the fan's words or the reporter's identity to the creator.
5. **Report it.** If the content may show a minor, report it the same day: in the United States to
   NCMEC's CyberTipline (https://report.cybertip.org, the legally required route for providers), in
   the UK to the IWF (https://report.iwf.org.uk), elsewhere to the national hotline listed by
   INHOPE (https://www.inhope.org). Keep the report number with the evidence.
6. **A request from law enforcement** arrives at the support address (`security.txt` and the legal
   pages name it). Ask for it in writing on official letterhead with the legal basis; preserve what
   it names (step 2) at once; answer only after the lawyer has read it, except where the request
   says a life is at risk. Admin › **Look up a win** and the read-only SQL in "Fan says a prize is
   missing" are the tools for pulling records; never edit them.
7. **Record everything** (who, when, what was preserved, who was told) in a private note outside
   the app, and tell the lawyer the same day. The report stays in Admin › Reports (reports outlive
   the account) until the lawyer says it may be resolved.

## Roll back a deploy

0. **The go-live release is the exception.** The deployment before it is the pre-0039 code, which
   cannot run on the 0039–0072 schema (fulfilment and spins break). For that release do not use
   Instant Rollback: go to **Pause the site**, then fix forward with a new PR.
1. **Stop the harm:** **[dashboard]** Vercel → Deployments → the previous Production deployment →
   **Instant Rollback**. This takes seconds. It skips the `db-migrations-production` Deployment Check
   on purpose.
2. **Make `main` match:** open a revert PR of the bad merge. Wait for CI to go green, merge it, and
   approve `db-migrations-production`. That run is a no-op if no migration changed.
3. **If the bad release included a migration:** the old code now runs on the newer schema. That is
   normally fine, because migrations are expand-then-contract. Confirm that the System health schema
   line says "newer than this release expects", not "behind". Never reverse a migration by hand.
4. Details and the old-code/new-schema check: `DEPLOY.md` § Rollback.

## Before each production migration run

1. **[dashboard]** Supabase LIVE → Database → Backups: confirm that today's backup is listed before you
   approve the `db-migrations-production` job. The job checks the same list through the Management
   API and refuses `supabase db push` without a backup from the last 36 hours (`docs/GO_LIVE.md`
   section 5, "The backup gate").

## When a PR's TEST migration run is stuck or TEST's history is dirty

Symptom: the `test` job of **Supabase migrations** fails on every PR with "remote history has
versions with no file in this commit" (an abandoned PR applied its `0073` to TEST), or
`db push` refuses a migration older than TEST's newest (two PRs took the same number).
1. Nobody can merge a database change until TEST is repaired; say so in the PR.
2. The agent repairs TEST (never LIVE): `supabase migration repair --status reverted <version>`
   plus the reverse SQL of that migration, or, when TEST holds no data worth keeping, a rebuild
   from `supabase/schema.sql` after `supabase/reset.sql`. Then re-run the PR's job.
3. Migration numbers are assigned in one place: the next free number is reserved in the DB
   builder's brief for the batch (`docs/handoff/MASTER_TRACKER.md`); two PRs never share one.
4. Every job has a timeout now (`timeout-minutes`), so a hung run releases the shared
   `supabase-migrate-test` lock within 30 minutes; a cancelled run can be re-run from the Actions tab.

## Restore from backup (do not improvise)

Only after a written decision (what is wrong, which point in time, who approved). Everything
below is **[dashboard]** or in Admin; no terminal, no CLI, no password in the agent's hands.

**What a restore does, before you start:**
- On the Pro plan a daily backup is restored **in place**, into the same LIVE project, with downtime
  while it runs. "Restore to a new project first" exists only with the Point-in-Time Recovery add-on.
- It restores the database only. **Photos in Storage are not restored** (a creator's gallery and
  avatar bytes stay as they are now; the rows pointing at them come back from the backup). Push
  subscriptions and rate limits are unaffected. Reward keys are fine as long as they were not
  rotated in between (never rotate them for a restore).
- Every play since the backup point disappears: those fans get their spins back and their wins are
  gone (their `/verify` links answer "not found"). **Reward codes handed out after the backup point
  become available again, so the same code can go to a second fan.** The SQL below lists exactly
  those so you can reconcile by hand.

Steps:
1. **Pause the site** (above), so nothing is written during the restore.
2. **Write down the backup point** (date and time, UTC) you will restore to.
3. **Before restoring**, run this read-only query in **[dashboard]** Supabase LIVE → SQL Editor and
   save the result privately (it is what will be lost):
   ```sql
   -- Everything handed out or delivered since the backup point. Replace the timestamp.
   select 'redemption' as kind, r.id, r.spin_id, r.status::text as state, r.fulfilled_at as at,
          s.prize_label as label, s.creator_id
     from public.redemptions r join public.spins s on s.id = r.spin_id
    where greatest(r.created_at, coalesce(r.fulfilled_at, r.created_at)) >= '2026-01-01T00:00:00Z'
   union all
   select 'reward_code', c.id, c.spin_id, 'handed out (hint ' || coalesce(c.hint, '?') || ')', c.assigned_at,
          p.label, p.creator_id
     from public.prize_reward_codes c join public.prizes p on p.id = c.prize_id
    where c.assigned_at >= '2026-01-01T00:00:00Z'
   order by 1, 5;
   ```
   If a column name has changed since this was written, the query errors instead of lying; ask the
   agent for the current one.
4. **[dashboard]** Supabase LIVE → Database → Backups → the backup at or before your point →
   **Restore**. Wait for the project to come back (status Healthy).
5. Open the health URL (expect `200`), then Admin › System health → **Refresh status** → **Run checks
   now**: the schema line must read "as this release expects" (a backup older than the last
   migration run reads "behind": then approve a re-run of the last `db-migrations-production` job,
   which re-applies the missing migrations and verifies the history), and the reward-key and ledger
   checks must pass.
6. **Reconcile** with the saved list from step 3: for each delivered reward code that is now
   "available" again, mark it used in Admin (or ask the creator to delete that code from the prize)
   before reopening, so no second fan receives it; tell each affected creator which fans' wins
   since the point are gone, so they can honour them by hand.
7. Reopen the site (delete `FF_MAINTENANCE`, redeploy). Run the post-restore report once more and
   file it with the decision: what was restored, how much time was lost, which fans and creators
   were affected, and what was told to whom. The lawyer decides whether affected fans must be
   notified (`docs/LAWYER_QUESTIONS.md`).
8. The agent runs `node scripts/security/rls-runtime-test.mjs` against TEST only, never LIVE,
   after any schema repair.
