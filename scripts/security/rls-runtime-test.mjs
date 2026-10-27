/**
 * Runtime cross-tenant RLS test — PROVES isolation against your live database.
 * The static lint (src/lib/security/rls.test.ts) checks the SQL; this checks the
 * running policies by acting as real authenticated users.
 *
 * Run:  node scripts/security/rls-runtime-test.mjs
 * Needs (from the environment, else .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY   (the browser key — RLS applies to it)
 *   SUPABASE_SERVICE_ROLE_KEY       (to create disposable test users + cleanup)
 * Optional:
 *   RLS_TEST_REQUIRE_REF            (refuse to run unless the URL is this project ref; CI sets it)
 *
 * It creates two throwaway creators (A, B), gives each a fan + wheel via the
 * service role, then signs in AS each (anon key) and asserts:
 *   • A can read its own rows
 *   • A reads ZERO of B's rows (fans, wheels, prizes, spins, grants, profiles)
 *   • A cannot UPDATE or DELETE B's rows
 *   • A cannot promote itself to admin
 * Exits non-zero on any leak, seed error, or cleanup failure.
 *
 * Safe to run repeatedly and concurrently against one shared TEST project:
 * every user/token carries a per-run id, all reads are scoped to this run's own
 * creator ids, the users (and, by FK cascade, all their rows) are deleted in a
 * `finally`, and users left behind by a killed run (> 1h old) are swept first.
 * It refuses to run against the PRODUCTION project.
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

try {
  for (const line of readFileSync(new URL("../../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!URL_ || !ANON || !SERVICE) {
  console.error("✗ Need NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// This script creates and deletes users, so it must never touch production.
const PROD_REF = "ttlogfmogcccwiraaoae";
if (URL_.toLowerCase().includes(PROD_REF)) {
  console.error(`✗ Refusing to run: NEXT_PUBLIC_SUPABASE_URL points at the PRODUCTION project (${PROD_REF}). Use the TEST project.`);
  process.exit(1);
}
const REQUIRED_REF = process.env.RLS_TEST_REQUIRE_REF?.trim();
if (REQUIRED_REF) {
  let host = "";
  try { host = new URL(URL_).hostname.toLowerCase(); } catch {}
  if (host !== `${REQUIRED_REF.toLowerCase()}.supabase.co`) {
    console.error(`✗ Refusing to run: NEXT_PUBLIC_SUPABASE_URL is not the expected project (${REQUIRED_REF}).`);
    process.exit(1);
  }
}

const admin = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
const PW = "RlsTest123!";
// Unique per run so concurrent runs (two PRs at once) never collide on an email
// or on the unique fan_passes.token.
const RUN = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const TEST_EMAIL = /^rlstest\+[^@]*@fanfunnel\.test$/i;
const STALE_MS = 60 * 60 * 1000;
const createdUserIds = [];
let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓", msg);
  else { failures++; console.error("  ✗ LEAK:", msg); }
};
// Seeding must succeed, or the "reads 0 of B's rows" checks would pass vacuously.
const must = (res, what) => {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data == null) throw new Error(`${what}: no row returned`);
  return res.data;
};

// Delete this script's users left behind by a run that was killed before its
// `finally` (e.g. a cancelled CI job). Only old ones, so a concurrent run's
// users are never touched.
async function sweepStaleUsers() {
  const cutoff = Date.now() - STALE_MS;
  const stale = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) { console.error("  ⚠ Skipping stale-user sweep — listUsers:", error.message); return; }
    const users = data?.users ?? [];
    for (const u of users) {
      if (u.email && TEST_EMAIL.test(u.email) && Date.parse(u.created_at) < cutoff) stale.push(u.id);
    }
    if (users.length < 1000) break;
  }
  let swept = 0;
  for (const id of stale) {
    try {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
      swept++;
    } catch (e) {
      console.error("  ⚠ Could not sweep stale test user", id, "—", e.message ?? e);
    }
  }
  if (swept) console.log(`Swept ${swept} stale test user(s) from earlier killed runs.`);
}

async function makeCreator(tag) {
  const email = `rlstest+${RUN}-${tag}@fanfunnel.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PW, email_confirm: true,
  });
  if (error) throw error;
  const id = data.user.id;
  // Register for cleanup before anything else can throw.
  createdUserIds.push(id);
  // The profiles row is created by a database trigger that may not have completed
  // yet; poll until it exists before updating to avoid flaky failures.
  let profileExists = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data: profile } = await admin.from("profiles").select("id").eq("id", id).maybeSingle();
    if (profile) { profileExists = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!profileExists) throw new Error(`profiles row for ${id} was not created by trigger in time`);
  must(await admin.from("profiles").update({ approval_status: "approved", is_active: true }).eq("id", id).select("id").single(), `approve ${tag}`);
  // Seed one wheel + prize + fan + pass + grant + spin for this creator.
  const wheel = must(await admin.from("wheels").insert({ creator_id: id, title: `${tag} wheel` }).select("id").single(), `seed ${tag} wheel`);
  const prize = must(await admin.from("prizes").insert({ wheel_id: wheel.id, label: `${tag} prize`, rarity: "common", weight: 10 }).select("id").single(), `seed ${tag} prize`);
  const fan = must(await admin.from("fans").insert({ creator_id: id, display_name: `${tag} fan`, spins_remaining: 5 }).select("id").single(), `seed ${tag} fan`);
  const pass = must(await admin.from("fan_passes").insert({ token: `rls-${RUN}-${tag}`, creator_id: id, wheel_id: wheel.id, fan_id: fan.id }).select("id").single(), `seed ${tag} fan_pass`);
  must(await admin.from("grants").insert({ creator_id: id, fan_id: fan.id, spins: 5, amount_cents: 1000 }).select("id").single(), `seed ${tag} grant`);
  must(await admin.from("spins").insert({ fan_pass_id: pass.id, creator_id: id, wheel_id: wheel.id, fan_id: fan.id, prize_id: prize.id, prize_label: `${tag} prize`, prize_rarity: "common" }).select("id").single(), `seed ${tag} spin`);
  return { id, email, wheelId: wheel.id, fanId: fan.id, fanName: `${tag} fan` };
}

async function signedClient(email) {
  const c = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw error;
  return c;
}

async function main() {
  let cleanupFailed = false;
  try {
    await sweepStaleUsers();

    console.log(`Creating two throwaway creators (run ${RUN})…`);
    const A = await makeCreator("a");
    const B = await makeCreator("b");

    const a = await signedClient(A.email);
    console.log("\nActing as Creator A — asserting isolation from B:");

    // A sees its own rows.
    const ownFans = await a.from("fans").select("id").eq("creator_id", A.id);
    check((ownFans.data?.length ?? 0) === 1, "A can read its OWN fan");

    // A sees none of B's, across every tenant table.
    for (const [table] of [["fans"], ["wheels"], ["grants"], ["spins"]]) {
      const r = await a.from(table).select("id").eq("creator_id", B.id);
      check((r.data?.length ?? 0) === 0, `A reads 0 of B's ${table} (got ${r.data?.length ?? 0})`);
    }
    // Prizes are scoped via their wheel.
    const bPrizes = await a.from("prizes").select("id").eq("wheel_id", B.wheelId);
    check((bPrizes.data?.length ?? 0) === 0, `A reads 0 of B's prizes (got ${bPrizes.data?.length ?? 0})`);
    // Profiles: A must not read B's profile row.
    const bProfile = await a.from("profiles").select("id").eq("id", B.id);
    check((bProfile.data?.length ?? 0) === 0, `A reads 0 of B's profile (got ${bProfile.data?.length ?? 0})`);

    // A cannot mutate B's rows (RLS should match zero rows → no-op, never error-leak).
    const upd = await a.from("fans").update({ display_name: "HACKED" }).eq("id", B.fanId).select("id");
    check((upd.data?.length ?? 0) === 0, "A cannot UPDATE B's fan");
    const del = await a.from("wheels").delete().eq("id", B.wheelId).select("id");
    check((del.data?.length ?? 0) === 0, "A cannot DELETE B's wheel");
    // Confirm with the service role that B's rows really are untouched.
    const { data: bFanAfter } = await admin.from("fans").select("display_name").eq("id", B.fanId).maybeSingle();
    check(bFanAfter?.display_name === B.fanName, `B's fan is unchanged (got ${bFanAfter?.display_name})`);
    const { data: bWheelAfter } = await admin.from("wheels").select("id").eq("id", B.wheelId);
    check((bWheelAfter?.length ?? 0) === 1, "B's wheel still exists");

    // A cannot PROMOTE itself. The profiles UPDATE policy is admin-only, so a
    // creator setting its own role must match zero rows (RLS no-op), and the
    // role must remain unchanged when re-read with the service role. This pins
    // the auth contract's "a normal user cannot promote themselves" rule.
    const selfPromote = await a
      .from("profiles")
      .update({ role: "admin", is_active: true })
      .eq("id", A.id)
      .select("id");
    check((selfPromote.data?.length ?? 0) === 0, "A cannot self-UPDATE its profile (admin-only)");
    const { data: aRole } = await admin.from("profiles").select("role").eq("id", A.id).maybeSingle();
    check(aRole?.role !== "admin", `A's role is still not admin after self-promote attempt (got ${aRole?.role})`);

    // RM-4 (0046): the home-screen icon setter writes only the caller's row.
    const setIcon = await a.rpc("set_pwa_icon_mode", { p_mode: "avatar" });
    check(!setIcon.error, `A can set its own home-screen icon (${setIcon.error?.message ?? "ok"})`);
    const { data: icons } = await admin.from("profiles").select("id, pwa_icon_mode").in("id", [A.id, B.id]);
    const iconOf = (id) => icons?.find((r) => r.id === id)?.pwa_icon_mode;
    check(iconOf(A.id) === "avatar", `A's icon mode is avatar (got ${iconOf(A.id)})`);
    check(iconOf(B.id) === "neutral", `B's icon mode is untouched by A (got ${iconOf(B.id)})`);
    const directIcon = await a.from("profiles").update({ pwa_icon_mode: "avatar" }).eq("id", B.id).select("id");
    check((directIcon.data?.length ?? 0) === 0, "A cannot UPDATE B's pwa_icon_mode directly");
    const anonClient = createClient(URL_, ANON, { auth: { persistSession: false } });
    const anonIcon = await anonClient.rpc("set_pwa_icon_mode", { p_mode: "avatar" });
    check(!!anonIcon.error, "anon cannot execute set_pwa_icon_mode");

    // 0054: the activity log and link tombstones are admin-only, the log is
    // append-only through the server, and the self-close / retention functions
    // are server-only. A creator (and anon) get nothing.
    for (const table of ["admin_audit_log", "link_tombstones"]) {
      const r = await a.from(table).select("*").limit(5);
      check((r.data?.length ?? 0) === 0, `A reads 0 rows of ${table} (got ${r.data?.length ?? 0})`);
    }
    const forged = await a
      .from("admin_audit_log")
      .insert({ actor_id: A.id, action: "account.delete", details: {} })
      .select("id");
    check(!!forged.error && (forged.data?.length ?? 0) === 0, "A cannot write the activity log");
    const notices = await a.from("creator_notices").select("creator_id");
    check((notices.data ?? []).every((n) => n.creator_id === A.id), "A reads only its own creator_notices");
    const selfClose = await a.rpc("reserve_self_account_deletion", { p_user: B.id });
    check(!!selfClose.error, "A cannot execute reserve_self_account_deletion");
    const sweep = await a.rpc("run_retention_cleanup", { p_audit_days: 1, p_notice_days: 1, p_tombstone_days: 1, p_app_error_days: 1, p_closed_invite_days: 1 });
    check(!!sweep.error, "A cannot execute run_retention_cleanup");
    const anonSweep = await anonClient.rpc("run_retention_cleanup", { p_audit_days: 1, p_notice_days: 1, p_tombstone_days: 1, p_app_error_days: 1, p_closed_invite_days: 1 });
    check(!!anonSweep.error, "anon cannot execute run_retention_cleanup");
    // A password-only session is aal1, so is_admin() is false even for an admin.
    const aIsAdmin = await a.rpc("is_admin");
    check(aIsAdmin.data !== true, "A's is_admin() is false");

    // An ADMIN on a password-only (aal1) session gets no admin power either:
    // make A an admin server-side, then use A's existing aal1 session.
    must(await admin.from("profiles").update({ role: "admin" }).eq("id", A.id).select("id").single(), "promote A for the aal1 check");
    try {
      const aal1IsAdmin = await a.rpc("is_admin");
      check(aal1IsAdmin.data === false, `an aal1 admin's is_admin() is false (got ${aal1IsAdmin.data})`);
      const aal1Log = await a.from("admin_audit_log").select("id").limit(5);
      check((aal1Log.data?.length ?? 0) === 0, `an aal1 admin reads 0 activity-log rows (got ${aal1Log.data?.length ?? 0})`);
      const aal1Cross = await a.from("fans").select("id").eq("creator_id", B.id);
      check((aal1Cross.data?.length ?? 0) === 0, `an aal1 admin cannot read another creator's fans (got ${aal1Cross.data?.length ?? 0})`);
      const aal1Promote = await a.from("profiles").update({ is_active: true }).eq("id", B.id).select("id");
      check((aal1Promote.data?.length ?? 0) === 0, "an aal1 admin cannot UPDATE another profile");
    } finally {
      await admin.from("profiles").update({ role: "creator" }).eq("id", A.id);
    }
  } finally {
    // Always clean up, even if an error was thrown above, so no disposable
    // users or seeded tenant data (FK-cascaded from the user) are left behind.
    console.log("\nCleaning up test users…");
    for (const id of createdUserIds) {
      try {
        const { error } = await admin.auth.admin.deleteUser(id);
        if (error) throw error;
      } catch (e) {
        cleanupFailed = true;
        console.error("  ✗ Failed to delete test user", id, "—", e.message ?? e);
      }
    }
  }

  if (failures > 0) {
    console.error(`\n✗ RLS RUNTIME TEST FAILED — ${failures} leak(s). Do not ship.`);
    process.exit(1);
  }
  if (cleanupFailed) {
    console.error("\n✗ RLS checks passed, but cleanup failed — test users were left behind.");
    process.exit(1);
  }
  console.log("\n✓ RLS runtime test passed — tenants are isolated.");
}

main().catch((e) => { console.error("✗ Test error:", e.message ?? e); process.exit(1); });
