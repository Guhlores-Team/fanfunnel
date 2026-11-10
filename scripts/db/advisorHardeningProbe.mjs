// @ts-check
// 0072 advisor-hardening probe. Run by schema-drift-check.mjs on every build
// path against a throwaway local Postgres, acting as real `anon`,
// `authenticated` and `service_role` sessions through the live grants,
// policies and triggers (the stub carries Supabase's default grants). Every
// check runs in its own transaction that is rolled back.
//
//  - Privileges: anon executes no SECURITY DEFINER function; authenticated
//    executes exactly the reviewed list (the RLS helpers and the self-service
//    RPCs); trigger functions and the service-only functions are refused to
//    both browser roles by a real call, and the service role keeps them.
//  - The helpers still work inside policies: a creator reads its own rows and
//    writes its own push device through policies that call is_admin(),
//    current_user_active(), can_act_for() and _owns_org(); a cross-tenant read
//    or write through those same (wrapped) policies is still refused.
//  - Revoked trigger functions still fire for a session write.
//  - The 32 rewritten policies equal their 0071 text with only auth.uid() /
//    auth.role() wrapped in a scalar subquery (advisor-0072-policies.json), and
//    no policy in public calls auth.uid()/auth.role()/auth.jwt() per row.
//  - Every foreign key in public has a covering index; every public function
//    pins its search_path (extension members, e.g. pgcrypto installed in
//    public by the --crypto-schema public fixture, are the extension's own).
// Against the 0071 schema the privilege, wrapping, index and search_path
// checks fail.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const id = (n) => `00000000-0000-4000-8000-0000000072${n}`;
const A = id("a1"), B = id("b1"), ORG_B = id("e1"), WA = id("f1"), PA = id("c1"), FA = id("d1"), SUB_B = id("91");
const PASS_A = id("81"), SPIN_A = id("71"), RED_A = id("61");

/** The SECURITY DEFINER functions a signed-in session may execute (0072 header). */
export const AUTHENTICATED_DEFINER = [
  "_is_org_member(uuid)", "_my_confirmed_email()", "_owns_org(uuid)", "_owns_org_seat(uuid)",
  "admin_account_stats()", "archive_wheel(uuid)", "can_act_for(uuid, text)", "creator_link_pass(text)",
  "creator_link_tokens(uuid, uuid)",
  "creator_redemption_queue(text, text, timestamp with time zone, uuid, integer, uuid, uuid)",
  "current_user_active()", "delete_campaign(uuid, uuid)", "delete_wheel(uuid)", "is_admin()",
  "issue_creator_actor_context(uuid, text)", "my_seat_creators(integer)", "org_account_stats(uuid)",
  "org_add_member(uuid, text, org_role)", "org_create(text)", "org_invite_creator(uuid, text)",
  "org_invite_respond(uuid, boolean)", "org_invite_revoke(uuid)", "org_leave(uuid)",
  "org_remove_creator(uuid, uuid)", "org_remove_member(uuid)", "org_scope_creator(uuid, uuid, boolean)",
  "set_chat_settings(text, text)", "set_creator_note(text, text)", "set_creator_theme(jsonb)",
  "set_display_name(text)", "set_leaderboard_enabled(boolean)", "set_notification_prefs(boolean, boolean, boolean)",
  "set_notifications_seen()", "set_onboarding_dismissed(boolean)", "set_public_profile(text, text, text)",
  "set_pwa_icon_mode(text)", "set_redemption_state(uuid, uuid, jsonb)", "wipe_my_spin_attempts()",
];
/** Advisor: anon could execute these on TEST at 0071. */
export const ANON_REVOKED = [
  "_is_org_member(uuid)", "_owns_org(uuid)", "_owns_org_seat(uuid)", "attach_spin_reward()", "can_act_for(uuid, text)",
  "current_user_active()", "erase_fan_reward_values()", "guard_delivered_redemption()", "handle_new_user()", "is_admin()",
  "org_add_creator(uuid, text)", "sync_code_prize_stock()", "sync_fan_spin_aggregate()",
];
/** Not for any browser role: triggers and the two functions without an app caller. */
export const SERVICE_ONLY = [
  "admin_reserve_account_deletion(uuid)", "org_add_creator(uuid, text)",
  "attach_spin_reward()", "erase_fan_reward_values()", "guard_delivered_redemption()", "handle_new_user()",
  "sync_code_prize_stock()", "sync_fan_spin_aggregate()", "guard_fan_break()", "admin_audit_log_immutable()",
];

