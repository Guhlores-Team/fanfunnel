# Deploy & environments (Vercel + Supabase)

`main` **is** production. Every other branch gets a Vercel Preview backed by a
separate **test** database, so changes are exercised for real before they can
reach live data. The binding rules for agents live in [`AGENTS.md`](../AGENTS.md).

## The wiring

| | Production | Preview (every non-`main` branch / PR) | Local dev |
|---|---|---|---|
| Built from | `main` | the branch | your checkout |
| URL | <https://fanfunnel.vercel.app> | `fanfunnel-git-<branch>-easy-simple-sites.vercel.app` (Vercel login required) | <http://localhost:3000> |
| Supabase project | **prod** — ref `ttlogfmogcccwiraaoae` | **test** — ref `snmcrmhgevfqggxdiomu` | none (in-memory mock) unless `.env.local` is set |
| Vercel env vars | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | same 3 (test values) + `ADMIN_EMAILS`, `FF_REQUIRE_SUPABASE` | `.env.local` (copy `.env.example`) |
| Migrations applied by | `supabase-migrations.yml` → `production` job on push to `main` | `supabase-migrations.yml` → `test` job on PR | — |

Vercel project: **`fanfunnel`** in team *Stephen's projects* (`easy-simple-sites`),
Git-connected to `Guhlores-Team/fanfunnel`. Preview deployments are behind Vercel
SSO protection.

## Shipping a change

1. Branch off `main` (never commit to `main` directly — branch protection requires a PR).
2. Open a PR. Automatically:
   - **CI** (`ci.yml` → `verify`): lint, typecheck, `npm test`, build, mock-mode E2E + axe.
   - **E2E (real Supabase)** (`e2e-supabase.yml` → `supabase`): RLS isolation + spin integrity against the **test** DB.
   - **E2E login UI** (`e2e-supabase-ui.yml` → `login-ui`): real `/login` against the **test** DB.
   - **Supabase migrations** (`supabase-migrations.yml` → `test`, only if `supabase/migrations/**` changed): applies new migrations to the **test** DB.
   - **Vercel** builds a Preview on the test DB.
3. Click through the change on the **Preview URL** — CI green is necessary, not sufficient.
4. Merge to `main` → Vercel deploys production, and the `production` migrations job
   applies any new migrations to the **prod** DB.

`verify`, `supabase`, and `login-ui` are required status checks on `main`.

## Database changes

- Add a numbered file to `supabase/migrations/` **and** mirror it into
  `supabase/schema.sql` + `supabase/migrations_combined.sql` — the `sqlSync` unit
  test fails the build if they drift.
- Every table needs RLS + a policy (`rls.test.ts` enforces it). See
  [`SUPABASE_AUTH_CONTRACT.md`](SUPABASE_AUTH_CONTRACT.md).
- DB before code: the migration reaches **test** on the PR and **prod** on merge,
  before the code that needs it serves traffic.

### Bootstrapping a brand-new Supabase project

Only needed for a fresh project (both existing projects are already set up and
their migration history is reconciled):

1. SQL Editor → run [`supabase/schema.sql`](../supabase/schema.sql), **then**
   [`supabase/migrations_combined.sql`](../supabase/migrations_combined.sql). Both
   are idempotent. ⚠ `schema.sql` alone is incomplete.
2. Mark every migration in `supabase/migrations/` as applied so `supabase db push`
   doesn't re-run them — [`auto-migration-reconcile.sql`](auto-migration-reconcile.sql)
   does this for 0001–0035; add rows for any later versions.
3. (Testing) Authentication → Providers → Email → turn off *Confirm email*.
4. Password reset emails need SMTP configured under Authentication → SMTP.

## Secrets & variables

**GitHub → Settings → Secrets and variables → Actions** (repo-level):

| Secret | Used by |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | migrations workflow |
| `SUPABASE_TEST_PROJECT_REF`, `SUPABASE_TEST_DB_PASSWORD` | migrations → test |
| `SUPABASE_PROD_PROJECT_REF`, `SUPABASE_PROD_DB_PASSWORD` | migrations → prod |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | real-Supabase E2E (**test** project values) |

**App env vars:**

| Name | Required | What it does |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes (prod) | Project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes (prod) | Browser key; RLS applies. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes (prod) | **Server-only** (never `NEXT_PUBLIC_`), reachable only via `createServiceClient()` in `src/lib/supabase/server.ts`. |
| `ADMIN_EMAILS` | no | Comma-separated allowlist for the one-time in-app admin claim. Unset = nobody can self-promote; set the role in SQL instead. |
| `FF_REQUIRE_SUPABASE` | no | `1` = fail closed instead of falling back to mock mode. On Vercel production, `VERCEL_ENV=production` already forces this. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | no | Share rate-limit counters across instances (in-memory otherwise). |
| `NEXT_PUBLIC_ENABLE_DEBUG` | no | `1` compiles in the `?debug=1` error console (CI only — keep off in prod). |

## Making someone an admin

```sql
update public.profiles set role = 'admin' where email = 'you@example.com';
```

Roles are read server-side from `profiles` (never from `user_metadata`).

## Rolling back

- **Code:** Vercel → Deployments → pick the last good production deployment →
  *Promote* / *Instant Rollback*. Then revert the bad merge on a branch and PR it.
- **Database:** migrations are forward-only. Write a new migration that undoes the
  change; never edit an applied one.
