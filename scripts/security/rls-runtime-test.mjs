/**
 * Runtime cross-tenant RLS test — PROVES isolation against your live database.
 * The static lint (src/lib/security/rls.test.ts) checks the SQL; this checks the
 * running policies by acting as real authenticated users.
 *
 * Run:  node scripts/security/rls-runtime-test.mjs
 * Needs (from .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY   (the browser key — RLS applies to it)
 *   SUPABASE_SERVICE_ROLE_KEY       (to create disposable test users + cleanup)
 *
 * It creates two throwaway creators (A, B), gives each a fan + wheel via the
 * service role, then signs in AS each (anon key) and asserts:
 *   • A can read its own rows
 *   • A reads ZERO of B's rows (fans, wheels, prizes, spins, grants, profiles)
 *   • A cannot UPDATE or DELETE B's rows
 * Exits non-zero on any leak. Cleans up the test users/data at the end.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

try {
  for (const line of readFileSync(new URL("../../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !ANON || !SERVICE) {
  console.error("✗ Need NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const admin = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
const PW = "RlsTest123!";
let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓", msg);
  else { failures++; console.error("  ✗ LEAK:", msg); }
};

async function makeCreator(tag) {
  const email = `rlstest+${tag}-${Date.now()}@fanfunnel.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PW, email_confirm: true,
  });
  if (error) throw error;
  const id = data.user.id;
  await admin.from("profiles").update({ approval_status: "approved", is_active: true }).eq("id", id);
  // Seed one wheel + prize + fan + pass + grant + spin for this creator.
  const { data: wheel } = await admin.from("wheels").insert({ creator_id: id, title: `${tag} wheel` }).select("id").single();
  const { data: prize } = await admin.from("prizes").insert({ wheel_id: wheel.id, label: `${tag} prize`, rarity: "common", weight: 10 }).select("id").single();
  const { data: fan } = await admin.from("fans").insert({ creator_id: id, display_name: `${tag} fan`, spins_remaining: 5 }).select("id").single();
  const { data: pass } = await admin.from("fan_passes").insert({ token: `rls-${tag}-${Date.now()}`, creator_id: id, wheel_id: wheel.id, fan_id: fan.id }).select("id").single();
  await admin.from("grants").insert({ creator_id: id, fan_id: fan.id, spins: 5, amount_cents: 1000 });
  await admin.from("spins").insert({ fan_pass_id: pass.id, creator_id: id, wheel_id: wheel.id, fan_id: fan.id, prize_id: prize.id, prize_label: `${tag} prize`, prize_rarity: "common" });
  return { id, email, wheelId: wheel.id, fanId: fan.id };
}

async function signedClient(email) {
  const c = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw error;
  return c;
}

async function main() {
  console.log("Creating two throwaway creators…");
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

  // Cleanup.
  console.log("\nCleaning up test users…");
  await admin.auth.admin.deleteUser(A.id);
  await admin.auth.admin.deleteUser(B.id);

  if (failures > 0) {
    console.error(`\n✗ RLS RUNTIME TEST FAILED — ${failures} leak(s). Do not ship.`);
    process.exit(1);
  }
  console.log("\n✓ RLS runtime test passed — tenants are isolated.");
}

main().catch((e) => { console.error("✗ Test error:", e.message ?? e); process.exit(1); });