const SEED = `
  insert into auth.users (id, email, email_confirmed_at) values ('${A}', 'probe-0072-a@example.test', now()), ('${B}', 'probe-0072-b@example.test', now());
  update public.profiles set is_active = true, approval_status = 'approved' where id in ('${A}', '${B}');
  insert into public.orgs (id, name, owner_id) values ('${ORG_B}', 'probe 0072 org', '${B}');
  insert into public.wheels (id, creator_id, title) values ('${WA}', '${A}', 'probe 0072');
  insert into public.prizes (id, wheel_id, label, rarity, weight) values ('${PA}', '${WA}', 'one', 'common', 10), ('${id("c2")}', '${WA}', 'two', 'common', 10);
  insert into public.fans (id, creator_id, display_name) values ('${FA}', '${A}', 'Fan A');
  insert into public.push_subscriptions (id, user_id, endpoint, p256dh, auth) values ('${SUB_B}', '${B}', 'https://push.example.test/0072-b', 'k', 'a');
  insert into public.fan_passes (id, token, creator_id, wheel_id, fan_id) values ('${PASS_A}', 'probe-0072-pass', '${A}', '${WA}', '${FA}');
  set local fanfunnel.economic_write = 'on';
  insert into public.spins (id, fan_pass_id, creator_id, wheel_id, fan_id, prize_id, prize_label, prize_rarity)
    values ('${SPIN_A}', '${PASS_A}', '${A}', '${WA}', '${FA}', '${PA}', 'one', 'common');
  set local fanfunnel.economic_write = 'off';
  insert into public.redemptions (id, creator_id, spin_id, notes, due_at) values ('${RED_A}', '${A}', '${SPIN_A}', 'ship to the home address', now() + interval '3 days');`;
const as = (uid, stmt) =>
  `set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true);` +
  ` select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated","aal":"aal1"}', true); ${stmt} reset role;` +
  ` select set_config('request.jwt.claim.sub', '', true); select set_config('request.jwt.claims', '', true);`;
const call = (sig) => {
  const name = sig.slice(0, sig.indexOf("("));
  const types = sig.slice(sig.indexOf("(") + 1, -1).split(",").map((t) => t.trim()).filter(Boolean);
  return { name, sql: `select public.${name}(${types.map((t) => `null::${t}`).join(", ")});` };
};

/**
 * @param {string} db
 * @param {(db: string, extra: string[], opts?: { allowFail?: boolean }) => import("node:child_process").SpawnSyncReturns<string>} psql
 * @returns {{ bad: string[], checks: number }}
 */
