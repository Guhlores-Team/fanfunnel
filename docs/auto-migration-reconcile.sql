-- One-time migration-history reconciliation for auto-migrations.
-- Your 0001-0035 migrations were applied by MANUAL SQL paste, so Supabase's
-- migration-history table doesn't know they're applied. This marks them as
-- applied so 'supabase db push' SKIPS them and only runs FUTURE migrations.
--
-- RUN ONCE in the TEST project SQL editor, and ONCE in the PROD project.
-- Safe + idempotent: creates the history table if missing, inserts versions,
-- and does nothing for versions already recorded.

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key,
  statements text[],
  name text
);
-- Deny client access. The migration CLI uses the direct DB connection (which
-- bypasses RLS), and this internal schema isn't exposed to the API anyway — but
-- this satisfies the SQL advisor and matches the "RLS on every table" rule.
-- No policy = no client access.
alter table supabase_migrations.schema_migrations enable row level security;

insert into supabase_migrations.schema_migrations (version) values
  ('0001'),
  ('0002'),
  ('0003'),
  ('0004'),
  ('0005'),
  ('0006'),
  ('0007'),
  ('0008'),
  ('0009'),
  ('0010'),
  ('0011'),
  ('0012'),
  ('0013'),
  ('0014'),
  ('0015'),
  ('0016'),
  ('0017'),
  ('0018'),
  ('0019'),
  ('0020'),
  ('0021'),
  ('0022'),
  ('0023'),
  ('0024'),
  ('0025'),
  ('0026'),
  ('0027'),
  ('0028'),
  ('0029'),
  ('0030'),
  ('0031'),
  ('0032'),
  ('0033'),
  ('0034'),
  ('0035')
on conflict (version) do nothing;
