import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0056 fixes an admin-approval bypass: dashboard navigation cannot authorize
// creator writes. Pin the effective functions, plus the behavioral SQL probe.
const ROOT = join(import.meta.dirname, "../../..");
let passed = 0;
const check = (label: string, condition: boolean) => { assert.ok(condition, label); passed++; };
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const norm = (value: string) => value.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").toLowerCase();
function lastFn(sql: string, name: string): string {
  const found = [...sql.matchAll(new RegExp(`create or replace function public\\.${name}\\b[\\s\\S]*?\\$\\$;`, "g"))];
  return found.at(-1)?.[0] ?? "";
}
for (const file of ["supabase/migrations/0056_push_subscriptions.sql", "supabase/schema.sql", "supabase/migrations_combined.sql"]) {
  const sql = norm(read(file));
  for (const name of ["current_user_active", "can_act_for", "_owns_org", "_is_org_member", "_owns_org_seat", "org_invite_respond", "org_add_member", "org_add_creator", "org_invite_creator"]) {
    const body = lastFn(sql, name);
    check(`${file}: ${name} is defined`, !!body);
    check(`${file}: ${name} requires approved status or the server-controlled admin role`, /approval_status = 'approved' or (?:p\.)?role = 'admin'/.test(body));
    check(`${file}: ${name} remains SECURITY DEFINER with a pinned search path`, /security definer set search_path = public/.test(body));
    check(`${file}: ${name} never reads editable auth metadata`, !/user_metadata|app_metadata|raw_user_meta_data/.test(body));
  }
  const active = lastFn(sql, "current_user_active");
  check(`${file}: active gate also requires the caller's active flag`, /where id = auth\.uid\(\) and is_active and \(approval_status = 'approved' or role = 'admin'\)/.test(active));
  const act = lastFn(sql, "can_act_for");
  check(`${file}: agency target must be active and approved`, /and p\.org_id = o\.id[\s\S]*and p\.is_active and \(p\.approval_status = 'approved' or p\.role = 'admin'\)/.test(act));
  check(`${file}: agency delegation also requires an active approved owner`, /owner_profile\.is_active/.test(act) && /owner_profile\.approval_status = 'approved' or owner_profile\.role = 'admin'/.test(act));
  check(`${file}: own read-only access survives lack of write approval`, /if target_creator = auth\.uid\(\) then return perm = 'view' or v_active;/.test(act));
  for (const name of ["set_public_profile", "set_creator_note", "set_chat_settings", "set_pwa_icon_mode", "set_leaderboard_enabled"]) {
    const body = lastFn(sql, name);
    check(`${file}: ${name} requires the shared active/approved gate`, /where id = auth\.uid\(\)[\s\S]*public\.current_user_active\(\)/.test(body));
  }
  const imported = lastFn(sql, "import_fans");
  check(`${file}: import refuses unapproved callers before writing fan records`, imported.indexOf("if not public.current_user_active()") >= 0 && imported.indexOf("if not public.current_user_active()") < imported.indexOf("insert into public.fans"));
  check(`${file}: no unrestricted table policy introduced`, !/using \(true\)|with check \(true\)/.test(sql));
  if (!file.includes("migrations/")) {
    const admin = lastFn(sql, "is_admin");
    check(`${file}: cross-account admin power still requires aal2`, /role = 'admin' and is_active/.test(admin) && /'aal2'/.test(admin));
    check(`${file}: pending users can still edit their application display name`, !/current_user_active\(\)/.test(lastFn(sql, "set_display_name")));
  }
}
const drift = read("scripts/db/schema-drift-check.mjs");
check("drift check imports approval proof", /import \{ APPROVAL_PROBE_SQL, checkApprovalProbe \} from "\.\/approvalProbe\.mjs"/.test(drift));
check("every SQL build path runs approval proof", /for \(const db of \["ffa", "ffb", "ffc"\]\) \{[\s\S]*?probeApproval\(db\);/.test(drift));
const runtime = read("scripts/security/rls-runtime-test.mjs");
check("real TEST runtime covers pending/rejected own writes", runtime.includes('for (const approval of ["pending", "rejected"])') && runtime.includes("approval prevents own wheel writes"));
check("real TEST runtime covers pending/rejected agency callers and targets", runtime.includes("approval prevents seat access") && runtime.includes("approval prevents access to an unapproved target"));
const realE2e = read("e2e/supabase.mjs");
check("positive real-Supabase creators are explicitly approved", /update\(\{ approval_status: "approved", is_active: true \}\)/.test(realE2e));
check("real-Supabase suite also preserves pending/rejected negative cases", realE2e.includes('for (const approval of ["pending", "rejected"])') && realE2e.includes("unapproved creator cannot insert a wheel"));
console.log(`approvalAuthorization0056: ${passed} checks passed`);
