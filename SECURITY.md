# FanFunnel — Security Model & Audit

_Last reviewed: 2026-10 (go-live hardening, migration 0052). Re-run the checks below before each release._

## Architecture in one paragraph
Next.js app on Vercel, data in **Supabase Postgres**. Every tenant table has
**Row-Level Security (RLS)** so the *database itself* — not just app code —
enforces that a creator can only touch their own rows. The browser only ever
receives the **anon** key (RLS applies to it). The **service-role** key (which
bypasses RLS) is used **server-side only**, never shipped to the client.

## What protects the data

| Layer | Protection |
|---|---|
| **RLS on every table** | 25/25 public tables enable RLS and define a policy. A creator's reads/writes are scoped to `creator_id = auth.uid()` (or, for agency staff, `can_act_for()`). Verified by `src/lib/security/rls.test.ts`. |
| **No wide-open policies** | No policy uses `using (true)` / `with check (true)`. |
| **SECURITY DEFINER hygiene** | Every definer function pins `set search_path = public`, blocking search-path hijacking. |
| **Anon vs service key** | Anon key in the browser is harmless under RLS. Service key is server-only (`createServiceClient`), used for atomic spins, the admin bootstrap, and owner-guarded agency RPCs. |
| **Fan links** | `/spin/<token>` uses unguessable random tokens. Spins are recorded **server-side & atomically** (`claim_spin`), so a fan can't tamper the page to mint spins. |
| **Auth** | Supabase Auth (bcrypt passwords, JWT sessions). |
| **Rate limiting** | `/api/spin` and the public GETs (recent wins, leaderboard, fan messages) are rate-limited (`src/lib/rateLimit.ts`). When `KV_REST_API_URL`/`KV_REST_API_TOKEN` (Vercel's Upstash integration) or `UPSTASH_REDIS_REST_URL`/`_TOKEN` are set, the counters are shared across every instance in Upstash Redis. Unset, or if Redis fails, it falls back to per-instance memory. |
| **Agency seats** | Per-command RLS split + `can_act_for(creator, perm)` so a chatter/fulfiller seat can only do its job, only for assigned creators. Org tables check each other through SECURITY DEFINER helpers (no policy recursion), and `org_account_stats` shows a seat only the creators it may view. Every org helper, policy and RPC requires an active caller, so a suspended owner can't manage seats, scopes or invites and a suspended seat reaches nothing; a suspended creator keeps only a read-only view of its own account (migration 0052). |

## Automated checks

```bash
npm test                                         # static RLS lint + SQL sync + auth guards (no DB)
node scripts/db/schema-drift-check.mjs           # local Postgres: builds + grant probe + agency/org isolation probe
node scripts/security/rls-runtime-test.mjs       # live TEST project: cross-tenant + agency isolation + no self-promotion
npm run e2e:supabase                             # live TEST project: RLS + RPC integration
```

- **Static lint** (`src/lib/security/rls.test.ts` and its neighbours): fails CI if any table ships
  without RLS or a policy, any policy is wide-open, any SECURITY DEFINER function forgets
  `search_path`, or a signed-in-only RPC is left callable by anon.
- **Schema-drift check** (`scripts/db/schema-drift-check.mjs`, CI job `schema-drift`): on a
  throwaway local Postgres it builds the DB three ways, diffs the catalogs, then acts as real
  `authenticated` users. Its agency/org probe (`scripts/db/orgIsolationProbe.mjs`) proves that a
  seat sees only its org's creators (a scoped seat only its scoped ones), a creator outside the org
  is unreachable, a non-member cannot add itself to an org, a seat, a seat scope or someone
  else's invite, and a suspended owner, seat or invitee is refused.
- **Runtime test** (`scripts/security/rls-runtime-test.mjs`, CI job `supabase`): signs in as
  throwaway creators, an agency seat and a non-member on the TEST project and asserts zero
  cross-tenant reads or writes and no self-promotion. It refuses to run against LIVE.
- **Dependabot** (`.github/dependabot.yml`): weekly npm and GitHub Actions updates, minor and
  patch grouped.

## Known limitations / hardening backlog (honest list)
- **No MFA on admin** yet. Enable Supabase MFA for the admin account (owner, `docs/GO_LIVE.md`).
- **Secret scanning** is a GitHub repository setting (Settings → Code security), not something the
  repo can turn on. Owner to enable.
- Enable Supabase **leaked-password protection** in Auth settings.
- No error monitoring (Sentry, log drain) yet: owner decision pending.

## If you suspect a leak
1. Run `node scripts/security/rls-runtime-test.mjs` and `npm run e2e:supabase` against the TEST project. They fail loudly and name the table.
2. Check the offending table's policies in `supabase/migrations_combined.sql`.
3. Rotate the service-role key in Supabase if it may have been exposed.
