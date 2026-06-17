# 🎡 FanFunnel

Personalized prize-wheel games for creators. A creator sends each fan a
**unique link**; the fan spins and **always wins something** — but the rare
drops are what keep them coming back. Built to run on a creator's OnlyFans
audience (link-in-DM), with the wheel being game #1 of a planned suite
(scratch tickets, bingo, …).

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

1. **Create a Supabase project**, then in the SQL Editor run two files **in
   order**: [`supabase/schema.sql`](supabase/schema.sql) (base tables, RLS, the
   **hardened** `claim_spin`, the auth trigger) **then**
   [`supabase/migrations_combined.sql`](supabase/migrations_combined.sql) (every
   migration on top). Both are idempotent, so together they always produce a
   complete, current schema. ⚠ `schema.sql` alone omits the later migrations and
   brings up a weaker DB.
2. **Copy `.env.example` → `.env.local`** and fill in the URL, anon key, and
   service-role key from Supabase → Project Settings → API. **All three are
   required** — the app refuses to boot in production if any is missing (it will
   not silently fall back to in-memory demo data).
3. **Sign up** at `/login` (email + password). For the smoothest start, turn
   OFF "Confirm email" under Supabase → Authentication → Providers → Email
   (or leave it on and confirm via the emailed link).
4. **Make yourself admin** (you're a creator + admin) once your row exists:
   ```sql
   update public.profiles set role = 'admin' where email = 'you@example.com';
   ```
5. **Deploy to Vercel** and add the same env vars in the Vercel project
   settings. Done.

### Auth & access
- Creators/admins sign in at `/login`; middleware (`src/middleware.ts`)
  refreshes sessions and guards `/dashboard`.
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
supabase/schema.sql      Base multi-tenant schema + RLS (run migrations_combined.sql after).
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
- Toggle per-account feature flags (Prize Wheel is the base; Scratch / Bingo
  unlock as we ship them)
- Create a new creator account directly — you set their login and hand it over

## Resetting everything

**Demo mode (no Supabase):** all data lives in memory. Just restart the dev
server — stop it, then `npm run dev` — and the store re-seeds fresh (the
`demo` wheel, the demo fan link, and the sample admin accounts).

**Production (Supabase):** run [`supabase/reset.sql`](supabase/reset.sql) in
the Supabase SQL Editor. It truncates all app data (wheels, prizes, fans,
links, spins, redemptions) but keeps your tables and logins. Optional blocks at
the bottom let you also delete creator accounts or reset roles/features.

To rebuild from scratch, re-run [`supabase/schema.sql`](supabase/schema.sql)
**then** [`supabase/migrations_combined.sql`](supabase/migrations_combined.sql)
— both are idempotent (safe to run repeatedly).

## Tests

```bash
npx tsx src/lib/games/wheel/engine.test.ts
```

## Roadmap
- ✅ Creator/admin auth + middleware (sign-in)
- ✅ Persisted wheel editor (saves wheel + prizes to Supabase)
- ✅ Redemption fulfilment inbox + live metrics
- ✅ Admin panel: manage creator accounts + cross-account metrics
- Per-creator theming (fonts, background, photo-hub) — premium feel
- More games: scratch tickets, bingo (same prize/fan/account system)
