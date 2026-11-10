/**
 * AUTH-SENSITIVE (AGENTS.md rule 5): signed-in-only RPCs are not executable by
 * anon (migration 0044).
 *
 * The self-service setters (and the admin and agency RPCs) are called only
 * through the creator's session client. Since 0059, fan import instead uses
 * an authorized service-only durable gateway; its legacy RPC is retired.
 * Supabase's default
 * privileges grant EXECUTE on new public functions to anon too, so each one
 * needs an explicit `revoke ... from public, anon` followed by a grant to
 * `authenticated`. This replays every grant/revoke in the migrations (last one
 * wins, per role) and asserts the effective state, checks schema.sql and
 * migrations_combined.sql carry the same statements, and asserts that every
 * RPC the app calls through a session client is either signed-in-only, an RLS
 * helper (signed-in only since 0072), or server-only. A new self-service RPC that forgets
 * the revoke fails here. The runtime half (a real anon call is refused, an
 * authenticated call still persists) is in scripts/db/schema-drift-check.mjs.
 */
import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const SUPA = join(ROOT, "supabase");

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const norm = (s: string) =>
  s
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const SIGNED_IN_ONLY = [
  // 0073 (TS-06): the Terms-change notice. Reading it needs a session (or the
  // server's service client, which serves the public notice line); writing it
  // runs as the caller and is_admin() (active admin, aal2) decides inside.
  "legal_terms_upcoming",
  "set_legal_terms_notice",
  "issue_creator_actor_context",
  "set_onboarding_dismissed",
  "set_leaderboard_enabled",
  "set_chat_settings",
  "set_display_name",
  "set_notification_prefs",
  "set_public_profile",
  "set_creator_note",
  "set_notifications_seen",
  "set_pwa_icon_mode",
  "set_creator_theme",
  "admin_account_stats",
  "org_account_stats",
  "org_create",
  "org_invite_creator",
  "org_invite_respond",
  "org_invite_revoke",
  "org_remove_creator",
  "org_add_member",
  "org_remove_member",
  "org_scope_creator",
  // 0071: the caller leaves its own seat / agency (auth.uid() rows only), and
  // a campaign is deleted fan -> link -> campaign under can_act_for('manage').
  "org_leave",
  "delete_campaign",
  // 0064: SECURITY INVOKER queue/inbox reads, pinned to auth.uid().
  "creator_redemption_queue",
  "creator_inbox_threads",
  // 0065: SECURITY DEFINER archive/delete in the play lock order, gated by the
  // same can_act_for('edit_wheel') / is_admin() rule as the wheels_write policy.
  "archive_wheel",
  "delete_wheel",
  // 0066 (A19): the caller's own agency seats, gated by can_act_for.
  "my_seat_creators",
  // 0067 (A42): the redemptions write (status/notes/due date + the stock unit
  // on cancel/reopen), gated by the redemptions_write RLS rule
  // can_act_for(creator, 'fulfil') / is_admin() on auth.uid().
  "set_redemption_state",
  // 0068: fan_passes.token is served only through these (can_act_for-gated),
  // and a creator may wipe its own finished spin attempts.
  "creator_link_tokens",
  "creator_link_pass",
  "wipe_my_spin_attempts",
];
// RLS policies call these. 0044 left them anon-callable so an anon read that
// evaluated a policy returned no rows instead of an error; since 0068 anon
// holds no table privilege and never evaluates a policy, so 0072 makes them
// signed-in only. authenticated must keep them: policies run as the querying
// role, and a revoke there would break every policy that calls one.
const RLS_HELPERS = ["is_admin", "can_act_for", "current_user_active", "_owns_org", "_owns_org_seat", "_is_org_member", "_my_confirmed_email"];
// 0072: no app caller (the admin delete runs on the service gateway; the
// legacy org_add_creator bypassed consent), so service-role only.
const SERVICE_ONLY_0072 = ["admin_reserve_account_deletion", "org_add_creator"];
// 0072: trigger functions need no EXECUTE for any browser role.
const TRIGGERS_0072 = [
  "attach_spin_reward", "erase_fan_reward_values", "guard_delivered_redemption", "handle_new_user",
  "sync_code_prize_stock", "sync_fan_spin_aggregate", "guard_fan_break", "admin_audit_log_immutable",
];

