# Data retention

How long FanFunnel keeps each kind of record, and what deletes it. The numbers
below come from `src/lib/privacy/retention.ts` (`RETENTION_DAYS`), the one place
they are set. `src/lib/privacy/retention.test.ts` fails if this page and that
file disagree. Web-push history uses the shared `PUSH_LOG_RETENTION_DAYS`
constant; the test also pins the SQL cleanup period to that value.

## Automatic cleanup (daily)

| Record | Table | Kept for | Deleted when |
| --- | --- | --- | --- |
| Web-push delivery log (notification deduplication history) | `push_log` | **30 days** after `sent_at` | older than the period, even if the creator is inactive or has no new notifications |
| Admin activity log entries | `admin_audit_log` | **365 days** | older than the period |
| In-app notices to a creator (for example "a fan deleted their data") | `creator_notices` | **90 days** | older than the period |
| Hashes of fan links that stopped working (so the fan sees "this creator has left" / "your data was deleted" rather than a bare 404) | `link_tombstones` | **180 days** | older than the period; after that the link is a plain 404 |
| Error reports an admin marked resolved | `app_errors` | **90 days** after `resolved_at` | resolved and older than the period; unresolved reports are never auto-deleted |
| Agency invites that were declined or revoked (they hold the invited email address) | `org_invites` | **90 days** after the invite was sent | declined or revoked and older than the period; pending and accepted invites are kept |

`app_errors` arrives with migration 0053. Until that table exists the cleanup
skips it and reports `app_errors: null`; nothing fails.

### Nothing else to clean up

- **Password-reset links** are issued and expired by Supabase Auth itself
  (the "email OTP expiry" setting in Supabase → Authentication). The app stores
  no reset tokens of its own.
- **Rate-limit counters** live only in server memory (or the shared limiter
  store, which expires each key with its window). Nothing is written to the
  database.
- **Error-alert throttling rows** (`app_error_alerts`, migration 0053) are
  pruned after one day by the error-reporting function itself.

### How it runs

- **Vercel Cron** calls `GET /api/cron/retention` once a day at 04:17 UTC
  (`vercel.json`, `RETENTION_CRON_SCHEDULE`).
- The route only runs with `Authorization: Bearer <CRON_SECRET>`. The secret is
  compared in constant time. If `CRON_SECRET` is unset or shorter than
  16 characters, the route returns 503 and deletes nothing (fails closed).
- It calls the SECURITY DEFINER function `run_retention_cleanup` with the
  periods above. The function is executable by `service_role` only, and it
  refuses any period under 1 day.
- A run that deleted anything leaves one `retention.cleanup` entry in the
  admin activity log, holding only the counts.

**Why Vercel Cron rather than pg_cron:**

- It needs no database extension. The schema drift check stays on vanilla
  Postgres, and the test and prod projects behave alike.
- The periods live in one TypeScript constants file that is reviewed with the
  code.
- The trigger is authenticated by a secret that can be rotated.

### Setup

1. Generate a secret: `openssl rand -hex 32`.
2. In Vercel → Project → Settings → Environment Variables, add `CRON_SECRET`
   for **Production** (and Preview, if you want the cron on previews).
   Vercel Cron sends it as the Bearer token automatically.
3. Redeploy. Vercel → Project → Cron Jobs shows the schedule, and "Run" triggers
   it by hand.

## Never deleted by age

Fans, fan links, spins, redemptions, grants, messages, wishlists and referrals
are business records that the creator controls. No automatic job deletes them.
They go only when one of these happens:

- **A creator deletes a fan.** The fan and their links, grants, messages,
  wishlists and referrals are deleted. Their spins and redemptions are kept
  without any link to the fan.
- **A fan deletes their own data** from the Safety menu on their link. The
  effect is the same as above, and the creator gets an in-app notice that
  holds no personal data.
- **A creator closes their account** in Settings, or an admin deletes it.
  Everything the account owns is deleted, and its fans' links show "this
  creator has left".

## Exports

- **Fans** can download their own data from the Safety menu on their link. Each
  download covers only that fan's records with that creator.
- **Creators** can download their account data in Settings → Your data. The
  export is built on their own session, so the database's row-level security
  limits it to their own rows.
- Both downloads are sent `no-store` and are rate limited.
