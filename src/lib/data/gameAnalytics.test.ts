import assert from "node:assert/strict";
import { FakeSupabase } from "./fakeSupabase";
import { readGamePlayCounts } from "./gameAnalytics";
import { creatorGameFeatures, gameSettings, requireGameFeature } from "./gameSettings";
import type { AnyClient } from "./shared";
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
async function main() {
  const db = new FakeSupabase("owner");
  for (let i = 0; i < 1201; i++) db.seed("spins", { creator_id: "owner", game_kind: i % 2 ? "wheel" : "scratch" });
  db.seed("spins", { creator_id: "foreign", game_kind: "scratch" });
  const client = db.client() as unknown as AnyClient;
  const counts = await readGamePlayCounts(client,"owner");
  check("exact scoped counts include history beyond display/database default limits", counts?.wheel === 600 && counts.scratch === 601 && counts.bingo === 0);
  db.beforeStatement = statement => statement.table === "spins" ? { message: "read unavailable" } : undefined;
  check("failed game counts remain unknown instead of false zero", await readGamePlayCounts(client,"owner") === null);
  check("features use strict database booleans and stage bingo off", creatorGameFeatures({ scratch: "true", bingo: true, custom: true }).scratch === false && creatorGameFeatures({ scratch: true, bingo: true }).scratch && !creatorGameFeatures({ bingo: true }).bingo && creatorGameFeatures({ custom: true }).custom);
  db.tables.profiles = [];
  db.seed("profiles", { id: "owner", features: { scratch: false } });
  await assert.rejects(() => requireGameFeature(client,"owner","scratch"), /feature_disabled/); passed++;
  await assert.rejects(() => requireGameFeature(client,"foreign","scratch"), /feature_disabled/); passed++;
  db.row("profiles","owner").features = { scratch: true };
  await requireGameFeature(client,"owner","scratch"); passed++;
  await assert.rejects(() => requireGameFeature(client,"owner","bingo"), /feature_disabled/); passed++;
  assert.throws(() => gameSettings("bingo", { size: 3, linePrizeId: "real-target" }), /game_unavailable/); passed++;
  assert.throws(() => gameSettings("scratch", { style: "classic", extra: "authority" }), /invalid_game/); passed++;
  check("scratch settings normalize only supported display data", JSON.stringify(gameSettings("scratch")) === '{"gameKind":"scratch","gameConfig":{"style":"classic"}}');
  console.log(`game capabilities/analytics: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
