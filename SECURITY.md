# FanFunnel — Security Model & Audit

_Last reviewed: 2026-11 (tenant-boundary audit, migration 0068). Re-run the checks below before each release._

## Architecture in one paragraph
Next.js app on Vercel, data in **Supabase Postgres**. Every tenant table has
**Row-Level Security (RLS)** so the *database itself* — not just app code —
enforces that a creator can only touch their own rows. The browser only ever
receives the **anon** key (RLS applies to it). The **service-role** key (which
bypasses RLS) is used **server-side only**, never shipped to the client.

## What protects the data

| Layer | Protection |
|---|---|
| **RLS on every table** | Every public table (57 at migration 0068) enables RLS and defines a policy; `rls.test.ts` counts them on each run. A creator's reads/writes are scoped to `creator_id = auth.uid()` (or, for agency staff, `can_act_for()`). Verified by `src/lib/security/rls.test.ts`. |
| **No wide-open policies** | No policy uses `using (true)` / `with check (true)`. |
| **SECURITY DEFINER hygiene** | Every definer function pins `set search_path = public`, blocking search-path hijacking. |
| **Anon vs service key** | Anon key in the browser is harmless under RLS. Service key is server-only (`createServiceClient`), used for atomic spins, the admin bootstrap, and owner-guarded agency RPCs. |
| **Fan links** | `/spin/<token>` uses unguessable random tokens. Spins are recorded **server-side & atomically** (`claim_spin`), so a fan can't tamper the page to mint spins. |
| **Auth** | Supabase Auth (bcrypt passwords, JWT sessions). |
| **Rate limiting** | `/api/spin` and the public GETs (recent wins, leaderboard, fan messages) are rate-limited (`src/lib/rateLimit.ts`). When `KV_REST_API_URL`/`KV_REST_API_TOKEN` (Vercel's Upstash integration) or `UPSTASH_REDIS_REST_URL`/`_TOKEN` are set, the counters are shared across every instance in Upstash Redis. Unset, or if Redis fails, it falls back to per-instance memory (bounded at 10,000 windows; when full it evicts expired, then under-limit, then soonest-to-reset windows, so it never refuses a first request for capacity and a blocked caller stays blocked). Production without a shared store is reported by the maintenance cron (Admin › Errors) and shown in Admin › System health; configure one before go-live. Every API route handler has a per-IP default limit (`limitRoute`, pinned by `routeLimits.test.ts`). |
| **Tenant boundaries in the database** | Every cross-row reference a creator session can write (redemption → spin, grant → fan/pass/campaign, message → fan, wishlist → fan/prize, referral → fans, a fan's referrer) is checked by a BEFORE trigger for every role, so a forged `creator_id` cannot pull another tenant's row into a SECURITY DEFINER queue or a push payload (migration 0068). Fan consent (`leaderboard_opt_in`, board name, terms acknowledgement), a link's pause and its token are written only by the fan's own service-role paths; a creator session is refused, and a paused link never resumes. Link tokens are not selectable by a session: `creator_link_tokens` serves them to the owner or a `grant` seat only. Browser roles cannot TRUNCATE and `anon` has no table privilege at all. The local drift check emulates Supabase's default grants so these are tested against the real privileges. |
| **Content-Security-Policy** | Enforced on every response (`src/lib/security/csp.ts`). The signed-in pages (dashboard, admin, agency, pending, login, mfa) get a per-request nonce from the proxy: `script-src 'self' 'nonce-…' 'strict-dynamic'`, so an injected `<script>`, inline handler or `eval` does not run. Every other route gets a static policy that keeps prerendering and ISR: `script-src 'self' 'unsafe-inline'` (no eval, no other script origin). Both allow connections only to this origin and Supabase, and no plugins, `<base>` hijacking or framing by other sites. Violations are reported to Admin › Errors (origin only). Pinned by `csp.test.ts` and `e2e/csp.mjs`; e2e and a11y fail on any violation. Pages also send COOP `same-origin`; the API sends CORP `same-origin`. |
| **Agency seats** | Per-command RLS split + `can_act_for(creator, perm)` so a chatter/fulfiller seat can only do its job, only for assigned creators. Org tables check each other through SECURITY DEFINER helpers (no policy recursion), and `org_account_stats` shows a seat only the creators it may view. Every org helper, policy and RPC requires an active caller, so a suspended owner can't manage seats, scopes or invites and a suspended seat reaches nothing; a suspended creator keeps only a read-only view of its own account (migration 0052). |

## Automated checks

```bash
npm test                                         # static RLS lint + SQL sync + auth guards (no DB)
node scripts/db/schema-drift-check.mjs           # local Postgres: builds + grant probe + agency/org isolation probe
node scripts/security/rls-runtime-test.mjs       # live TEST project: cross-tenant + agency isolation + no self-promotion
npm run e2e:supabase                             # live TEST project: RLS + RPC integration
```

- **Tenant-boundary probe** (`scripts/db/dbSecurityProbe.mjs`, part of the drift check): with
  Supabase's default grants emulated, proves the 0068 rules above as real `authenticated`,
  `anon` and `service_role` sessions (paused links, forged references, consent, tokens,
  messages, invitations, e-mail sync, deletion traces, URL validation, TRUNCATE/anon).
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
- **Admin MFA**: admin reads and writes need an aal2 session (`is_admin()` requires the claim, migration 0054), and an enrolled creator's business writes do too (0062). The owner still has to enrol the admin accounts (`docs/GO_LIVE.md`); the database refuses admin work until they do.
- **Secret scanning** is a GitHub repository setting (Settings → Code security), not something the
  repo can turn on. Owner to enable.
- Enable Supabase **leaked-password protection** in Auth settings.
- No error monitoring (Sentry, log drain) yet: owner decision pending.
- **Public pages keep `'unsafe-inline'` scripts.** A nonce needs a per-request render, so it would
  turn the prerendered pages (/, /privacy, /terms, /forgot-password, /reset-password) and the ISR
  creator page /c/[slug] dynamic, and the proxy would add a hop to every fan page (/spin, /share,
  /verify, /leaderboard). These pages render user content only through React's escaping. Moving a
  route onto the nonce policy means adding it to the proxy and keeping it dynamic.

## Reporting a vulnerability

Please report security problems privately, never in a public issue or pull request:

- **GitHub private vulnerability reporting** (Security → Report a vulnerability), once the owner
  has enabled it (`docs/GO_LIVE.md` section 2, SC-03), or
- e-mail the contact in `/.well-known/security.txt` (`support@easysimplesites.org`; until that
  domain has inbound mail, see `docs/handoff/OWNER_STEPS.md` item 35).

We acknowledge within 3 working days and keep you informed until the fix ships. Do not test
against the live site with real fans' data; use the Preview (TEST database) and never exfiltrate
another tenant's rows. Fan links, codes and keys found during research must not be published.

## If you suspect a leak
1. Run `node scripts/security/rls-runtime-test.mjs` and `npm run e2e:supabase` against the TEST project. They fail loudly and name the table.
2. Check the offending table's policies in `supabase/migrations_combined.sql`.
3. Rotate the service-role key in Supabase if it may have been exposed.
