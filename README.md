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

1. **Create a Supabase project**, then run [`supabase/schema.sql`](supabase/schema.sql)
   in the SQL Editor. It creates all tables, Row-Level-Security policies, the
   `claim_spin` atomic function, and the auth trigger.
2. **Copy `.env.example` → `.env.local`** and fill in the URL, anon key, and
   service-role key from Supabase → Project Settings → API.
3. **Make yourself admin** (you're a creator + admin):
   ```sql
   update public.profiles set role = 'admin' where email = 'you@example.com';
   ```
   (after you've signed up once so the row exists.)
4. **Deploy to Vercel** and add the same env vars in the Vercel project
   settings. Done.

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
supabase/schema.sql      Full multi-tenant schema + RLS.
```

### Why config-driven
Each wheel is just data (`WheelConfig`: prizes, weights, colors, stock). The
same engine powers the hosted app today and can power future games and exports
tomorrow without rewrites.

## Tests

```bash
npx tsx src/lib/games/wheel/engine.test.ts
```

## Roadmap
- Creator/admin auth + middleware (sign-in)
- Persisted dashboard editing (wheels/prizes CRUD)
- Redemption fulfilment workflow + richer metrics
- More games: scratch tickets, bingo (same prize/fan system)
