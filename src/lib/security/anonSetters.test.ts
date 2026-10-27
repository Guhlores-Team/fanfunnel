/**
 * AUTH-SENSITIVE (AGENTS.md rule 5): signed-in-only RPCs are not executable by
 * anon (migration 0044).
 *
 * The self-service setters (and the fan-import, admin and agency RPCs) are
 * called only through the creator's session client. Supabase's default
 * privileges grant EXECUTE on new public functions to anon too, so each one
 * needs an explicit `revoke ... from public, anon` followed by a grant to
 * `authenticated`. This replays every grant/revoke in the migrations (last one
 * wins, per role) and asserts the effective state, checks schema.sql and
 * migrations_combined.sql carry the same statements, and asserts that every
 * RPC the app calls through a session client is either signed-in-only, an RLS
 * helper anon must keep, or server-only. A new self-service RPC that forgets
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
  "set_onboarding_dismissed",
  "set_leaderboard_enabled",
  "set_chat_settings",
  "set_display_name",
  "set_notification_prefs",
  "set_public_profile",
  "set_creator_note",
  "set_notifications_seen",
  "set_pwa_icon_mode",
  "import_fans",
  "admin_account_stats",
  "admin_reserve_account_deletion",
  "org_account_stats",
  "org_create",
  "org_invite_creator",
  "org_invite_respond",
  "org_invite_revoke",
  "org_remove_creator",
  "org_add_member",
  "org_remove_member",
  "org_scope_creator",
];
// RLS policies call these, so anon must keep EXECUTE (an anon read that
// evaluates a policy would otherwise error instead of returning no rows).
const RLS_HELPERS = ["is_admin", "can_act_for", "current_user_active", "_owns_org"];

type Acl = { anon: boolean; authenticated: boolean };

/** Replay grants/revokes in order. A function starts executable by everyone
 *  (PUBLIC default + Supabase's default privileges for anon/authenticated). */
function effectiveAcl(sql: string): Map<string, Acl> {
  const acl = new Map<string, Acl>();
  const re =
    /\b(grant|revoke)\s+execute\s+on\s+function\s+public\.(\w+)\s*\((?:[^()]|\([^)]*\))*\)\s+(to|from)\s+([^;]+);/g;
  for (const m of sql.matchAll(re)) {
    const fn = m[2];
    const roles = m[4].split(",").map((r) => r.trim());
    const cur = acl.get(fn) ?? { anon: true, authenticated: true };
    const on = m[1] === "grant";
    // On Supabase anon/authenticated hold explicit grants, so a PUBLIC revoke
    // alone does not remove them; only naming the role does.
    if (roles.includes("anon")) cur.anon = on;
    if (roles.includes("authenticated")) cur.authenticated = on;
    if (on && roles.includes("public")) {
      cur.anon = true;
      cur.authenticated = true;
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
for (const fn of RLS_HELPERS) {
  check(`0044 leaves RLS helper ${fn} alone`, !new RegExp(`public\\.${fn}\\s*\\(`).test(mig0044));
}

for (const [name, sql] of [
  ["migrations/", migSql],
  ["schema.sql", norm(readFileSync(join(SUPA, "schema.sql"), "utf8"))],
  ["schema.sql + migrations_combined.sql", norm(readFileSync(join(SUPA, "schema.sql"), "utf8") + "\n" + readFileSync(join(SUPA, "migrations_combined.sql"), "utf8"))],
] as const) {
  const acl = effectiveAcl(sql);
  for (const fn of SIGNED_IN_ONLY) {
    const a = acl.get(fn) ?? { anon: true, authenticated: true };
    check(`${name}: anon cannot execute ${fn}`, !a.anon);
    check(`${name}: authenticated can execute ${fn}`, a.authenticated);
  }
  for (const fn of RLS_HELPERS) {
    const a = acl.get(fn) ?? { anon: true, authenticated: true };
    check(`${name}: anon keeps EXECUTE on RLS helper ${fn}`, a.anon);
  }
}

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
  const a = migAcl.get(fn) ?? { anon: true, authenticated: true };
  const serverOnly = !a.anon && !a.authenticated;
  check(
    `RPC ${fn} called by the app is signed-in-only, an RLS helper, or server-only`,
    SIGNED_IN_ONLY.includes(fn) || RLS_HELPERS.includes(fn) || serverOnly
  );
}

console.log(`anonSetters: ${passed} checks passed`);
