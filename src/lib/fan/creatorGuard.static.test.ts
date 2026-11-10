import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ATK-01: every fan-side route that acts in the fan's name refuses a request
// carrying a creator session (negative test: the guard is wired, not merely written).
// The guard runs FIRST: ahead of the per-address miss budget and of every
// route limiter, so a creator session never spends a fan's budget and the 403
// does not depend on what the address did before.
const direct = [
  "src/app/api/fans/ack/route.ts",
  "src/app/api/leaderboard/opt-in/route.ts",
  "src/app/api/self-exclude/route.ts",
  "src/app/api/fan-data/delete/route.ts",
  "src/app/api/fan-data/export/route.ts",
] as const;
const viaFanToken = ["src/app/api/fan/reward/route.ts", "src/app/api/fan/break/route.ts", "src/app/api/fan/mute/route.ts"] as const;
const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
let passed = 0;
for (const file of direct) {
  const source = read(file);
  const at = source.indexOf("refuseCreatorSession(req, token)");
  assert.ok(/from "@\/lib\/fan\/creatorGuard"/.test(source), `${file} imports the guard`);
  assert.ok(at > 0, `${file} checks the request's creator session`);
  assert.ok(at < source.indexOf("withFanMissLimit(req"), `${file} checks it before the miss budget`);
  assert.ok(at < source.indexOf("rateLimitOr429("), `${file} checks it before its own limiter`);
  assert.ok(!/creatorActsForFan/.test(source), `${file} uses the one entry point (which carries the guard's own budget)`);
  passed += 5;
}
for (const file of viaFanToken) {
  assert.ok(/withFanToken<[^>]+>\(\s*req,[^{]*\{[^}]*fanOnly: true[^}]*\}/.test(read(file)), `${file} is a fan-only route of withFanToken`);
  passed++;
}
const wrapper = read("src/lib/api/fanToken.ts");
const guardAt = wrapper.indexOf("refuseCreatorSession(req, token)");
assert.ok(guardAt > 0 && guardAt < wrapper.indexOf("return withFanMissLimit(") && guardAt < wrapper.indexOf("rateLimitOr429("), "withFanToken refuses a creator session before the miss budget and the route limiter");
passed++;
const guard = readFileSync(new URL("./creatorGuard.ts", import.meta.url), "utf8");
assert.ok(guard.startsWith('import "server-only";'), "the guard is server-only");
assert.ok(/rpc\("can_act_for"/.test(guard) && !/user_metadata|app_metadata/.test(guard), "roles come from can_act_for, never metadata");
assert.ok(/\.eq\("token", token\)/.test(guard), "the creator comes from the pass row of the posted token, never from the client");
const budgetAt = guard.indexOf("rateLimitShared(`creatorguard:");
assert.ok(guard.indexOf("if (!(await hasSessionCookie())) return null;", guard.indexOf("export async function refuseCreatorSession")) < budgetAt
  && budgetAt < guard.indexOf("creatorActsForFan(token)", budgetAt), "the guard's own budget is counted after the cookie test and before the lookup");
passed += 4;
console.log(`creatorGuard.static: ${passed} checks passed`);