type Acl = { anon: boolean; authenticated: boolean; service: boolean };

/** Replay grants/revokes in order. A function starts executable by everyone
 *  (PUBLIC default + Supabase's default privileges for anon/authenticated). */
function effectiveAcl(sql: string): Map<string, Acl> {
  const acl = new Map<string, Acl>();
  const re =
    /\b(grant|revoke)\s+execute\s+on\s+function\s+public\.(\w+)\s*\((?:[^()]|\([^)]*\))*\)\s+(to|from)\s+([^;]+);/g;
  for (const m of sql.matchAll(re)) {
    const fn = m[2];
    const roles = m[4].split(",").map((r) => r.trim());
    const cur = acl.get(fn) ?? { anon: true, authenticated: true, service: true };
    const on = m[1] === "grant";
    // On Supabase anon/authenticated hold explicit grants, so a PUBLIC revoke
    // alone does not remove them; only naming the role does.
    if (roles.includes("anon")) cur.anon = on;
    if (roles.includes("authenticated")) cur.authenticated = on;
    if (roles.includes("service_role")) cur.service = on;
    if (on && roles.includes("public")) {
      cur.anon = true;
      cur.authenticated = true;
      cur.service = true;
    }
    acl.set(fn, cur);
  }
  return acl;
}

const migFiles = readdirSync(join(SUPA, "migrations"))
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();
check("migration 0044 exists", migFiles.some((f) => /^0044_revoke_anon_setters\.sql$/.test(f)));
const migSql = norm(migFiles.map((f) => readFileSync(join(SUPA, "migrations", f), "utf8")).join("\n"));
const mig0044 = norm(readFileSync(join(SUPA, "migrations", "0044_revoke_anon_setters.sql"), "utf8"));

