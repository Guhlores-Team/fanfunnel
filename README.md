# 🎡 FanFunnel

Personalized prize games for creators: a prize wheel, scratch tickets and
personal bingo. A creator sends each fan a **unique link**; the fan plays and
**always wins something** — but the rare drops are what keep them coming back.
Built to run on a creator's OnlyFans audience (link-in-DM).

> **No gambling, no payment processing in-app.** Fans tip the creator on their
> existing platform; the creator grants spins. Every spin yields a guaranteed
> reward, which keeps this out of lottery/gambling regulation and away from
> payment-processor bans.

---

## How it works

| Role | What they do | What they see |
| --- | --- | --- |
| **Admin** (you) | Manage every account, grant features, see all metrics. Also a full creator. | Everything |
| **Creator** (your clients) | Build wheels, set prizes + rarity + stock, create fan links, grant spins, track redemptions. | Their own workspace |
| **Fan** | Open their link, spin, claim prizes. **No account, no login, no settings.** | Only their own spins + win history |

The fan's link *is* their whole world — a token-based personal "spins page".
The creator creates it and holds all the power and visibility.

### The core safety rule
**Spin outcomes are decided on the server**, weighted by each prize's rarity
and limited stock. The browser only animates the wheel to the result the
server already chose — so a fan can't rig a win with dev tools.

---

## Quick start (zero config)

```bash
npm install
npm run dev
```

Open <http://localhost:3000>:
- **/** — landing page
- **/spin/demo** — a fully working demo wheel (try it!)
- **/dashboard** — the creator dashboard (wheel editor, fan links, metrics)

With no environment variables set, everything runs against an in-memory demo
store. Links you generate in the dashboard really work and really spin.

---

## Going live (Supabase + Vercel)

The production setup (two Supabase projects, Vercel Production/Preview scopes,
CI-applied migrations, auth URLs and email templates) is documented in
[`DEPLOY.md`](DEPLOY.md). The ordered first-launch checklist is
[`docs/GO_LIVE.md`](docs/GO_LIVE.md). In short:

1. **Schema:** CI applies `supabase/migrations/` to the TEST project on every PR
   and to LIVE on merge to `main`. For a brand-new project you can also run
   [`supabase/schema.sql`](supabase/schema.sql) once in the SQL Editor (the
   upgrade path for an existing database is
   [`supabase/migrations_combined.sql`](supabase/migrations_combined.sql)).
   `npm test` and `node scripts/db/schema-drift-check.mjs` keep the three
   equivalent.
2. **Env:** copy `.env.example` → `.env.local` and fill in the URL, anon key and
   service-role key. All three are required in production: the app refuses to
   boot rather than fall back to demo data.
3. **Sign up** at `/login` and confirm the email (keep "Confirm email" ON).
4. **Admin:** set `ADMIN_EMAILS` to your address, then open `/admin` and use
   **Claim admin**. No SQL needed.

### Auth & access
- Creators/admins sign in at `/login`; the proxy (`src/proxy.ts`) refreshes
  sessions on the dashboard, admin, agency and auth routes, and each page
  re-checks access server-side.
- In demo mode (no env vars) auth is skipped and the dashboard is open.
- Fans never authenticate — their secret link is their whole experience.

---

## Architecture

```
src/
  lib/games/wheel/      Pure, framework-free wheel engine (weighted picks,
                        stock, odds). Unit-tested — single source of truth.
  lib/sound.ts          Procedural tick/win sounds + haptics (no audio files).
  lib/data/             Data access. Transparently uses Supabase when
                        configured, else an in-memory demo store.
  lib/supabase/         Browser + server + service-role clients.
  components/Wheel.tsx   Canvas wheel: animation, ticker peg, sound.
  components/SpinClient  Fan-facing spin experience.
  components/dashboard/  Creator dashboard (editor, links, metrics).
  app/spin/[token]/      Fan page.
  app/api/spin/          Server-authoritative spin endpoint.
  app/api/passes/        Create a unique fan link.
supabase/schema.sql      Complete multi-tenant schema + RLS (all migrations folded in).
```

### Why config-driven
Each wheel is just data (`WheelConfig`: prizes, weights, colors, stock). The
same engine powers the hosted app today and can power future games and exports
tomorrow without rewrites.

## Admin panel

Visit `/admin` (admin role required in production; open in demo mode). From
there you can:
- See cross-account metrics (accounts, total fans, spins, prizes pending)
- Suspend / reactivate any creator account
- Promote a creator to admin (or back)
- Toggle per-account game access: Prize Wheel is always on; Scratch Tickets
  and Bingo are switched on per creator (off by default for new accounts).
  Turning one off stops new games of that kind; existing paid links keep working.
- Create a new creator account directly — you set their login and hand it over

## Resetting everything

**Demo mode (no Supabase):** all data lives in memory. Just restart the dev
server — stop it, then `npm run dev` — and the store re-seeds fresh (the
`demo` wheel, the demo fan link, and the sample admin accounts).

**TEST project only (Supabase):** run [`supabase/reset.sql`](supabase/reset.sql)
in the TEST project's SQL Editor. It truncates all app data (wheels, prizes,
fans, links, spins, redemptions) but keeps your tables and logins. Optional
blocks at the bottom let you also delete creator accounts or reset roles/features.
**Never run it on LIVE** (`docs/GO_LIVE.md` section 5): the live site is
restored only from a backup, by the owner, after a written decision
(`docs/RUNBOOK.md` § Restore from backup).

To rebuild from scratch, re-run [`supabase/schema.sql`](supabase/schema.sql)
— it is idempotent (safe to run repeatedly) and already contains every
migration; an existing database is upgraded with
[`supabase/migrations_combined.sql`](supabase/migrations_combined.sql) instead.

## Tests

```bash
npm run lint && npm run typecheck
npm test                                    # every src/**/*.test.ts (unit + SQL/RLS guards)
node scripts/db/schema-drift-check.mjs      # needs Postgres 16 binaries; builds the DB 3 ways + RLS probes
npm run build && npx next start -p 3000 &   # then, against that server:
export E2E_BASE_URL=http://localhost:3000; npm run e2e && npm run e2e:a11y
```

## Roadmap
Shipped (migrations 0001–0073, all applied to the TEST project and exercised on
the Preview): creator/admin auth, persisted multi-wheel editor, fulfilment inbox
and metrics, admin console, agency console (orgs and staff seats with scopes),
boosts (happy hours, webhooks, link-in-bio), provably-fair v3 spins with a
public verify page, PWA install, in-house error monitoring with e-mail alerts
(0053), versioned Terms/Privacy (0055), web push (0056), instant reward delivery
(0057), creator theming (0058), Focus and Chase (0059), scratch tickets (0060),
personal bingo (0061), account security (0062), operational integrity (0063),
fan-report review (0064), per-fan game links and lifecycle locks (0065), agency
seat scopes and alert release (0066), the runtime schema-version check (0067),
tenant boundaries (0068), integration hardening (0069), one game resolution per
play (0070), ledger guards and lock order (0071), advisor hardening (0072), batch-7 hardening (0073), plus
the go-live tooling (carry-over script, DB-before-code check, LIVE backup gate).
The LIVE project is still at 0038: the go-live merge applies 0039–0073.

Next: the owner's Preview acceptance (`docs/handoff/OWNER_STEPS.md` Stage 7),
the batch-7 follow-ups and go-live per `docs/GO_LIVE.md`. Live state:
`docs/handoff/MASTER_TRACKER.md`.
