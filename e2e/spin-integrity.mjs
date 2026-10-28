// Real-Supabase spin-BEHAVIORS suite — the DB-enforced rules that guard the
// core mechanic, which mock mode + unit tests cannot exercise (real concurrent
// Postgres, RLS, and the atomic attempt ledger). The TS engine itself (weighting, pity,
// stock, fairness RNG) is covered by src/lib/games/wheel/*.test.ts.
//
// Covered here, all via real prepare/commit_spin_attempt transactions:
//   1. Double-spend: N concurrent claims on a balance of N → exactly N succeed.
//   2. Out of spins → no_spins.
//   3. Self-excluded pass → blocked (unavailable).
//   4. Blocked fan → blocked (unavailable).
//   5. Inactive pass → blocked (unavailable).
//   6. Rate limit: >8 spins in 10s → rate_limited (HTTP 429).
//   7. Per-wheel isolation: draining one pass doesn't touch the fan's other pass.
//
// Headless; skips when secrets absent; sets up + tears down its own data.

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { requireTestProject, createFixturePass, commitSinglePrizeFixture, FIXTURE_TERMS_VERSION } from "./economic-fixtures.mjs";
import { log, requireSupabaseEnvOrExit } from "./supabase-env.mjs";

const { URL, ANON, SERVICE } = requireSupabaseEnvOrExit();
requireTestProject(URL);
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
const claim = (token, requestId = randomUUID()) => commitSinglePrizeFixture(admin, token, { requestId });

const rand = Math.random().toString(36).slice(2, 8);
let userId = null;
let wheelA = null;
let wheelB = null;
let actor = null;

async function makeWheel(title) {
  const { data, error } = await admin
    .from("wheels")
    .insert({ creator_id: userId, title })
    .select("id")
    .single();
  assert(!error, `insert wheel: ${error?.message}`);
  const { error: prizeError } = await admin.from("prizes").insert({ wheel_id: data.id, label: "Atomic fixture prize", rarity: "common", weight: 10 });
  assert(!prizeError, `insert deterministic prize: ${prizeError?.message}`);
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
  const grant = await createFixturePass(admin, actor, { wheelId: wheel, fanId, spins: balance });
  fanId = grant.fanId;
  const { error: fanError } = await admin.from("fans").update({ acked_at: new Date().toISOString(), acked_terms_version: FIXTURE_TERMS_VERSION,
    ...(blocked ? { blocked_at: new Date().toISOString() } : {}) }).eq("id", fanId);
  assert(!fanError, `ack/block fixture fan: ${fanError?.message}`);
  const { error: passError } = await admin.from("fan_passes").update({ is_active: active, self_excluded_at: selfExcluded ? new Date().toISOString() : null }).eq("id", grant.passId);
  assert(!passError, `pass safety fixture: ${passError?.message}`);
  return { token: grant.token, fanId, passId: grant.passId };

}

async function passBalance(token) {
  const { data } = await admin
    .from("fan_passes")
    .select("spins_remaining")
    .eq("token", token)
    .single();
  return data?.spins_remaining;
}

/** Returns false if the test user couldn't be deleted, so the run fails
 *  instead of silently leaking it into the project. */
async function cleanup() {
  if (!userId) return true;
  try {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw error;
    return true;
  } catch (e) {
    log(`✗ CLEANUP FAILED: could not delete test user ${userId} — ${e?.message ?? e}`);
    return false;
  }
}