check("0044 creates or alters no table/policy/function", !/\b(create|alter|drop)\s+(table|policy|function)\b/.test(mig0044));
check("0044 never revokes from authenticated", !/from[^;]*\bauthenticated\b/.test(mig0044));
check("0044 grants only to authenticated", [...mig0044.matchAll(/\bgrant\b[^;]*\bto\s+([^;]+);/g)].every((m) => m[1].trim() === "authenticated"));
check("0044 originally kept authenticated import access", effectiveAcl(mig0044).get("import_fans")?.authenticated === true);
for (const fn of RLS_HELPERS) {
  check(`0044 leaves RLS helper ${fn} alone`, !new RegExp(`public\\.${fn}\\s*\\(`).test(mig0044));
}
const mig0072 = norm(readFileSync(join(SUPA, "migrations", "0072_advisor_hardening.sql"), "utf8"));
check("0072 never revokes an RLS helper from authenticated", RLS_HELPERS.every((fn) =>
  !new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from [^;]*\\bauthenticated\\b`).test(mig0072)));

for (const [name, sql] of [
  ["migrations/", migSql],
  ["schema.sql", norm(readFileSync(join(SUPA, "schema.sql"), "utf8"))],
  ["schema.sql + migrations_combined.sql", norm(readFileSync(join(SUPA, "schema.sql"), "utf8") + "\n" + readFileSync(join(SUPA, "migrations_combined.sql"), "utf8"))],
] as const) {
  const acl = effectiveAcl(sql);
  // 0059 retires the old session import: its durable replacement checks both
  // current actor authority and the immutable request journal on the server.
  for (const fn of ["import_fans", "import_fans_durable"]) {
    const a = acl.get(fn);
    check(`${name}: neither browser role can execute ${fn}`, !!a && !a.anon && !a.authenticated);
  }
  check(`${name}: legacy import is revoked even from service_role`,
    /revoke execute on function public\.import_fans\(jsonb\) from public,\s*anon,\s*authenticated,\s*service_role;/.test(sql) &&
    acl.get("import_fans")?.service === false);
  check(`${name}: durable import is granted only to service_role`,
    /grant execute on function public\.import_fans_durable\([^;]+\) to service_role;/.test(sql) && acl.get("import_fans_durable")?.service === true &&
    !/grant execute on function public\.import_fans_durable\([^;]+\) to (?:public|anon|authenticated)\b/.test(sql));
  for (const fn of SIGNED_IN_ONLY) {
    const a = acl.get(fn) ?? { anon: true, authenticated: true, service: true };
    check(`${name}: anon cannot execute ${fn}`, !a.anon);
    check(`${name}: authenticated can execute ${fn}`, a.authenticated);
  }
  check(`${name}: a service JWT cannot mint creator assurance`, acl.get("issue_creator_actor_context")?.service === false);
  check(`${name}: context mint explicitly grants only the authenticated session role`,
    /grant execute on function public\.issue_creator_actor_context\(uuid,\s*text\) to authenticated;/.test(sql) &&
    /revoke execute on function public\.issue_creator_actor_context\(uuid,\s*text\) from public,\s*anon,\s*service_role;/.test(sql));
  for (const fn of RLS_HELPERS) {
    const a = acl.get(fn) ?? { anon: true, authenticated: true, service: true };
    check(`${name}: anon cannot execute RLS helper ${fn}`, !a.anon);
    check(`${name}: authenticated keeps EXECUTE on RLS helper ${fn} (policies run as the querying role)`, a.authenticated);
  }
  for (const fn of [...SERVICE_ONLY_0072, ...TRIGGERS_0072]) {
    const a = acl.get(fn) ?? { anon: true, authenticated: true, service: true };
    check(`${name}: neither browser role can execute ${fn}`, !a.anon && !a.authenticated);
  }
  for (const fn of SERVICE_ONLY_0072) check(`${name}: service_role keeps ${fn}`, acl.get(fn)?.service === true);
}

const importRoute = readFileSync(join(ROOT, "src/app/api/fans/import/route.ts"), "utf8");
check("import route refuses missing session and denied current grant authority",
  /session && \(userResult\?\.error \|\| !user\)/.test(importRoute) &&
  /session\.rpc\("can_act_for", \{ target_creator: creatorId, perm: "grant" \}\)/.test(importRoute) &&
  /if \(error \|\| permitted !== true\) return NextResponse\.json/.test(importRoute));
check("import route uses the durable service gateway, never legacy import",
  /const service = createServiceClient\(\)/.test(importRoute) &&
  /service\.rpc\("import_fans_durable", args\)/.test(importRoute) &&
  !/\.rpc\("import_fans"/.test(importRoute));

// Every RPC the app calls must be classified: signed-in-only (anon revoked),
// an RLS helper, or server-only (revoked from authenticated too). An
// unclassified name means a new RPC shipped without deciding who may call it.
function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(e) && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}
const migAcl = effectiveAcl(migSql);
const called = new Set<string>();
for (const f of files(join(ROOT, "src"))) {
  const src = readFileSync(f, "latin1");
  for (const m of src.matchAll(/\.rpc\(\s*["'](\w+)["']/g)) called.add(m[1]);
  for (const m of src.matchAll(/\bfn:\s*["'](org_\w+)["']/g)) called.add(m[1]);
}
check("found the app's RPC call sites", called.size >= 10);
for (const fn of called) {
  const a = migAcl.get(fn) ?? { anon: true, authenticated: true, service: true };
  const serverOnly = !a.anon && !a.authenticated;
  check(
    `RPC ${fn} called by the app is signed-in-only, an RLS helper, or server-only`,
    SIGNED_IN_ONLY.includes(fn) || RLS_HELPERS.includes(fn) || serverOnly
  );
}

console.log(`anonSetters: ${passed} checks passed`);
