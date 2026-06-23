# End-to-end tests

Automated browser coverage of the creator dashboard and fan flow, driven with
the `playwright` package already in `devDependencies` (no test-runner
dependency). It runs against **mock mode** (no Supabase env vars), so it's
deterministic and needs no external services — ideal for CI.

## What it covers

`e2e/journeys.mjs`:

- **Creator** — landing + login render; dashboard loads with all tabs; wheel
  editor recomputes odds on a rarity change and persists a save; create a fan
  account; the merged Analytics tab shows both performance and deep-analytics
  sections; the leaderboard toggle succeeds with no error toast; and the in-app
  debug console captured **zero** errors during the whole creator flow.
- **Fan** — age gate appears; the leaderboard renders before any spin; a spin
  decrements the balance and shows a win; the provably-fair verify page reports
  "Hash matches"; the link-in-bio page renders.

Throughout, the harness (`e2e/harness.mjs`) attaches an error **sink** that
captures `pageerror`, `console.error`/`warning`, failed requests, and
unexpected 4xx/5xx responses — each attributed to the step in progress. Benign
noise (`?_rsc=` prefetch aborts, expected spin 409/429/403) is filtered out. The
run **fails** if any step assertion fails *or* any genuine signal is captured.

## Run it

```bash
npm run build      # the suite serves the production build
npm run e2e        # boots `next start` on :3100, runs, tears down
```

Against an already-running server or a deployed preview:

```bash
E2E_BASE_URL=https://your-preview.vercel.app node e2e/run.mjs
```

A full-page screenshot of the final state is written to `e2e/artifacts/` on
failure (gitignored).

## Real-Supabase integration tests

`e2e/supabase.mjs` covers the security-critical behavior that mock mode
**cannot** — RLS tenant isolation and the SECURITY DEFINER self-update RPCs
(the class of the prod-only chat-settings bug). Headless (no browser): it
creates two ephemeral creator accounts via the admin API, signs them in, and
asserts that creator A can't read/update/delete creator B's data, that the
`set_chat_settings` / `set_leaderboard_enabled` / `set_onboarding_dismissed`
RPCs only ever touch the caller's own profile, and that a creator can't
self-promote to admin. It deletes both users (cascading their rows) afterward.

It **skips cleanly** (exit 0) when Supabase env vars are absent.

```bash
npm run e2e:supabase   # skips unless the three env vars below are set
```

Point it at a **dedicated test/preview** Supabase project (NOT production — it
creates and deletes users) whose `schema.sql` (incl. the latest migration) is
applied, and set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
and `SUPABASE_SERVICE_ROLE_KEY`. In CI it runs as the **`E2E (real Supabase)`**
workflow, gated on repo secrets of the same names (a no-op until you add them;
also runnable on demand via workflow_dispatch).

## Scope / limits

The mock E2E + the real-Supabase tests cover the automatable bulk. The
irreducibly human checks (real audio/haptics, payments/auth, file upload,
visual polish) live in [`MANUAL-CHECKLIST.md`](./MANUAL-CHECKLIST.md).