export function probeAdvisorHardening(db, psql) {
  const bad = [];
  let checks = 0;
  const run = (body) => psql(db, ["-c", `begin; ${SEED} ${body} rollback;`], { allowFail: true });
  const q = (sql) => (psql(db, ["-c", sql], { allowFail: true }).stdout || "").trim();
  const out = (r) => (r.stdout || "").split("\n").map((l) => l.trim());
  const err = (r) => (r.stderr || "no error").trim().split("\n").find((l) => /ERROR/.test(l)) ?? (r.stderr || "no error").trim();
  const expect = (label, body, want) => {
    checks++;
    const r = run(body);
    const got = out(r);
    const missing = want.filter((w) => !got.includes(w));
    if (r.status !== 0 || missing.length) bad.push(`${label} (missing ${missing.join(" | ") || "-"}; got ${got.filter((l) => /:/.test(l)).join(" | ")}; ${r.status !== 0 ? err(r) : "ok"})`);
  };
  const refused = (label, body, pattern) => {
    checks++;
    const r = run(body);
    if (!pattern.test(r.stderr || "")) bad.push(`${label} was not refused (${err(r)}; out ${out(r).filter(Boolean).join(" ")})`);
  };
  const same = (label, got, want) => {
    checks++;
    if (got !== want) bad.push(`${label}: expected ${want}, got ${got}`);
  };

  // ── privileges, from the catalog ───────────────────────────────────────────
  const definer = (role) => q(`select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef and has_function_privilege('${role}', p.oid, 'EXECUTE')`).split("\n").filter(Boolean).sort().join(";");
  same("anon executes no SECURITY DEFINER function", definer("anon"), "");
  same("authenticated executes exactly the reviewed SECURITY DEFINER list", definer("authenticated"), [...AUTHENTICATED_DEFINER].sort().join(";"));
  same("no trigger function is executable by a browser role", q(`select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.prorettype = 'trigger'::regtype and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))`), "0");
  for (const sig of SERVICE_ONLY) {
    same(`service_role keeps EXECUTE on ${sig}`, q(`select has_function_privilege('service_role', 'public.${sig}', 'EXECUTE')`), "t");
  }

  // ── privileges, by real calls ─────────────────────────────────────────────
  for (const sig of ANON_REVOKED) {
    const c = call(sig);
    refused(`anon calls ${sig}`, `set local role anon; ${c.sql}`, new RegExp(`permission denied for function ${c.name}\\b`));
  }
  for (const sig of SERVICE_ONLY) {
    const c = call(sig);
    refused(`a creator calls ${sig}`, as(A, c.sql), new RegExp(`permission denied for function ${c.name}\\b`));
  }
  // anon never evaluates a policy: its read stops at the table grant.
  for (const table of ["profiles", "orgs", "push_subscriptions", "spins"]) {
    refused(`anon reads ${table}`, `set local role anon; select count(*) from public.${table};`, new RegExp(`permission denied for table ${table}\\b`));
  }

  // ── the helpers still work for a signed-in creator, inside and outside policies
  expect("a normal creator still calls the helpers and a self-service RPC", as(A, `
    select 'admin:' || public.is_admin();
    select 'active:' || public.current_user_active();
    select 'own-view:' || public.can_act_for('${A}', 'view');
    select 'other-view:' || public.can_act_for('${B}', 'view');
    select 'owns-b-org:' || public._owns_org('${ORG_B}');
    select public.set_display_name('Probe 0072');`) + ` select 'name:' || display_name from public.profiles where id = '${A}';`,
    ["admin:false", "active:true", "own-view:true", "other-view:false", "owns-b-org:false", "name:Probe 0072"]);
  expect("own rows through the wrapped policies; cross-tenant rows stay hidden", as(A, `
    select 'own-profile:' || count(*) from public.profiles where id = '${A}';
    select 'other-profile:' || count(*) from public.profiles where id = '${B}';
    select 'other-push:' || count(*) from public.push_subscriptions where user_id = '${B}';
    select 'other-org:' || count(*) from public.orgs where id = '${ORG_B}';
    select 'other-members:' || count(*) from public.org_members where org_id = '${ORG_B}';
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('${A}', 'https://push.example.test/0072-a', 'k', 'a');
    select 'own-push:' || count(*) from public.push_subscriptions;
    update public.push_subscriptions set show_details = true where id = '${SUB_B}';`) +
    ` select 'b-push-untouched:' || (not show_details) from public.push_subscriptions where id = '${SUB_B}';`,
    ["own-profile:1", "other-profile:0", "other-push:0", "other-org:0", "other-members:0", "own-push:1", "b-push-untouched:true"]);
  expect("the owner still reads its own agency through orgs_read", as(B, `select 'own-org:' || count(*) from public.orgs where id = '${ORG_B}';`), ["own-org:1"]);
  refused("a creator registers a push device for another account", as(A, `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('${B}', 'https://push.example.test/0072-x', 'k', 'a');`), /row-level security/);
  // A suspended creator: current_user_active() inside the wrapped policy refuses it.
  expect("a suspended creator reads no push device through the wrapped policy", `update public.profiles set is_active = false where id = '${B}'; ` + as(B, `select 'suspended-push:' || count(*) from public.push_subscriptions;`), ["suspended-push:0"]);

  // ── revoked trigger functions still fire for a session write ───────────────
  // The prize update fires sync_code_prize_stock; the fan deletion fires
  // erase_fan_reward_values and scrub_fan_traces (T10: the deleted fan's
  // redemption stays, without the creator's notes or due date).
  // 0073 (DB-05): a session no longer updates prizes directly; the editors
  // (service role) fire the same trigger.
  expect("revoked trigger functions still fire (prize update, fan deletion); T10 scrub", `set local role service_role;
    update public.prizes set label = 'one renamed' where id = '${PA}'; reset role;` + as(A, `
    delete from public.fans where id = '${FA}';`) +
    ` select 'prize:' || label from public.prizes where id = '${PA}'; select 'fan:' || count(*) from public.fans where id = '${FA}';
      select 'redemption:' || count(*) || ',' || bool_and(notes is null) || ',' || bool_and(due_at is null) from public.redemptions where id = '${RED_A}';`,
    ["prize:one renamed", "fan:0", "redemption:1,true,true"]);
  expect("T10: another fan's deletion leaves this redemption's notes", `insert into public.fans (id, creator_id, display_name) values ('${id("d2")}', '${A}', 'Other');` + as(A, `delete from public.fans where id = '${id("d2")}';`) +
    ` select 'kept:' || (notes is not null) || ',' || (due_at is not null) from public.redemptions where id = '${RED_A}';`, ["kept:true,true"]);

  // ── T1: one SQL source for the accepted-Terms version ───────────────────────
  expect("T1: legal_terms_version() is readable by anon and a creator", `set local role anon; select 'anon:' || (public.legal_terms_version() ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'); reset role;` +
    as(A, `select 'auth:' || (public.legal_terms_version() is not null);`), ["anon:true", "auth:true"]);
  same("T1: no function compares acked_terms_version with a literal date", q(`select coalesce(string_agg(p.oid::regprocedure::text, ', '), '') from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosrc ~ 'acked_terms_version' and p.prosrc ~ '''[0-9]{4}-[0-9]{2}-[0-9]{2}'''`), "");
  same("T1: both spin functions read legal_terms_version()", q(`select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('commit_spin_attempt', 'prepare_spin_attempt') and p.prosrc ~ 'acked_terms_version is distinct from public[.]legal_terms_version[(][)]'`), "2");
  expect("sign-up still creates a profile (handle_new_user)", `select 'profile:' || count(*) from public.profiles where id = '${A}';`, ["profile:1"]);

  // ── policy text: 0071 expressions with only auth.uid()/auth.role() wrapped ──
  /** @type {{table: string, policy: string, cmd: string, roles: string[], using: string | null, check: string | null}[]} */
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "advisor-0072-policies.json"), "utf8"));
  const rows = q(`select json_agg(json_build_object('t', tablename, 'p', policyname, 'cmd', cmd, 'roles', roles, 'q', qual, 'c', with_check, 'perm', permissive))::text
    from pg_policies where schemaname = 'public'`);
  const live = new Map(rows ? JSON.parse(rows).map((p) => [`${p.t}.${p.p}`, p]) : []);
  const unwrap = (s) => s && s.replace(/\( SELECT auth\.(uid|role)\(\) AS \w+\)/g, "auth.$1()");
  for (const f of fixture) {
    checks++;
    const p = live.get(`${f.table}.${f.policy}`);
    if (!p) { bad.push(`policy ${f.table}.${f.policy} is missing`); continue; }
    const wrapped = (s) => !s || !/auth\.(uid|role)\(\)/.test(s.replace(/\( SELECT auth\.(uid|role)\(\) AS \w+\)/g, ""));
    if (p.cmd !== f.cmd || p.perm !== "PERMISSIVE" || JSON.stringify(p.roles) !== JSON.stringify(f.roles)) bad.push(`policy ${f.policy}: command, roles or permissiveness changed`);
    else if (unwrap(p.q) !== f.using || unwrap(p.c) !== f.check) bad.push(`policy ${f.policy}: expression differs from 0071 beyond the wrapped calls`);
    else if (!wrapped(p.q) || !wrapped(p.c)) bad.push(`policy ${f.policy}: still calls auth.uid()/auth.role() per row`);
  }
  same("the advisor named 32 policies", String(fixture.length), "32");
  const perRow = [...live.values()].filter((p) => /auth\.(uid|role|jwt)\(\)|current_setting\(/.test(`${p.q ?? ""} ${p.c ?? ""}`.replace(/\( SELECT auth\.(uid|role|jwt)\(\) AS \w+\)/g, "")))
    .map((p) => `${p.t}.${p.p}`);
  same("no public policy calls auth.*() or current_setting() per row", perRow.join(", "), "");

  // ── foreign keys and search_path ──────────────────────────────────────────
  const unindexed = q(`select string_agg(c.conrelid::regclass::text || '.' || c.conname, ', ') from pg_constraint c
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace
      and not exists (select 1 from pg_index i where i.indrelid = c.conrelid
        and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
        and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey)`);
  same("every public foreign key has a covering index", unindexed, "");
  same("every public function pins its search_path", q(`select string_agg(p.oid::regprocedure::text, ', ') from pg_proc p
    where p.pronamespace = 'public'::regnamespace and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`), "");
  same("schema_version() and _org_invite_email pin public, pg_temp", q(`select string_agg(p.proname || '=' || array_to_string(p.proconfig, ','), ';' order by p.proname) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname in ('schema_version', '_org_invite_email')`),
    "_org_invite_email=search_path=public, pg_temp;schema_version=search_path=public, pg_temp");

  return { bad, checks };
}
