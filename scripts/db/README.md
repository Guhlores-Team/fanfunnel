# scripts/db

`node scripts/db/schema-drift-check.mjs` — builds the database from `supabase/migrations/`
(on the original base schema), from `supabase/schema.sql` alone, and from
`schema.sql` + `migrations_combined.sql` (once and twice) on a throwaway local
Postgres 16 (needs `initdb`/`pg_ctl`/`psql`; no TCP port, deleted afterwards),
then diffs tables, columns, constraints, indexes, functions, triggers, policies,
grants and comments. Exit 0 means all three ways build the same database. Runs
in CI (`schema-drift` job) and alongside the static `npm test` guard in
`src/lib/security/sqlSync.test.ts`. `--keep` leaves the cluster running for inspection.
