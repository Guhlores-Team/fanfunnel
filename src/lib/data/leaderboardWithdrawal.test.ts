import assert from "node:assert/strict";
import { mock } from "node:test";
import { FakeTables, eqValue, on } from "@/lib/privacy/fakeTables";

// Execute the real data layer with only its Supabase transport replaced. The
// returned token pair is deliberately adversarial in the cross-creator case.
const creator = "creator-a", otherCreator = "creator-b";
const fan = { id: "fan-a", creator_id: creator, display_name: "Private Name", handle: "chosen_handle",
  leaderboard_opt_in: true, blocked_at: null as string | null, break_until: null as string | null,
  spins_remaining: 7, spins_granted_total: 10 };
const other = { id: "fan-b", creator_id: otherCreator, handle: "other_handle", leaderboard_opt_in: true, spins_remaining: 11 };
const pass = { token: "withdraw-token", fan_id: fan.id, creator_id: creator, campaign_id: null,
  wheel_id: "wheel-a", is_active: true, self_excluded_at: null as string | null, spins_remaining: 7 };
const wheel = { id: "wheel-a", creator_id: creator, archived_at: null as string | null, is_active: true,
  active_from: null, active_until: null, created_at: "2026-01-01T00:00:00Z" };
const svc = new FakeTables({
  fans: [fan, other], fan_passes: [pass], wheels: [wheel], campaigns: [],
  grants: [{ fan_id: fan.id, creator_id: creator, spins: 10 }],
  spins: [{ id: "earned-win", fan_id: fan.id, creator_id: creator, prize_rarity: "rare" }],
  profiles: [{ id: creator, public_slug: creator, display_name: "Creator", leaderboard_enabled: true }],
});
let inconsistentRead = false;
const runQuery = svc.run.bind(svc);
svc.run = (statement, options) => {
  const result = runQuery(statement, options);
  return inconsistentRead && statement.table === "fan_passes" && statement.op === "select"
    ? { ...result, error: { message: "inconsistent read" } } : result;
};
let configured = true, failTransport = false;
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => configured,
  createServiceClient: () => { if (failTransport) throw new Error("transport"); return svc; },
  createClient: async () => svc,
} });
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
const privacyOnly = () => {
  const writes = svc.statements.filter(statement => statement.op !== "select");
  return writes.length === 1 && writes[0].table === "fans" && writes[0].op === "update"
    && JSON.stringify(writes[0].payload) === JSON.stringify({ leaderboard_opt_in: false })
    && eqValue(writes[0], "id") === fan.id && eqValue(writes[0], "creator_id") === creator;
};
async function main() {
  const { setFanLeaderboardOptIn, getLeaderboard } = await import("./boosts");
  const { withdrawFanLeaderboardConsent } = await import("./privacy");
  const demo = await import("./mock");
  for (const state of ["normal", "break", "blocked", "paused", "archived", "paused-and-archived"] as const) {
    fan.leaderboard_opt_in = true; fan.handle = "chosen_handle";
    fan.blocked_at = state === "blocked" ? "2026-01-01T00:00:00Z" : null;
    fan.break_until = state === "break" ? "2099-01-01T00:00:00Z" : null;
    pass.is_active = !state.startsWith("paused"); pass.self_excluded_at = pass.is_active ? null : "2026-01-01T00:00:00Z";
    wheel.archived_at = state.includes("archived") ? "2026-01-01T00:00:00Z" : null;
    const beforeEconomic = JSON.stringify({ pass, wheel, grants: svc.rows("grants"), spins: svc.rows("spins"), balance: fan.spins_remaining });
    svc.statements.length = 0;
    const result = await setFanLeaderboardOptIn(pass.token, false, "UNREQUESTED-RENAME");
    check(`${state}: explicit withdrawal succeeds without play eligibility`, "ok" in result && Object.is(fan.leaderboard_opt_in, false));
    check(`${state}: write is only false consent pinned to both fan and creator`, privacyOnly());
    check(`${state}: withdrawal does not query wheels, campaigns or play state`, svc.statements.every(statement => ["fan_passes", "fans"].includes(statement.table))
      && on(svc, "fan_passes").length === 1 && on(svc, "fan_passes")[0].columns === "fan_id, creator_id"
      && on(svc, "fan_passes")[0].filters.length === 1 && eqValue(on(svc, "fan_passes")[0], "token") === pass.token);
    check(`${state}: handle, another fan and all economic/archived state stay intact`, fan.handle === "chosen_handle" && other.leaderboard_opt_in === true
      && JSON.stringify({ pass, wheel, grants: svc.rows("grants"), spins: svc.rows("spins"), balance: fan.spins_remaining }) === beforeEconomic);
    check(`${state}: successful withdrawal removes the public entry`, !(await getLeaderboard(creator)).entries.some(entry => entry.handle === "chosen_handle"));
  }
  fan.leaderboard_opt_in = true;
  for (const token of ["", "short token", "/bad", "%broken", "a".repeat(129), "bad\nline"]) {
    svc.statements.length = 0;
    const result = await withdrawFanLeaderboardConsent(token);
    check("malformed privacy token is refused before any database I/O", "error" in result && result.error === "not_found" && svc.statements.length === 0 && fan.leaderboard_opt_in === true);
  }
  svc.statements.length = 0;
  const unknown = await setFanLeaderboardOptIn("unknown-token", false);
  check("unknown token cannot affect any fan", "error" in unknown && unknown.error === "not_found"
    && !svc.statements.some(statement => statement.op !== "select") && fan.leaderboard_opt_in === true && other.leaderboard_opt_in === true);
  // A forged/inconsistent resolved pair must never reach the fan ID alone.
  pass.creator_id = otherCreator;
  svc.statements.length = 0;
  await setFanLeaderboardOptIn(pass.token, false);
  const foreignWrite = svc.statements.find(statement => statement.op === "update");
  check("foreign creator pair never updates the same-ID fan in another creator", fan.leaderboard_opt_in === true && other.leaderboard_opt_in === true
    && foreignWrite && eqValue(foreignWrite, "id") === fan.id && eqValue(foreignWrite, "creator_id") === otherCreator);
  pass.creator_id = creator;
  inconsistentRead = true; svc.statements.length = 0;
  const dataWithError = await setFanLeaderboardOptIn(pass.token, false);
  check("a token read containing data AND an error still fails closed", "error" in dataWithError && fan.leaderboard_opt_in === true
    && !svc.statements.some(statement => statement.op !== "select"));
  inconsistentRead = false;
  svc.failWhen = statement => statement.table === "fan_passes" ? "read failed" : null;
  svc.statements.length = 0;
  const failedRead = await setFanLeaderboardOptIn(pass.token, false);
  check("token read failure fails closed without claiming removal", "error" in failedRead && fan.leaderboard_opt_in === true
    && !svc.statements.some(statement => statement.op !== "select"));
  svc.failWhen = statement => statement.table === "fans" && statement.op === "update" ? "write failed" : null;
  const failedWrite = await setFanLeaderboardOptIn(pass.token, false);
  check("database write failure never claims success or clears consent", "error" in failedWrite && failedWrite.error === "db_error" && fan.leaderboard_opt_in === true);
  svc.failWhen = null; failTransport = true;
  const failedNetwork = await setFanLeaderboardOptIn(pass.token, false);
  check("transport exception returns a retryable error without mutation", "error" in failedNetwork && failedNetwork.error === "db_error" && fan.leaderboard_opt_in === true);
  failTransport = false;
  check("explicit retry succeeds after transport recovery", "ok" in await setFanLeaderboardOptIn(pass.token, false) && Object.is(fan.leaderboard_opt_in, false));
  // Joining keeps its existing active-pass and wheel requirements.
  pass.is_active = false; wheel.archived_at = null; svc.statements.length = 0;
  const pausedJoin = await setFanLeaderboardOptIn(pass.token, true, "join_name");
  check("paused token still cannot opt IN through privacy withdrawal", "error" in pausedJoin && pausedJoin.error === "not_found"
    && !svc.statements.some(statement => statement.op !== "select") && Object.is(fan.leaderboard_opt_in, false));
  pass.is_active = true; wheel.archived_at = "2026-01-01T00:00:00Z";
  const archivedJoin = await setFanLeaderboardOptIn(pass.token, true, "join_name");
  check("all-archived creator still cannot opt IN through a privacy bypass", "error" in archivedJoin && archivedJoin.error === "not_found" && Object.is(fan.leaderboard_opt_in, false));
  wheel.archived_at = null;
  check("ordinary eligible joining remains available", "ok" in await setFanLeaderboardOptIn(pass.token, true, "join_name") && fan.leaderboard_opt_in === true && fan.handle === "join_name");
  // A deleted token no longer resolves, even if a caller remembers its value.
  svc.tables.fan_passes = [];
  const deleted = await setFanLeaderboardOptIn(pass.token, false);
  check("deleted token cannot withdraw another remaining fan", "error" in deleted && deleted.error === "not_found" && other.leaderboard_opt_in === true);

  configured = false;
  demo.mockSetLeaderboardEnabled(true);
  for (const state of ["normal", "break", "blocked", "paused"] as const) {
    const created = demo.mockCreatePass(`Privacy ${state}`, 2);
    demo.mockSetFanLeaderboardOptIn(created.token, true, `mock_${state}`);
    if (state === "break") demo.mockTakeBreak(created.token, 60 * 60 * 1000);
    if (state === "blocked") demo.mockSetFanBlocked(created.fanId, true);
    if (state === "paused") demo.mockSelfExclude(created.token);
    const before = demo.mockExportFanData(created.token)!;
    const result = await setFanLeaderboardOptIn(created.token, false, "UNREQUESTED-RENAME");
    const after = demo.mockExportFanData(created.token)!;
    check(`mock ${state}: false withdrawal works and keeps chosen handle`, "ok" in result && after.consents.leaderboardOptIn === false && after.profile.handle === before.profile.handle);
    check(`mock ${state}: balances, earned history, links and another fan stay intact`, JSON.stringify(after.links) === JSON.stringify(before.links)
      && JSON.stringify(after.spins) === JSON.stringify(before.spins) && JSON.stringify(after.topUps) === JSON.stringify(before.topUps));
    check(`mock ${state}: public entry is removed`, !demo.mockGetLeaderboard().entries.some(entry => entry.handle === `mock_${state}`));
    if (state === "paused") {
      const result = await setFanLeaderboardOptIn(created.token, true, "rejoin_name");
      check("mock paused token cannot rejoin, matching real active-pass requirement", "error" in result && result.error === "not_found" && demo.mockExportFanData(created.token)?.consents.leaderboardOptIn === false);
    }
  }
  const archiveFan = demo.mockCreatePass("Archived Privacy", 2);
  demo.mockSetFanLeaderboardOptIn(archiveFan.token, true, "mock_archived");
  for (const row of demo.mockListWheels(true)) demo.mockArchiveWheel(row.id);
  const archivedMock = await setFanLeaderboardOptIn(archiveFan.token, false);
  check("mock all-archived false withdrawal matches real privacy path", "ok" in archivedMock && !demo.mockGetLeaderboard().entries.some(entry => entry.handle === "mock_archived"));
  check("mock unknown privacy token remains denied", "error" in await setFanLeaderboardOptIn("unknown-token", false));
  const deleteFan = demo.mockCreatePass("Deleted Privacy", 2);
  await demo.mockDeleteFanData(deleteFan.token);
  check("mock deleted token remains denied", "error" in await setFanLeaderboardOptIn(deleteFan.token, false));
  console.log(`LeaderboardWithdrawal data: ${passed} actual real/mock privacy and negative authorization checks passed`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
