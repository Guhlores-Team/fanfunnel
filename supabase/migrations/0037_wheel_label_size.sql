-- Per-wheel prize-label text size (a creator control in the wheel editor, like
-- the existing label color). Stored as a small string ('s' | 'l' | 'xl'); null
-- means Auto (the renderer's smart fit).
--
-- Also re-asserts `label_color` (added in 0025). On projects where the migration
-- history was reconciled — marked applied without the DDL actually running — that
-- column was missing and every wheel save failed. Both adds are `if not exists`,
-- so this is a safe no-op where the columns already exist.
alter table public.wheels add column if not exists label_color text;
alter table public.wheels add column if not exists label_size text;
