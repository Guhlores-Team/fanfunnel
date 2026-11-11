# TEST fixture commands

These commands create and delete sample data. They refuse every Supabase host
except the dedicated TEST project `snmcrmhgevfqggxdiomu.supabase.co`.
Production is never an allowed target.

## Hosted integration tests

`npm run e2e:supabase` and `npm run e2e:spin` use the existing secret-gated CI
environment. Locally, configure `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` through your
private environment before running them. Never paste their values into chat or
commit them. Missing credentials still produce the existing explicit skip;
configured credentials for an incorrect project cause failure before writes.

The tests approve their temporary creator, sign in as that actual creator and
pass its actor ID to `create_pass_grant`. Credits and grants are created together.
A deterministic single-common-prize fixture uses `prepare_spin_attempt` and
`commit_spin_attempt`, including real credit, seed, stock and receipt writes.
It deliberately refuses multiple eligible prizes or focus, so it cannot become
a second probabilistic game engine. Contention retries retain the same UUID.
The seven existing integrity scenarios remain: concurrent spending, empty
balance, self-exclusion, blocked fan, inactive pass, in-row rate cap, and
per-wheel isolation. Same-ID receipts and fan/pass balance parity are also
asserted. These suites do not need a running application server.

## Agency demo seed

`scripts/seed-agency.mjs` resets only its named sample accounts and recreates
their agency, staff scopes, pending invitation, wheel, fans, revenue and wins.
It resets sample passwords and prints the generated credentials locally.
Use a private terminal and keep that output out of shared logs.

Prerequisites:

- Apply all current migrations to TEST first, using the verified migration
  workflow. Do not run a new source version against an older schema.
- Configure the three TEST variables above in an uncommitted `.env.local`.
  Use the existing supported secret setup, with restrictive file permissions.
- Use a separate local port from any verification server. Start the exact
  source being seeded, with demo mode disabled, in one terminal:

```bash
NEXT_PUBLIC_ENABLE_DEBUG=0 npm run dev -- --hostname 127.0.0.1 --port 3202
```

Once that server is ready, run in another terminal from the same checkout:

```bash
FANFUNNEL_TEST_BASE_URL=http://127.0.0.1:3202 node scripts/seed-agency.mjs
```

The seed loads `.env.local` itself. `FANFUNNEL_TEST_BASE_URL` is mandatory and
accepts only a loopback HTTP origin. Grants go through the durable RPC as a
signed-in approved fixture creator. Consent and each multi-prize win go through
the actual local fan API, so the real engine selects the outcome and the atomic
ledger records it. Every win is reconciled through `/api/spin/status`; the final
remaining balance is checked. A server configured to another database cannot
resolve the random TEST-only pass token and the seed fails. A network failure
does not trigger a fresh paid-play identity: the seed stops for inspection.

Do not run these commands against hosted Preview or Production URLs. Seeding
is an explicit local maintenance operation, separate from release verification.
