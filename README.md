# 🎡 FanFunnel

[![CI](https://github.com/Guhlores-Team/fanfunnel/actions/workflows/ci.yml/badge.svg)](https://github.com/Guhlores-Team/fanfunnel/actions/workflows/ci.yml)
[![E2E (real Supabase)](https://github.com/Guhlores-Team/fanfunnel/actions/workflows/e2e-supabase.yml/badge.svg)](https://github.com/Guhlores-Team/fanfunnel/actions/workflows/e2e-supabase.yml)

Personalized prize-wheel games for creators. A creator sends each fan a
**unique link**; the fan spins and **always wins something** — but the rare
drops are what keep them coming back. Built for a creator's existing audience
(link-in-DM), with the wheel as game #1 of a planned suite (scratch tickets,
bingo, …).

> **No gambling, no payment processing in-app.** Fans tip the creator on their
> existing platform; the creator grants spins. Every spin yields a guaranteed
> reward, which keeps this out of lottery/gambling regulation and away from
> payment-processor bans.

**Live:** <https://fanfunnel.vercel.app> · **Stack:** Next.js 16 (App Router) ·
React 19 · Tailwind v4 · Supabase (Postgres + Auth + RLS) · Vercel

---

## Where things stand

| | |
|---|---|
| **Production** | Live on `main`. Last shipped 2026-07-02 (security audit + wheel-label fixes); CI green. |
| **In progress** | **Creator Command Center redesign** — sidebar + top-bar dashboard replacing the 8-tab layout. Design handoff: [`docs/design/command-center/`](docs/design/command-center/). Phase 1 (tokens + contrast fix) exists on `dashboard-redesign`; phases 2–8 not started. |
| **Before the next prod release** | Live smoke test on prod (see [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md)); as of 2026-06-30 the test DB had no admin user. |

## How it works

| Role | What they do | What they see |
| --- | --- | --- |
| **Admin** | Manage every account, grant features, see all metrics. Also a full creator. | Everything |
| **Creator** | Build wheels, set prizes + rarity + stock, mint fan links, grant spins, fulfil wins, chat with fans. | Their own workspace |
| **Fan** | Open their link, spin, claim prizes. **No account, no login.** | Only their own spins + wins |

**Spin outcomes are decided on the server**, weighted by rarity and limited
stock, and are provably fair (commit-reveal; fans can verify at `/verify/…`).
The browser only animates the wheel to the result the server already chose.

---

## Quick start (zero config)

```bash
npm ci
npm run dev
```

Open <http://localhost:3000> — `/spin/demo` is a working demo wheel, `/dashboard`
is the creator dashboard, `/admin` the admin panel. With no env vars set,
everything runs against an in-memory store that re-seeds on restart; links you
mint really spin.

To run against a real database, copy `.env.example` → `.env.local` and point it
at the **test** Supabase project (never prod).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server (mock mode unless `.env.local` is set) |
| `npm run lint` · `npm run typecheck` | ESLint · `tsc --noEmit` |
| `npm test` | Unit tests + **RLS security lint** + SQL-sync guard (13 files) |
| `npm run build` | Production build |
| `npm run e2e` · `npm run e2e:a11y` | Playwright creator/fan journeys · axe a11y (needs a running server; set `E2E_BASE_URL`) |
| `npm run e2e:supabase` · `npm run e2e:spin` · `npm run e2e:login` | Real-Supabase RLS isolation · concurrent spin integrity · real `/login` (need test-DB env) |
| `node scripts/security/rls-runtime-test.mjs` | Runtime proof a normal user can't self-promote or cross tenants (test DB) |

## Shipping: test on Preview before prod

```
branch off main ──► PR ──► CI (verify · supabase · login-ui) + Vercel Preview on the TEST database
                                   │
                    click through it on the Preview URL
                                   │
                    merge to main ──► Vercel production + migrations applied to PROD
```

`main` is production — nothing reaches it without green CI **and** a verified
Preview. Full wiring (env scoping, secrets, migrations, rollback):
[`docs/DEPLOY.md`](docs/DEPLOY.md). Rules for coding agents: [`AGENTS.md`](AGENTS.md).

---

## Architecture

```
src/
  app/                    App Router
    spin/[token]/         Fan spin page (the fan's whole world)
    c/[slug]/ share/ verify/ leaderboard/   Public creator page, share cards, fairness proof, leaderboard
    dashboard/ admin/ agency/ pending/      Creator dashboard, admin panel, agency view, approval gate
    login/ forgot-password/ reset-password/ auth/   Auth flows
    api/                  ~77 route handlers (spin, wheels, passes, fans, messages, admin, account…)
  proxy.ts                Session refresh + /dashboard guard (Next 16's renamed middleware)
  components/             Wheel.tsx (canvas), SpinClient (fan UX), dashboard/* panels, ui/ primitives
  lib/
    games/wheel/          Framework-free wheel engine + provably-fair (heavily unit-tested)
    data/                 Data access — Supabase when configured, in-memory mock otherwise
    supabase/             Browser / server / service-role clients (service key is server-only)
    api/  hooks/  security/  rateLimit.ts  theme.ts  sound.ts
supabase/
  migrations/             0001–0038, auto-applied by CI (test on PR, prod on merge)
  schema.sql              Base schema + RLS (fresh projects: run this, then migrations_combined.sql)
  migrations_combined.sql Every migration, idempotent
  reset.sql               Wipe app data, keep tables + logins
```

Security model: every table has RLS; roles live in `profiles` and are read via
SECURITY DEFINER `is_admin()` / `can_act_for()`; the service-role key never
reaches the browser. Details: [`SECURITY.md`](SECURITY.md) ·
[`docs/SUPABASE_AUTH_CONTRACT.md`](docs/SUPABASE_AUTH_CONTRACT.md).

## Docs

| Doc | For |
|---|---|
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Environments, CI, migrations, secrets, rollback |
| [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) | Pre-release review findings + checklist |
| [`docs/design/command-center/`](docs/design/command-center/) | Dashboard redesign handoff (spec, porting plan, prototypes, screenshots) |
| [`docs/BRANCHES.md`](docs/BRANCHES.md) | Branch audit (Oct 2026) and what's kept / archived |
| [`docs/autopilot/`](docs/autopilot/) | **Start here when resuming:** ordered [backlog](docs/autopilot/BACKLOG.md), [owner actions](docs/autopilot/OWNER_ACTIONS.md), goal prompts for the autopilot + security audit |
| [`SECURITY.md`](SECURITY.md) · [`docs/SUPABASE_AUTH_CONTRACT.md`](docs/SUPABASE_AUTH_CONTRACT.md) | Security model, auth rules |
| [`PRODUCT.md`](PRODUCT.md) · [`DESIGN.md`](DESIGN.md) | Product context + current design system (read by design tooling) |
| [`e2e/README.md`](e2e/README.md) · [`scripts/TESTING.md`](scripts/TESTING.md) | Test suites |
| [`docs/archive/`](docs/archive/) | Shipped plans, past audits — historical only |

## Known open items

The full ordered queue is [`docs/autopilot/BACKLOG.md`](docs/autopilot/BACKLOG.md). Headlines:

- **Redesign port** — phases 2–8 of the [porting checklist](docs/design/command-center/PORTING_CHECKLIST.md).
- **Full security audit** (after the redesign) — [`docs/autopilot/SECURITY_AUDIT_PROMPT.md`](docs/autopilot/SECURITY_AUDIT_PROMPT.md).
- **Prod smoke test + test-DB admin** — never completed after the June infra setup.
- **Generated DB types** — `npm run gen:types` exists but `src/lib/data/db.types.ts` was never generated.
- **Split `src/lib/data/index.ts`** (~6k lines) and unify its error convention.
- **`rls-runtime-test.mjs` isn't in CI** — runs only by hand today.
- Small cleanups: unused `src/components/fan/ReferralWidget.tsx`; two `clientIp` helpers
  (`src/lib/api/limit.ts`, `src/lib/api/clientIp.ts`) with different header precedence.
