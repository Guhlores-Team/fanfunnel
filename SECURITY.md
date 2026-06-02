# FanFunnel — Security Model & Audit

_Last reviewed: 2026-06 (Phase 8). Re-run the checks below before each release._

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
| **SECURITY DEFINER hygiene** | All 23 definer functions pin `set search_path = public`, blocking search-path hijacking. |
| **Anon vs service key** | Anon key in the browser is harmless under RLS. Service key is server-only (`createServiceClient`), used for atomic spins, the admin bootstrap, and owner-guarded agency RPCs. |
| **Fan links** | `/spin/<token>` uses unguessable random tokens. Spins are recorded **server-side & atomically** (`claim_spin`), so a fan can't tamper the page to mint spins. |
| **Auth** | Supabase Auth (bcrypt passwords, JWT sessions). |
| **Rate limiting** | `/api/spin` is rate-limited (`src/lib/rateLimit.ts`). |
| **Agency seats** | Per-command RLS split + `can_act_for(creator, perm)` so a chatter/fulfiller seat can only do its job, only for assigned creators. |

## Automated checks

```bash
npm test                                   # includes the RLS static lint (no DB needed)
node scripts/security/rls-runtime-test.mjs # PROVES isolation against your live DB
```

- **Static lint** (`src/lib/security/rls.test.ts`) — parses the SQL and fails CI
  if any table ships without RLS/policy, any policy is wide-open, or any
  SECURITY DEFINER function forgets `search_path`. This catches the most common
  way a future migration could open a hole.
- **Runtime test** (`scripts/security/rls-runtime-test.mjs`) — creates two
  throwaway creators, signs in as each with the anon key, and asserts creator A
  reads/updates/deletes **zero** of creator B's rows across fans, wheels,
  prizes, spins, grants, and profiles. Run it after any RLS migration.

## Known limitations / hardening backlog (honest list)
- **Rate limiting is in-memory per instance.** Fine for a single instance; on
  multi-instance/serverless it's not a global limit. For real protection at
  scale, back it with a shared store (Upstash/Redis or a Postgres counter).
- **No MFA on admin** yet. Recommend enabling Supabase MFA for the admin email.
- **No automated dependency/secret scanning** in CI yet (consider Dependabot +
  secret scanning).
- **Agency RLS (migration 0014) must be runtime-verified** on the live DB with
  the cross-tenant test above before relying on staff seats in production.
- Enable Supabase **leaked-password protection** in Auth settings.

## If you suspect a leak
1. Run `node scripts/security/rls-runtime-test.mjs` — it will fail loudly and name the table.
2. Check the offending table's policies in `supabase/migrations_combined.sql`.
3. Rotate the service-role key in Supabase if it may have been exposed.
