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

## Scope / limits

This is the automatable ~85–90%. The irreducibly human checks (real audio,
real payments/auth, live-Supabase data, visual polish) live in
[`MANUAL-CHECKLIST.md`](./MANUAL-CHECKLIST.md).
