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
  within 2 seconds, else `503 {"ok":false}`. It is never cached and never says why.

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
2. **[dashboard]** Deployments → the current Production deployment → **Redeploy**. Vercel applies an
   environment change only to a new deployment.
3. While paused:
   - Fans and visitors see "We'll be back soon… nothing was spent".
   - API writes answer `503 {"error":"maintenance"}` with `Retry-After`.
   - `/dashboard`, `/admin`, `/login` (with `/mfa`), `/api/admin/*`, `/api/health` and static files
     still work. Signed-in dashboard reads still work.
4. To reopen: delete `FF_MAINTENANCE` (or set it to anything but `1`) and redeploy again.

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
   It is recorded in Activity.
2. A creator can block a single fan from that fan's drawer (**Block fan**).
3. **Flood of traffic:** **[dashboard]** Vercel → Firewall → Attack Challenge Mode. If you need a calm
   page, use **Pause the site** above. Last resort: **[dashboard]** Vercel → Pause project (fans see a
   generic Vercel page).

## Roll back a deploy

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
   approve the `db-migrations-production` job. That job runs `supabase db push` with no backup step of
   its own.

## Restore from backup (do not improvise)

1. Restore only after a written decision. **[dashboard]** Supabase LIVE → Database → Backups / PITR.
   Prefer restoring into a NEW project first.
2. Point the Vercel Production variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`) at the restored project only after its checks pass. Keep the SAME
   `REWARD_ENCRYPTION_KEY`, `REWARD_ENCRYPTION_KEY_VERSION` and `REWARD_CODE_FINGERPRINT_KEY`. Never
   rotate them.
3. Check the migration history:
   `supabase migration list --linked --password … | node scripts/ci/verify-migrations-applied.mjs --label PRODUCTION`.
4. Open the health URL (expect `200`), then System health → **Run checks now**. Reward-key protection
   and the ledger invariants must both be healthy.
5. Run `node scripts/security/rls-runtime-test.mjs` against TEST only, never LIVE, to re-prove
   isolation after any schema work.
6. Record what was restored, how much time was lost, and which fans or creators were affected.