let exitCode = 1;
try {
  log(`Spin-behaviors suite → ${URL}\n`);

  await step("setup: creator + two wheels", async () => {
    const email = `e2e-spin-${rand}@fanfunnel.test`;
    const password = "Test-" + rand + "-Aa1!";
    const { data: u, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    assert(!error, `createUser: ${error?.message}`);
    userId = u.user.id;
    const { data: approved, error: approvalError } = await admin.from("profiles")
      .update({ approval_status: "approved", is_active: true }).eq("id", userId).select("id").single();
    assert(!approvalError && !!approved, `approve spin fixture: ${approvalError?.message ?? "no profile"}`);
    const client = createClient(URL, ANON, { auth: { persistSession: false } });
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    assert(!signInError, `sign in fixture actor: ${signInError?.message}`);
    actor = { id: userId, client };
    wheelA = await makeWheel("Wheel A");
    wheelB = await makeWheel("Wheel B");
  });

  await step("double-spend: 40 concurrent on balance 5 → exactly 5 win, lands at 0", async () => {
    // Tests the row-lock that prevents overselling under concurrency. Balance (5)
    // is below the per-fan in-row rate cap (8 / 10s, migration 0028), so the
    // BALANCE is the binding constraint — exactly 5 claims may win regardless of
    // how the rate limiter throttles the rest. Rate-limited claims (-1) return
    // before touching the balance, so they can't affect the no-oversell invariant.
    const { token } = await mintPass({ balance: 5 });
    const settled = await Promise.all(Array.from({ length: 40 }, () => claim(token)));
    let ok = 0, noSpins = 0, rl = 0, errs = 0, minRemaining = Infinity;
    for (const result of settled) {
      if (result.status === "declined" && result.error === "no_spins") noSpins++;
      else if (result.status === "declined" && result.error === "rate_limited") rl++;
      else if (result.status === "committed") { ok++; minRemaining = Math.min(minRemaining, result.balance); }
      else errs++;
    }
    log(`     success=${ok} noSpins=${noSpins} rateLimited=${rl} errors=${errs} minRemaining=${minRemaining}`);
    assert(errs === 0, `no RPC errors (got ${errs})`);
    assert(ok === 5, `exactly 5 win — no oversell (got ${ok})`);
    assert(ok + noSpins + rl === 40, `all 40 accounted (got ${ok + noSpins + rl})`);
    assert(minRemaining >= 0, `never negative (min ${minRemaining})`);
    assert((await passBalance(token)) === 0, "final balance is 0");
    const won = settled.filter(result => result.status === "committed");
    assert(new Set(won.map(result => result.id)).size === 5, "five distinct requests produced exactly five durable receipts");
    for (const receipt of won) {
      const replay = await claim(token, receipt.requestId);
      assert(replay.status === "committed" && replay.id === receipt.id && replay.balance === 0, "same-ID replay returns its immutable win and current balance");
    }
    assert((await passBalance(token)) === 0, "receipt replay cannot debit an empty pass");
  });

  await step("out of spins: atomic play on balance 0 → no_spins", async () => {
    const { token } = await mintPass({ balance: 0 });
    const result = await claim(token);
    assert(result.status === "declined" && result.error === "no_spins", "empty pass is explicitly declined without a debit");
  });

  await step("self-excluded pass → blocked (unavailable)", async () => {
    const { token } = await mintPass({ balance: 5, selfExcluded: true });
    const result = await claim(token);
    assert(result.status === "unavailable", "self-excluded pass must not spin");
    assert((await passBalance(token)) === 5, "balance untouched");
  });

  await step("blocked fan → blocked (unavailable)", async () => {
    const { token } = await mintPass({ balance: 5, blocked: true });
    const result = await claim(token);
    assert(result.status === "unavailable", "blocked fan must not spin");
    assert((await passBalance(token)) === 5, "balance untouched");
  });

  await step("inactive pass → blocked (unavailable)", async () => {
    const { token } = await mintPass({ balance: 5, active: false });
    const result = await claim(token);
    assert(result.status === "unavailable", "inactive pass must not spin");
    assert((await passBalance(token)) === 5, "balance untouched");
  });

  await step("rate limit: in-row window counter at cap → atomic play is rate_limited (429)", async () => {
    const { token, fanId } = await mintPass({ balance: 20 });
    // 0028 enforces the per-fan limit via an IN-ROW fixed-window counter
    // (fans.rl_window_start / rl_count), not by counting public.spins. Prime the
    // counter to the cap (8) inside an open window; the next claim must throttle.
    const { error: uErr } = await admin
      .from("fans")
      .update({ rl_window_start: new Date().toISOString(), rl_count: 8 })
      .eq("id", fanId);
    assert(!uErr, `prime rl counter: ${uErr?.message}`);
    const result = await claim(token);
    assert(result.status === "declined" && result.error === "rate_limited", "in-row rate cap explicitly declines the atomic play");
    assert((await passBalance(token)) === 20, "balance untouched while rate limited");
  });

  await step("per-wheel isolation: draining one pass leaves the fan's other pass intact", async () => {
    const a = await mintPass({ balance: 3, wheel: wheelA });
    const b = await mintPass({ balance: 5, wheel: wheelB, fanId: a.fanId }); // same fan
    // Drain pass A (3 claims succeed, 4th is null).
    for (let i = 0; i < 3; i++) assert((await claim(a.token)).status === "committed", `A claim ${i + 1} should succeed`);
    const empty = await claim(a.token);
    assert(empty.status === "declined" && empty.error === "no_spins", "A is now empty");
    assert((await passBalance(a.token)) === 0, "pass A balance 0");
    assert((await passBalance(b.token)) === 5, "pass B balance untouched (per-wheel isolation)");
    // And pass B still spins.
    const bWin = await claim(b.token);
    assert(bWin.status === "committed" && bWin.balance === 4, "pass B still spins, now 4");
    const { data: fan, error: fanError } = await admin.from("fans").select("spins_remaining").eq("id", a.fanId).single();
    assert(!fanError && fan.spins_remaining === 4, "fan aggregate equals the remaining A+B pass balances");
  });

  const passed = failures === 0;
  log(`\nRESULT: ${results.filter((r) => r[0]).length}/${results.length} checks passed`);
  log(passed ? "\n✅ SPIN BEHAVIORS PASSED" : "\n❌ SPIN BEHAVIORS FAILED");
  exitCode = passed ? 0 : 1;
} catch (e) {
  log("Spin-behaviors harness error: " + (e?.stack || e));
  exitCode = 1;
} finally {
  if (!(await cleanup())) exitCode = 1;
  process.exit(exitCode);
}
