import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ATK-01: every fan-side route that acts in the fan's name refuses a request
// carrying a creator session (negative test: the guard is wired, not merely written).
const routes = [
  ["src/app/api/fans/ack/route.ts", /refuseCreatorSession\(body\.token\)/],
  ["src/app/api/leaderboard/opt-in/route.ts", /refuseCreatorSession\(body\.token\)/],
  ["src/app/api/self-exclude/route.ts", /refuseCreatorSession\(body\.token\)/],
  ["src/app/api/fan/reward/route.ts", /refuseCreatorSession\(token\)/],
  ["src/app/api/fan/break/route.ts", /refuseCreatorSession\(token\)/],
  ["src/app/api/fan-data/delete/route.ts", /creatorActsForFan\(body\.token\)/],
  ["src/app/api/fan-data/export/route.ts", /creatorActsForFan\(body\.token\)/],
] as const;
let passed = 0;
for (const [file, call] of routes) {
  const source = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
  assert.ok(/from "@\/lib\/fan\/creatorGuard"/.test(source), `${file} imports the guard`);
  assert.ok(call.test(source), `${file} checks the request's creator session before acting`);
  passed += 2;
}
const guard = readFileSync(new URL("./creatorGuard.ts", import.meta.url), "utf8");
assert.ok(guard.startsWith('import "server-only";'), "the guard is server-only");
assert.ok(/rpc\("can_act_for"/.test(guard) && !/user_metadata|app_metadata/.test(guard), "roles come from can_act_for, never metadata");
assert.ok(/\.eq\("token", token\)/.test(guard), "the creator comes from the pass row of the posted token, never from the client");
passed += 3;
console.log(`creatorGuard.static: ${passed} checks passed`);
