// Real-Supabase spin-integrity test — guards the money/prizes path.
//
// Fires MANY concurrent claim_spin() calls at a single fan link that has a
// known balance, and proves the atomic decrement holds: EXACTLY `balance`
// claims succeed, the rest get "no spins", the balance never goes negative,
// and it lands at zero. This is the double-spend / oversell guarantee that
// mock mode can't exercise (no real concurrent Postgres).
//
// Note: calling claim_spin directly does NOT insert into `spins`, so the
// in-function rolling-window rate limit (which counts the spins table) never
// trips here — keeping this a clean test of the decrement race itself.
//
// Headless. Skips cleanly when secrets are absent. Uses the service-role client
// to set up + tear down its own creator/wheel/fan/pass (no shared state).

import { createClient } from "@supabase/supabase-js";
import { log, requireSupabaseEnvOrExit } from "./supabase-env.mjs";

const { URL, SERVICE } = requireSupabaseEnvOrExit();

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

const results = [];
let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    results.push([true, name, ""]);
  } catch (e) {
    failures++;
    results.push([false, name, String(e?.message || e).slice(0, 200)]);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error("assertion failed: " + msg);
}

const BALANCE = 12; // spins granted on the pass
const FIRE = 40; // concurrent claim attempts (> BALANCE)
const rand = Math.random().toString(36).slice(2, 8);
const token = `e2e-spin-${rand}`;

let userId = null;
async function cleanup() {
  // Deleting the auth user cascades profile → wheels/fans/fan_passes.
  if (userId) {
    try {
      await admin.auth.admin.deleteUser(userId);
    } catch {
      /* best effort */
    }
  }
}

let exitCode = 1;
try {
  log(`Spin-integrity test → ${URL}`);

  await step(`setup: creator + wheel + fan + pass (balance ${BALANCE})`, async () => {
    const email = `e2e-spin-${rand}@fanfunnel.test`;
    const password = "Test-" + Math.random().toString(36).slice(2) + "-Aa1!";
    const { data: u, error: uErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    assert(!uErr, `createUser: ${uErr?.message}`);
    userId = u.user.id;

    const { data: wheel, error: wErr } = await admin
      .from("wheels")
      .insert({ creator_id: userId, title: "Spin integrity wheel" })
      .select("id")
      .single();
    assert(!wErr, `insert wheel: ${wErr?.message}`);

    const { data: fan, error: fErr } = await admin
      .from("fans")
      .insert({ creator_id: userId, spins_remaining: BALANCE, spins_granted_total: BALANCE })
      .select("id")
      .single();
    assert(!fErr, `insert fan: ${fErr?.message}`);

    const { error: pErr } = await admin.from("fan_passes").insert({
      token,
      creator_id: userId,
      wheel_id: wheel.id,
      fan_id: fan.id,
      spins_remaining: BALANCE,
      spins_granted_total: BALANCE,
      is_active: true,
    });
    assert(!pErr, `insert fan_pass: ${pErr?.message}`);
  });

  await step(`${FIRE} concurrent claim_spin → exactly ${BALANCE} succeed, none negative`, async () => {
    const calls = Array.from({ length: FIRE }, () =>
      admin.rpc("claim_spin", { p_token: token })
    );
    const settled = await Promise.all(calls);

    let ok = 0;
    let noSpins = 0;
    let rateLimited = 0;
    let errors = 0;
    let minRemaining = Infinity;
    for (const { data, error } of settled) {
      if (error) {
        errors++;
        continue;
      }
      if (data === null) noSpins++;
      else if (data === -1) rateLimited++;
      else {
        ok++;
        minRemaining = Math.min(minRemaining, data);
      }
    }

    log(`   results → success=${ok} noSpins=${noSpins} rateLimited=${rateLimited} errors=${errors} minRemaining=${minRemaining}`);
    assert(errors === 0, `no RPC errors (got ${errors})`);
    assert(rateLimited === 0, `rate limiter shouldn't trip (got ${rateLimited})`);
    assert(ok === BALANCE, `exactly ${BALANCE} claims succeed (got ${ok}) — double-spend if >, undersold if <`);
    assert(noSpins === FIRE - BALANCE, `the rest report no-spins (got ${noSpins})`);
    assert(minRemaining >= 0, `remaining never goes negative (min was ${minRemaining})`);
  });

  await step("final balance is exactly 0 (no oversell, no negative)", async () => {
    const { data, error } = await admin
      .from("fan_passes")
      .select("spins_remaining")
      .eq("token", token)
      .single();
    assert(!error, `read pass: ${error?.message}`);
    assert(data.spins_remaining === 0, `pass balance is 0 (got ${data.spins_remaining})`);
  });

  const lines = ["\n================ SPIN INTEGRITY ================"];
  for (const [okv, name, note] of results)
    lines.push(`  ${okv ? "✓" : "✗"} ${name}${note ? "  — " + note : ""}`);
  lines.push(`\nRESULT: ${results.filter((r) => r[0]).length}/${results.length} checks passed`);
  const passed = failures === 0;
  lines.push(passed ? "\n✅ SPIN INTEGRITY PASSED" : "\n❌ SPIN INTEGRITY FAILED");
  log(lines.join("\n"));
  exitCode = passed ? 0 : 1;
} catch (e) {
  log("Spin-integrity harness error: " + (e?.stack || e));
  exitCode = 1;
} finally {
  await cleanup();
  process.exit(exitCode);
}
