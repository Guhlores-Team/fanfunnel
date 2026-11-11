import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makeFairRngV3 } from "@/lib/games/wheel/fairness";
import {
  buildFocusPoolSnapshot, canonicalJson, drawFromSnapshot, hashPoolSnapshot, parsePoolSnapshot, replayV3,
  type PoolSnapshot, type FairTrace,
} from "@/lib/games/wheel/fairnessV3";
import { RARITY_ORDER, type WheelConfig } from "@/lib/games/wheel/types";
import { modifierLines } from "@/app/verify/[shareId]/oddsCopy";
import { OddsUsed } from "@/app/verify/[shareId]/OddsUsed";
import type { ModifierOptions } from "./modifiers";

let passed = 0;
function check(label: string, condition: boolean) { assert.ok(condition, label); passed++; }
function random(seed: number) {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
}

async function main() {
  const wheel: WheelConfig = {
    id: "w", title: "W",
    prizes: [
      { id: "a", label: "A", rarity: "common", weight: 10, stock: null, cost: 99999 },
      { id: "b", label: "B", rarity: "rare", weight: 2, stock: null, cost: 99999 },
    ],
  };
  const options = { happyHourMultiplier: 2, pityCounter: 0, focus: { prizeId: "a", multiplier: 3, spinsLeft: 7, totalSpins: 10 } };
  const snapshot = buildFocusPoolSnapshot(wheel, options);
  check("new rules are explicit", snapshot.rules === "focus-v1");
  check("base and effective ticket math recorded", snapshot.prizes[0].baseW === 10 && snapshot.prizes[0].w === 30 && snapshot.prizes[1].baseW === 2 && snapshot.prizes[1].w === 4);
  check("prize proof fields are an exact safe allowlist", snapshot.prizes.every((p) => Object.keys(p).sort().join() === "baseW,emoji,id,label,rarity,w"));
  check("public proof has no economic/secret identifiers", !/cost|price|cipher|token|creatorId|fanId|grantId|focusId|codeId|reservationId|99999/.test(JSON.stringify(snapshot)));
  const parsed = parsePoolSnapshot(JSON.parse(JSON.stringify(snapshot)));
  check("new proof round-trips", parsed.ok && canonicalJson(parsed.snapshot) === canonicalJson(snapshot));
  for (const tamper of [
    (s: PoolSnapshot) => { s.prizes[0].w++; },
    (s: PoolSnapshot) => { s.prizes[0].baseW!++; },
    (s: PoolSnapshot) => { s.modifiers.focus!.effectiveMultiplier = 5; },
    (s: PoolSnapshot) => { s.modifiers.focus!.pauseReason = "sold_out"; },
    (s: PoolSnapshot) => { s.modifiers.chase = { prizeId: "a", counter: 0, within: 5, reserved: true, eligible: true, pauseReason: null }; },
  ]) {
    const bad = structuredClone(snapshot); tamper(bad);
    check("inconsistent modifier math/state refused even if a caller rehashes it", !parsePoolSnapshot(bad).ok);
  }
  check("unknown top-level data refused", !parsePoolSnapshot({ ...snapshot, extra: "secret" }).ok);
  const hidden = structuredClone(snapshot) as unknown as { prizes: Record<string, unknown>[] };
  hidden.prizes[0].cipher = "hidden";
  check("unknown private prize field refused", !parsePoolSnapshot(hidden).ok);
  const missingBase = structuredClone(snapshot) as unknown as { prizes: Record<string, unknown>[] };
  delete missingBase.prizes[0].baseW;
  check("mixed old/new proof prize shapes refused", !parsePoolSnapshot(missingBase).ok);
  check("focus verify text names actual capped boost", modifierLines(snapshot, false).some((line) => /combined multiplier was ×3/.test(line)));
  const sampleHash = await hashPoolSnapshot(snapshot);
  const samplePick = drawFromSnapshot(snapshot, new Set(), await makeFairRngV3("sample", "client", 1, sampleHash));
  const sampleReplay = await replayV3({ serverSeed: "sample", clientSeed: "client", nonce: 1, snapshot, poolHash: sampleHash, trace: { excluded: [], won: samplePick.prize.id }, prizeId: samplePick.prize.id, prizeLabel: samplePick.prize.label });
  const rendered = renderToStaticMarkup(createElement(OddsUsed, { replay: sampleReplay, poolHash: sampleHash }));
  check("proof table displays original and effective tickets", rendered.includes("Tickets used") && rendered.includes("Base 10") && rendered.includes("Base 2"));
  check("proof display never receives creator costs", !rendered.includes("99999"));
  const guaranteed = buildFocusPoolSnapshot(wheel, { happyHourMultiplier: null, pityCounter: 9, chase: { prizeId: "a", counter: 4, within: 5, reserved: false } });
  const copy = modifierLines(guaranteed, false);
  check("common chase proof does not falsely claim rare-only odds", copy.some((line) => /took precedence/.test(line)) && !copy.some((line) => /could only land rare/.test(line)));

  // A legacy v3 fixture with HH×10 must retain its exact canonical hash.
  const legacy = {
    v: 3, game: "wheel",
    prizes: [{ id: "a", label: "A", emoji: null, rarity: "common", w: 8 }, { id: "b", label: "B", emoji: null, rarity: "rare", w: 2 }],
    modifiers: { happyHour: { multiplier: 10 }, pity: { counter: 0, threshold: 10 }, focus: null, chase: null },
  };
  const old = parsePoolSnapshot(legacy);
  check("legacy high HH remains readable", old.ok);
  if (!old.ok) throw new Error(old.reason);
  check("legacy parser never injects new keys", !Object.hasOwn(old.snapshot, "rules") && old.snapshot.prizes.every((p) => !Object.hasOwn(p, "baseW")));
  check("historical hash remains byte-for-byte stable", await hashPoolSnapshot(old.snapshot) === "97bcb5621eb4ef5f218c8f408eac0d777ef5482631b68031e4ccde0dc4805aa3");
  check("historical HH explanation retains its uncapped rule", modifierLines(old.snapshot, false)[0].includes("×10 tickets"));

  // Reproduce10,000 new outcomes through public strict parsing and replay,
  // including JSONB key ordering, pauses, both guarantees and stock re-draws.
  const rngFixture = random(2592026);
  let focused = 0, paused = 0, chases = 0, forced = 0, exclusions = 0;
  const N = 10_000;
  for (let i = 0; i < N; i++) {
    const config: WheelConfig = {
      id: `wheel-${i}`, title: "W",
      prizes: Array.from({ length: 2 + Math.floor(rngFixture() * 4) }, (_, p) => ({
        id: `p${p}`, label: `Prize ${p}`, rarity: RARITY_ORDER[Math.floor(rngFixture() * 5)],
        weight: Math.floor(rngFixture() * 100), stock: p === 1 ? null : rngFixture() < 0.2 ? 0 : 2,
      })),
    };
    const mode = i % 4;
    const opts: ModifierOptions = { happyHourMultiplier: rngFixture() < 0.6 ? 1 + Math.floor(rngFixture() * 18) / 2 : null, pityCounter: Math.floor(rngFixture() * 14) };
    if (mode === 1 || mode === 3) opts.focus = { prizeId: mode === 3 && i % 3 === 0 ? "elsewhere" : "p0", multiplier: 1.5 + Math.floor(rngFixture() * 8) / 2, spinsLeft: 1 + Math.floor(rngFixture() * 10), totalSpins: 10 };
    if (mode === 2) opts.chase = { prizeId: "p0", counter: Math.floor(rngFixture() * 5), within: 5, reserved: true };
    const pool = buildFocusPoolSnapshot(config, opts);
    if (pool.modifiers.focus?.applied) focused++;
    if (pool.modifiers.focus && !pool.modifiers.focus.applied) paused++;
    if (pool.modifiers.chase?.eligible) chases++;
    const poolHash = await hashPoolSnapshot(pool);
    const seed = i.toString(16).padStart(64, "0");
    const client = `client-${i}`;
    const rng = await makeFairRngV3(seed, client, i, poolHash);
    const excluded = new Set<string>();
    const trace: FairTrace = { excluded: [], won: "" };
    let draw = drawFromSnapshot(pool, excluded, rng);
    if (i % 5 === 0 && pool.prizes.length > 1 && !(pool.modifiers.chase?.eligible && pool.modifiers.chase.prizeId === draw.prize.id)) {
      excluded.add(draw.prize.id); trace.excluded.push(draw.prize.id); exclusions++;
      draw = drawFromSnapshot(pool, excluded, rng);
    }
    trace.won = draw.prize.id;
    if (draw.chaseAwarded) forced++;
    const stored = JSON.parse(JSON.stringify({ ...pool, prizes: [...pool.prizes].reverse() }));
    const replay = await replayV3({ serverSeed: seed, clientSeed: client, nonce: i, snapshot: stored, poolHash, trace, prizeId: draw.prize.id, prizeLabel: draw.prize.label });
    assert.ok(replay.ok, `case${i}: ${replay.problem}`);
    assert.equal(replay.replayed?.id, draw.prize.id);
    assert.equal(replay.pityAwarded, draw.pityAwarded);
    assert.equal(replay.chaseAwarded, draw.chaseAwarded ?? false);
    assert.equal(replay.chaseCompleted, draw.chaseCompleted ?? false);
    assert.equal(replay.focusConsumed, draw.focusConsumed ?? false);
    assert.equal(replay.chaseConsumed, draw.chaseConsumed ?? false);
    if (i < 100) {
      const altered = structuredClone(pool); altered.prizes[0].w++;
      check("tampered effective tickets never pass", !(await replayV3({ serverSeed: seed, clientSeed: client, nonce: i, snapshot: altered, poolHash, trace, prizeId: draw.prize.id, prizeLabel: draw.prize.label })).ok);
    }
  }
  check("property cases include applied focus", focused > 1000);
  check("property cases include paused/no-effect focus", paused > 1000);
  check("property cases include reserved chase", chases === N / 4);
  check("property cases include forced chase", forced > 300);
  check("property cases include real stock exclusions", exclusions > 500);
  console.log(`focus proof: ${passed} checks + ${N} seeded full replays passed (focus=${focused}, paused=${paused}, chase=${chases}, forced=${forced}, exclusions=${exclusions})`);
}
main().catch((error) => { console.error(error); process.exit(1); });
