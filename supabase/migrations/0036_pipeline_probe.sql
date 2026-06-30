-- Migration-pipeline probe (Phase 7): proves the auto-apply workflow reaches
-- both the TEST project (on PR) and PROD (on merge to main). Intentionally a
-- harmless no-op — it records version 0036 in schema_migrations without
-- changing any table, function, or trigger, so it touches neither RLS nor the
-- schema/combined sync guards. Safe to leave in place after verification.
comment on schema public is 'fanfunnel — migration pipeline verified (0036 probe)';
