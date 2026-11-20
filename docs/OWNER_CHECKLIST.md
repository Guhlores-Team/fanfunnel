# Owner's operations checklist

Everything below exists in the app or in a service the owner already has. Items marked
**[dashboard]** happen in a web console. Never paste keys, passwords or fan links anywhere. When
something is wrong, this page points at the matching section of [`RUNBOOK.md`](RUNBOOK.md); the
go-live order itself is [`GO_LIVE.md`](GO_LIVE.md) and [`handoff/OWNER_STEPS.md`](handoff/OWNER_STEPS.md).

## Every morning (2 minutes)

1. Inbox: any e-mail from **FanFunnel <alerts@…>** ("New error", "N more new errors"), from
   UptimeRobot ("down"/"up") or from Healthchecks.io ("is down" = the nightly job did not report)?
   - UptimeRobot down + no up: open `https://<site>/api/health` yourself. `503` = database. Follow
     RUNBOOK "DB down". `500` = the site is misconfigured (an env var missing or wrong): **[dashboard]**
     Vercel → Deployments → latest → Logs for "FanFunnel is misconfigured". `429` = you refreshed it
     too often; wait a minute.
   - Healthchecks "down": RUNBOOK "The heartbeat monitor says down" (six causes, most likely first).
2. Admin › System health (`/dashboard?section=admin`): expect
   - Reward keys: "match the saved protection record".
   - Schema: "as this release expects" (or "newer" during a rollout). "behind" = stop and read
     RUNBOOK "Roll back a deploy".
   - Maintenance job: last ran within 24 h (not red).
   - Alert e-mails: ON; Rate-limit store: no fallback (or an old one you already know about).
3. Admin › Errors, Open: skim the newest rows. Fixed messages to know by heart:
   - "Account e-mail was not sent …" → RUNBOOK "E-mail down" (Resend key, domain, quota).
   - "Push delivery failed …" → RUNBOOK "Push notifications stopped".
   - "Rate limit store unreachable …" → RUNBOOK "Rate limits fell back" (Upstash quota).
   - "Retention cron …" or "Maintenance job has not run …" → cron / `CRON_SECRET`.
   - "Admin action succeeded but its audit entry was not written" → tell the operator the same day.
   - "Database schema is behind …" → RUNBOOK "Roll back a deploy".
   - "CSP blocked … vercel.live" on Preview → the Vercel Toolbar; ignore or turn the toolbar off.
   Press **Resolve** only when you understand the row; a resolved row that returns e-mails again.
4. Admin › Reports: any fan report waiting? One with "Involves someone under 18" or "Illegal
   content" → RUNBOOK "Child-safety report" **now**. Admin › Requests: any creator waiting for approval?

## Every week (10 minutes)

1. **[dashboard]** Supabase LIVE › Database › Backups: a backup from each of the last 7 days is listed
   (the production migration job refuses to run without one from the last 36 hours).
2. **[dashboard]** Supabase LIVE › Reports / Usage: database size and egress against the plan.
3. **[dashboard]** Upstash console: commands used this month against the plan.
4. **[dashboard]** Resend: e-mails sent this month, bounces, and that `easysimplesites.org` is still verified.
5. **[dashboard]** Vercel › Usage: function invocations and duration against the plan; Vercel ›
   Deployments: the top Production deployment is the one you expect (SHA from the last release note).
6. Send yourself a password-reset e-mail from `/forgot-password` on the live site; the link must open
   the reset page. Send a test e-mail to the support address from an outside account; it must arrive.
7. Admin › Activity: skim the week's admin actions (role changes, suspensions, lookups, deletions).
8. Admin › System health: Push notifications, Shared rate limits, CRON_SECRET, HEARTBEAT_URL all
   "configured".
9. **[dashboard]** GitHub › Security: any Dependabot alert or private vulnerability report open? Any
   Dependabot PR waiting (read the diff of `web-push` 4.x before merging; it is on the untrusted list)?

## Before every release (merge to `main`)

1. Yesterday's and today's LIVE backup are listed (Supabase › Database › Backups).
2. CI on the PR is green: `verify`, `schema-drift`, `supabase`, `login-ui` and the migration `test` job
   (all five are required by the ruleset, `GO_LIVE.md` section 2).
3. The Preview badge shows the exact SHA you tested, and you tested the changed features on a phone
   (the numbered script: `handoff/OWNER_STEPS.md` Stage 7).
4. If the PR adds a migration: the "old code on new schema" check in `DEPLOY.md` § Rollback was done.
   For the go-live release itself it cannot pass (the old code is pre-0039): Instant Rollback is off
   the table; the plan is pause-and-fix-forward.
5. **You** merge (`GO_LIVE.md` section 8). After the merge: approve `db-migrations-production` in GitHub
   only after step 1; the job then verifies the backup, pushes and reads the history back. Watch
   Vercel: the new deployment must stay un-aliased until the check is green (Deployment Check
   configured and proven on a code-only merge first).
6. After promotion: Admin › System health → **Refresh status** → **Run checks now**; schema "as this
   release expects"; open one fan link and one `/verify/<id>` link. On the go-live release also
   initialize the reward canary within the hour.
7. Write the release note: SHA, date, which migrations applied, the backup used, who approved.

## Incident quick map (which RUNBOOK section)

| You see | Go to |
|---|---|
| UptimeRobot down, health `503` | DB down |
| UptimeRobot down, health `500` | Site down (misconfiguration: Vercel logs) |
| Healthchecks "down" | The heartbeat monitor says "down" |
| Fans report "didn't load" page | DB down |
| Fans report a blank page for minutes, then a Vercel error | DB slow (same as DB down; pause the site if it lasts) |
| Creator: "no approval e-mail" | E-mail down |
| Creator: "my invitation link expired" | A creator's invitation or reset link expired |
| Creator: "pushes stopped" | Push notifications stopped (then each creator presses **Send a test**) |
| Fan: "my prize never came" | Fan says a prize is missing |
| Creator locked out of 2FA | Creator locked out |
| Report "Involves someone under 18" / a letter from the police | Child-safety report or a request from law enforcement |
| Flood of traffic / abuse | Suspected abuse |
| Just deployed and things broke | Roll back a deploy (go-live release: pause instead) |
| Every PR's migration check is red | When a PR's TEST migration run is stuck |
| Data wrong or lost | Restore from backup (written decision first; in place, with downtime, photos are not restored, codes handed out since the point come back) |
