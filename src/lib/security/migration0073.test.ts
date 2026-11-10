import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// 0073 (batch-7 hardening): the static half of the negative tests. The live
// behaviour runs in scripts/db/batch7Probe.mjs (drift check) and in
// scripts/security/rls-runtime-test.mjs (hosted); this file pins the SQL text
// every reviewer reads: the seat-scoped read policies, the immutable
// creator_id trigger on every creator-owned table, the revoked direct writes,
// the retention rules, the reset that deletes its own fans, the app side of
// CC-01, the schema version and that both snapshots carry the same text.

const ROOT = join(import.meta.dirname, "../../..");
const SUPABASE = join(ROOT, "supabase");
const files = readdirSync(join(SUPABASE, "migrations")).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const latest = files.at(-1) ?? "";
const migration = readFileSync(join(SUPABASE, "migrations", latest), "utf8");
const schema = readFileSync(join(SUPABASE, "schema.sql"), "utf8");
const combined = readFileSync(join(SUPABASE, "migrations_combined.sql"), "utf8");
const accountTs = readFileSync(join(ROOT, "src/lib/data/account.ts"), "utf8");

let passed = 0;
const check = (label: string, value: unknown) => { assert.ok(value, label); passed++; };
const lastDef = (sql: string, name: string) => {
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\([\\s\\S]*?\\$\\$;`, "gi");
  return [...sql.matchAll(re)].at(-1)?.[0] ?? "";
};

check("the newest migration is 0073", latest.startsWith("0073_"));
check("0073 ends on schema_version() = 73", /select 73 \$\$;/.test(migration));
for (const [name, snapshot] of [["schema.sql", schema], ["migrations_combined.sql", combined]] as const) {
  check(`${name} carries the whole 0073 text`, snapshot.includes(migration.trimEnd()));
  check(`${name} appends 0073 once, after its marker`, snapshot.split("-- Migration0073: ").length === 2);
}

// ATK-05: the four read policies follow the seat's job; the creator keeps its own rows.
for (const [table, job] of [["messages", "chat"], ["redemptions", "fulfil"], ["grants", "grant"], ["spin_attempts", "grant"]]) {
  const policy = new RegExp(`create policy ${table}_select on public\\.${table} for select[^;]*using \\(\\(creator_id = \\(select auth\\.uid\\(\\)\\) and public\\.can_act_for\\(creator_id, 'view'\\)\\)\\s*or public\\.can_act_for\\(creator_id, '${job}'\\) or public\\.is_admin\\(\\)\\);`);
  check(`ATK-05: ${table}_select is scoped to '${job}' plus the creator's own view`, policy.test(migration));
  check(`ATK-05: ${table}_select is dropped before it is recreated`, migration.includes(`drop policy if exists ${table}_select on public.${table};`));
}

// DB-01: one trigger function, attached by a catalog loop to every table with creator_id.
check("DB-01: _guard_creator_immutable raises 42501", /creator_id is immutable' using errcode = '42501'/.test(lastDef(migration, "_guard_creator_immutable")));
check("DB-01: the trigger is attached to every public table with a creator_id column", /a\.attname = 'creator_id'[\s\S]*create trigger zz_creator_immutable before update of creator_id on public\.%I/.test(migration));
check("DB-01: the account-deletion SET NULL still passes (old creator's profile gone)", /new\.creator_id is null and not exists \(select 1 from public\.profiles p where p\.id = old\.creator_id\)/.test(migration));

// DB-05 / DB-09 / DB-16: the session role lost the direct writes.
for (const grant of [
  "revoke update, delete on public.prizes from authenticated;",
  "revoke delete on public.creator_reports from authenticated;",
  "revoke insert, delete on public.profiles from authenticated;",
  "revoke insert, update, delete on public.spins from authenticated;",
  "revoke delete on public.creator_applications from authenticated;",
]) check(`revoked: ${grant}`, migration.includes(grant));

// DB-02: an applicant's insert is pinned by a BEFORE INSERT trigger.
const pin = lastDef(migration, "_guard_creator_application_insert");
check("DB-02: the pin takes profile_id, e-mail, status and dates from the server", /new\.profile_id := auth\.uid\(\);[\s\S]*new\.email := \(select u\.email from auth\.users u[\s\S]*new\.status := 'pending';[\s\S]*new\.decided_at := null;/.test(pin));
check("DB-02: one request per account", migration.includes("add constraint creator_applications_profile_id_key unique (profile_id)"));

// DB-03: thirty free-text CHECKs; the two setters validate like the routes.
check("DB-03: 30 text caps are declared", (migration.match(/_len_check'|_shape_check'/g) ?? []).length === 30);
check("DB-03: set_chat_settings refuses over-long or non-printable text", /invalid chat settings' using errcode = '22023'/.test(lastDef(migration, "set_chat_settings")));
check("DB-03: set_creator_note refuses over-long or non-printable text", /invalid creator note' using errcode = '22023'/.test(lastDef(migration, "set_creator_note")));

// TS-03: reserved names.
const reserved = lastDef(migration, "_reserved_name");
check("TS-03: the whole name is compared with separators stripped ('fan-funnel', 'fan_funnel', 'fan.funnel' are 'fanfunnel')", /regexp_replace\(regexp_replace\(coalesce\(p, ''\), '\^\\s\*@', ''\), '\[\\s\._-\]\+', '', 'g'\)/.test(reserved) && /n\.whole like '%fanfunnel%'/.test(reserved));
for (const word of ["fanfunnel", "support", "admin", "administrator", "staff", "official", "moderator", "mod", "help", "security", "billing", "verify", "team", "system", "root", "api", "www", "mail", "abuse", "legal", "privacy", "terms"]) {
  check(`TS-03: '${word}' is reserved`, new RegExp(`'${word}'`).test(reserved));
}
check("TS-03: set_display_name refuses a reserved name", /reserved display name/.test(lastDef(migration, "set_display_name")));
check("TS-03: set_public_profile and the profile guard refuse a reserved slug", /reserved slug/.test(lastDef(migration, "set_public_profile")) && /reserved slug/.test(lastDef(migration, "_guard_profile_public_fields")));

// DB-06 / DB-04 / CC-08 / DB-08: tombstones and retention.
check("DB-06: a deleted fan's link tokens are tombstoned", /insert into public\.link_tombstones \(token_hash, reason\)[\s\S]*'fan_deleted'/.test(lastDef(migration, "scrub_fan_traces")));
const retention = lastDef(migration, "run_retention_cleanup");
check("retention keeps its 5-argument signature", /run_retention_cleanup\(\s*p_app_error_days integer[\s\S]*p_tombstone_days integer/.test(retention) && retention.includes("p_notice_days") && retention.includes("p_closed_invite_days") && retention.includes("p_audit_days"));
check("DB-04: declined access requests go after 90 days", /v_declined_application_days constant integer := 90;/.test(retention) && /status = 'rejected'[\s\S]*decided_at < now\(\) - make_interval\(days => v_declined_application_days\)/.test(retention));
check("CC-08: pending attempts older than a day are declined as stale", /v_pending_attempt_days constant integer := 1;/.test(retention) && /set state = 'declined', error = 'stale'/.test(retention));
check("DB-08: retention and the storage prune take the same advisory lock", /pg_advisory_xact_lock\(hashtextextended\('fanfunnel-retention', 0\)\)/.test(retention) && /pg_advisory_xact_lock\(hashtextextended\('fanfunnel-retention', 0\)\)/.test(lastDef(migration, "creator_storage_prune")));
check("retention reports the new counts", ["'stale_spin_attempts'", "'declined_applications'", "'declined_applicant_ids'"].every((k) => retention.includes(k)));

// CC-01: the reset deletes its fans under the pre-locks; the route no longer does.
check("CC-01: reset_creator_content deletes the fans after its pre-locks", /for update;\s*[\s\S]*delete from public\.fans where creator_id = p_creator;\s*[\s\S]*delete from public\.fan_passes where creator_id = p_creator;/.test(lastDef(migration, "reset_creator_content")));
check("CC-01: account.ts no longer deletes fans from the session", !/from\("fans"\)\.delete\(\)/.test(accountTs));
check("CC-01: account.ts still calls the service reset", /rpc\("reset_creator_content"/.test(accountTs));

// CC-02 / RS-01 / PR-13: attempt outcomes and link expiry.
for (const fn of ["commit_spin_attempt", "cancel_spin_attempt", "prepare_spin_attempt"]) {
  const body = lastDef(migration, fn);
  check(`CC-02: ${fn} declines a prepared attempt whose link went away as blocked`, /set state='declined',error='blocked',finished_at=now\(\) where id=p_attempt and state='pending'/.test(body));
  check(`PR-13: ${fn} honours fan_passes.expires_at`, /p\.expires_at is null or p\.expires_at>now\(\)/.test(body));
}
check("RS-01: get_spin_attempt_status answers not_found only when no link carries the token", /if not exists\(select 1 from public\.fan_passes p where p\.token=p_token\) then\s*return jsonb_build_object\('status','not_found'\);/.test(lastDef(migration, "get_spin_attempt_status")));

// CC-03 / CC-04 / CC-05 / CC-07: the post-lock rechecks.
for (const fn of ["set_redemption_state", "archive_wheel", "delete_wheel", "delete_campaign"]) check(`CC-03: ${fn} re-checks authority after its last lock`, lastDef(migration, fn).includes("0073 (CC-03)"));
check("CC-04: _creator_actor_allowed holds the seat row for key share", /for key share of m/.test(lastDef(migration, "_creator_actor_allowed")));
for (const fn of ["save_wheel_prizes", "set_prize_delivery", "add_reward_codes"]) check(`CC-05: ${fn} refuses a suspended creator after its locks`, /creator_unavailable' using errcode = '42501'/.test(lastDef(migration, fn)));
check("CC-07: _lock_wheel_lifecycle pre-locks the fans' links", /from public\.fan_passes where fan_id in\(select fan_id from public\.fan_focus[\s\S]*for update nowait;/.test(lastDef(migration, "_lock_wheel_lifecycle")));

// WG-02 / WG-07 / TS-01 / TS-05 / TS-06 / DB-15.
check("WG-02: org_create seats its owner", /insert into public\.org_members \(org_id, profile_id, role\) values \(v_id, auth\.uid\(\), 'owner'\)/.test(lastDef(migration, "org_create")));
check("WG-02: the owner seat is backfilled for existing agencies", /select o\.id, o\.owner_id, 'owner' from public\.orgs o[\s\S]*on conflict \(org_id, profile_id\) do nothing/.test(migration));
check("WG-07: messages and redemptions carry actor_id", migration.includes("alter table public.messages add column if not exists actor_id uuid references public.profiles(id) on delete set null;") && migration.includes("alter table public.redemptions add column if not exists actor_id uuid references public.profiles(id) on delete set null;"));
check("TS-01: legal_terms_version() is 2026-11-11", /legal_terms_version\(\)\s*returns text[^$]*\$\$\s*select '2026-11-11'/.test(migration));
check("TS-05: consent evidence is a service-written, admin-read table", migration.includes("create table if not exists public.fan_consent_evidence (") && /create policy fan_consent_evidence_admin on public\.fan_consent_evidence for select\s*using \(public\.is_admin\(\)\)/.test(migration) && migration.includes("grant execute on function public.record_fan_ack(text, text, text) to service_role;") && migration.includes("revoke execute on function public.record_fan_ack(text, text, text) from public, anon, authenticated;"));
check("TS-06: the Terms notice is a policy-protected singleton", migration.includes("create table if not exists public.legal_terms_notice (") && /create policy legal_terms_notice_admin_write on public\.legal_terms_notice for update\s*using \(public\.is_admin\(\)\) with check \(public\.is_admin\(\)\)/.test(migration));
check("0073 adds no signed-in SECURITY DEFINER function (the 0072 closing check must replay)", !/security definer[\s\S]{0,400}grant execute on function public\.(creator_obligations|creator_fan_summaries|creator_analytics_summary|legal_terms_upcoming|set_legal_terms_notice)\([^)]*\) to authenticated/.test(migration) && /legal_terms_upcoming\(\)\s*returns jsonb language sql stable security invoker/.test(migration));
check("DB-15: every function pinning 'public' alone gains pg_temp", /p\.proconfig = array\['search_path=public'\][\s\S]*set search_path = public, pg_temp/.test(migration));
check("no new policy is wide open", !/using \(true\)|with check \(true\)/.test(migration));

console.log(`migration 0073 guard: ${passed} checks passed`);
