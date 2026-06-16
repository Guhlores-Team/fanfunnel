// Real-Supabase spin-BEHAVIORS suite — the DB-enforced rules that guard the
// core mechanic, which mock mode + unit tests can't exercise (real concurrent
// Postgres, RLS, the claim_spin guards). The TS engine itself (weighting, pity,
// stock, fairness RNG) is covered by src/lib/games/wheel/*.test.ts.
//
// Covered here, all via the real claim_spin():
//   1. Double-spend: N concurrent claims on a balance of N → exactly N succeed.
//   2. Out of spins → null.
//   3. Self-excluded pass → blocked (null).
//   4. Blocked fan → blocked (null).
//   5. Inactive pass → blocked (null).
//   6. Rate limit: >8 spins in 10s → -1 sentinel (HTTP 429).
//   7. Per-wheel isolation: draining one pass doesn't touch the fan's other pass.
//
// Headless; skips when secrets absent; sets up + tears down its own data.

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
    log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    results.push([false, name, String(e?.message || e).slice(0, 200)]);
    log(`  ✗ ${name} — ${String(e?.message || e).slice(0, 200)}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error("assertion failed: " + msg);
};
const claim = (token) => admin.rpc("claim_spin", { p_token: token });

const rand = Math.random().toString(36).slice(2, 8);
let userId = null;
let wheelA = null;
let wheelB = null;
let tokenSeq = 0;

async function makeWheel(title) {
  const { data, error } = await admin
    .from("wheels")
    .insert({ creator_id: userId, title })
    .select("id")
    .single();
  assert(!error, `insert wheel: ${error?.message}`);
  return data.id;
}

/** Mint a fan + a pass on a wheel. Returns { token, fanId }. */
async function mintPass({
  balance = 0,
  wheel = wheelA,
  active = true,
  selfExcluded = false,
  blocked = false,
  fanId = null,
}) {
  if (!fanId) {
    const { data: fan, error: fErr } = await admin
      .from("fans")
      .insert({
        creator_id: userId,
        spins_remaining: balance,
        spins_granted_total: balance,
        blocked_at: blocked ? new Date().toISOString() : null,
      })
      .select("id")
      .single();
    assert(!fErr, `insert fan: ${fErr?.message}`);
    fanId = fan.id;
  }
  const token = `e2e-${rand}-${tokenSeq++}`;
  const { error: pErr } = await admin.from("fan_passes").insert({
    token,
    creator_id: userId,
    wheel_id: wheel,
    fan_id: fanId,
    spins_remaining: balance,
    spins_granted_total: balance,
    is_active: active,
    self_excluded_at: selfExcluded ? new Date().toISOString() : null,
  });
  assert(!pErr, `insert fan_pass: ${pErr?.message}`);
  return { token, fanId };
}

async function passBalance(token) {
  const { data } = await admin
    .from("fan_passes")
    .select("spins_remaining")
    .eq("token", token)
    .single();
  return data?.spins_remaining;
}

async function cleanup() {
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
  log(`Spin-behaviors suite → ${URL}\n`);

  await step("setup: creator + two wheels", async () => {
    const email = `e2e-spin-${rand}@fanfunnel.test`;
    const { data: u, error } = await admin.auth.admin.createUser({
      email,
      password: "Test-" + rand + "-Aa1!",
      email_confirm: true,
    });
    assert(!error, `createUser: ${error?.message}`);
    userId = u.user.id;
    wheelA = await makeWheel("Wheel A");
    wheelB = await makeWheel("Wheel B");
  });

  await step("double-spend: 40 concurrent on balance 12 → exactly 12 win, lands at 0", async () => {
    const { token } = await mintPass({ balance: 12 });
    const settled = await Promise.all(Array.from({ length: 40 }, () => claim(token)));
    let ok = 0, noSpins = 0, rl = 0, errs = 0, minRemaining = Infinity;
    for (const { data, error } of settled) {
      if (error) errs++;
      else if (data === null) noSpins++;
      else if (data === -1) rl++;
      else { ok++; minRemaining = Math.min(minRemaining, data); }
    }
    log(`     success=${ok} noSpins=${noSpins} rateLimited=${rl} errors=${errs} minRemaining=${minRemaining}`);
    assert(errs === 0, `no RPC errors (got ${errs})`);
    assert(rl === 0, `rate limiter shouldn't trip (got ${rl})`);
    assert(ok === 12, `exactly 12 succeed (got ${ok})`);
    assert(noSpins === 28, `the other 28 report no-spins (got ${noSpins})`);
    assert(minRemaining >= 0, `never negative (min ${minRemaining})`);
    assert((await passBalance(token)) === 0, "final balance is 0");
  });

  await step("out of spins: claim on balance 0 → null", async () => {
    const { token } = await mintPass({ balance: 0 });
    const { data, error } = await claim(token);
    assert(!error, `rpc error: ${error?.message}`);
    assert(data === null, `expected null, got ${data}`);
  });

  await step("self-excluded pass → blocked (null)", async () => {
    const { token } = await mintPass({ balance: 5, selfExcluded: true });
    const { data } = await claim(token);
    assert(data === null, `self-excluded pass must not spin (got ${data})`);
    assert((await passBalance(token)) === 5, "balance untouched");
  });

  await step("blocked fan → blocked (null)", async () => {
    const { token } = await mintPass({ balance: 5, blocked: true });
    const { data } = await claim(token);
    assert(data === null, `blocked fan must not spin (got ${data})`);
    assert((await passBalance(token)) === 5, "balance untouched");
  });

  await step("inactive pass → blocked (null)", async () => {
    const { token } = await mintPass({ balance: 5, active: false });
    const { data } = await claim(token);
    assert(data === null, `inactive pass must not spin (got ${data})`);
    assert((await passBalance(token)) === 5, "balance untouched");
  });

  await step("rate limit: 8 recent spins in window → next claim returns -1 (429)", async () => {
    const { token, fanId } = await mintPass({ balance: 20 });
    const { data: pass } = await admin.from("fan_passes").select("id").eq("token", token).single();
    const rows = Array.from({ length: 8 }, () => ({
      fan_pass_id: pass.id,
      creator_id: userId,
      wheel_id: wheelA,
      fan_id: fanId,
      prize_label: "rate-limit filler",
    }));
    const { error: sErr } = await admin.from("spins").insert(rows);
    assert(!sErr, `insert spins: ${sErr?.message}`);
    const { data } = await claim(token);
    assert(data === -1, `expected -1 (rate limited), got ${data}`);
    assert((await passBalance(token)) === 20, "balance untouched while rate limited");
  });

  await step("per-wheel isolation: draining one pass leaves the fan's other pass intact", async () => {
    const a = await mintPass({ balance: 3, wheel: wheelA });
    const b = await mintPass({ balance: 5, wheel: wheelB, fanId: a.fanId }); // same fan
    // Drain pass A (3 claims succeed, 4th is null).
    for (let i = 0; i < 3; i++) assert((await claim(a.token)).data !== null, `A claim ${i + 1} should succeed`);
    assert((await claim(a.token)).data === null, "A is now empty");
    assert((await passBalance(a.token)) === 0, "pass A balance 0");
    assert((await passBalance(b.token)) === 5, "pass B balance untouched (per-wheel isolation)");
    // And pass B still spins.
    assert((await claim(b.token)).data === 4, "pass B still spins, now 4");
  });

  const passed = failures === 0;
  log(`\nRESULT: ${results.filter((r) => r[0]).length}/${results.length} checks passed`);
  log(passed ? "\n✅ SPIN BEHAVIORS PASSED" : "\n❌ SPIN BEHAVIORS FAILED");
  exitCode = passed ? 0 : 1;
} catch (e) {
  log("Spin-behaviors harness error: " + (e?.stack || e));
  exitCode = 1;
} finally {
  await cleanup();
  process.exit(exitCode);
}
