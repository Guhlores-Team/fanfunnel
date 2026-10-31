import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// A20 / A43: the pre-0059 claim → record → stock → refund spin path is gone.
// Its RPCs (claim_spin, rollback_claimed_spin, reserve_reward_code,
// release_reward_code, finalize_reward_spin) were revoked from EVERY role in
// 0059, so any surviving caller would fail at runtime in production while
// still passing unit tests against a fake. This guard fails the build the
// moment one comes back. The live path is commitSpinAttempt (spinAttempts.ts).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const ROOT = join(import.meta.dirname, "../../..");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}
const sources = walk(join(ROOT, "src")).filter((p) => !p.endsWith(".test.ts") && !p.endsWith("db.types.ts"));
const rel = (p: string) => relative(ROOT, p);

const REVOKED_RPCS = ["claim_spin", "rollback_claimed_spin", "reserve_reward_code", "release_reward_code", "finalize_reward_spin"];
const DEAD_HELPERS = ["completeClaimedSpin", "recordClaimedSpin", "takeStockUnit", "finalizeInstantSpin", "reserveRewardCode", "releaseRewardCode", "consumeCommittedSeed", "loadPrizeReward"];

const rpcCallers: string[] = [];
const helperUsers: string[] = [];
for (const p of sources) {
  const s = readFileSync(p, "utf8");
  for (const name of REVOKED_RPCS) {
    if (new RegExp(`rpc\\(\\s*["'\`]${name}["'\`]`).test(s)) rpcCallers.push(`${rel(p)} → ${name}`);
  }
  for (const name of DEAD_HELPERS) {
    if (new RegExp(`\\b${name}\\b`).test(s)) helperUsers.push(`${rel(p)} → ${name}`);
  }
}
for (const c of rpcCallers) console.error("  ✗ calls a revoked RPC:", c);
check("no source file calls an RPC that 0059 revoked from every role", rpcCallers.length === 0);
for (const u of helperUsers) console.error("  ✗ dead spin helper still present:", u);
check("the legacy spin helpers no longer exist in src/", helperUsers.length === 0);

for (const gone of ["src/lib/rewards/finalize.ts", "src/lib/data/spinSeed.ts", "src/lib/data/liveStock.ts"]) {
  check(`${gone} was deleted`, !sources.some((p) => rel(p) === gone));
}

const spins = readFileSync(join(ROOT, "src/lib/data/spins.ts"), "utf8");
check("spin() commits through the 0059 attempt ledger only", /return commitSpinAttempt\(token, \{ requestId, clientSeed, publishedSeedHash \}, sb\);/.test(spins));
check("spins.ts has no stock, seed or redemption writes of its own", !/\.from\("(prizes|spins|redemptions)"\)\s*\.(insert|update|delete)/.test(spins.replace(/\s+/g, " ")) && !/from\("fan_passes"\)\s*\.update/.test(spins.replace(/\s+/g, " ")));

// Only the ledger (and the demo mock) may write a spin's economic state.
const writers = sources.filter((p) => {
  const s = readFileSync(p, "utf8").replace(/\s+/g, " ");
  return /from\("spins"\) ?\.(insert|update|delete)/.test(s) || /from\("prizes"\) ?\.update\(\{ ?stock/.test(s);
});
for (const w of writers) console.error("  ✗ direct spin/stock writer:", rel(w));
check("no TS module writes spin rows or prize stock directly (the SQL commit owns them)", writers.length === 0);

console.log(`deadSpinPath.test: ${passed} checks passed`);
