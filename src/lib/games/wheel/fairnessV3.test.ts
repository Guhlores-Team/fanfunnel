// Fairness v3 (F2): canonicalization, hashing, replay, tamper detection, the
// v2 derivation left untouched, and "same pool, same odds".
import assert from "node:assert";
import { createHash } from "node:crypto";
import { applyRareBoost, availablePrizes, prizeOdds } from "./engine";
import { makeFairRng, makeFairRngV3 } from "./fairness";
import {
  buildPoolSnapshot,
  canonicalJson,
  drawFromSnapshot,
  hashPoolSnapshot,
  parsePoolSnapshot,
  replayV3,
  snapshotOdds,
  type FairTrace,
  type PoolSnapshot,
  type V3ReplayInput,
} from "./fairnessV3";
import { SAMPLE_WHEEL } from "./sample";
import { ODDS_LOCKED_LINE, formatChance, modifierLines } from "@/app/verify/[shareId]/oddsCopy";
import type { Prize, Rarity, WheelConfig } from "./types";
import { RARITY_ORDER } from "./types";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

/** Small deterministic PRNG for building test fixtures (not the spin RNG). */
function fixtureRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Round-trip through JSON with every object's keys shuffled, like a jsonb read. */
function jsonbRoundTrip<T>(value: T, r: () => number): T {
  const shuffle = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(shuffle);
    if (v && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      entries.sort(() => r() - 0.5);
      return Object.fromEntries(entries.map(([k, x]) => [k, shuffle(x)]));
    }
    return v;
  };
  return JSON.parse(JSON.stringify(shuffle(value))) as T;
}

function randomWheel(r: () => number, i: number): WheelConfig {
  const n = 1 + Math.floor(r() * 12);
  const prizes: Prize[] = Array.from({ length: n }, (_, j) => ({
    id: `p-${i}-${Math.floor(r() * 1e9).toString(36)}-${j}`,
    label: `Prize ${j} ✨`,
    rarity: RARITY_ORDER[Math.floor(r() * RARITY_ORDER.length)],
    weight: r() < 0.1 ? 0 : 1 + Math.floor(r() * 500),
    emoji: r() < 0.5 ? "🎁" : undefined,
    cost: Math.floor(r() * 5000),
    description: "creator note",
    stock: r() < 0.3 ? Math.floor(r() * 3) : null,
  }));
  return { id: `w-${i}`, title: "W", prizes };
}

/** What the server does: draw, lose some stock races, record the trace. */
async function serverSpin(
  wheel: WheelConfig,
  opts: { serverSeed: string; clientSeed: string; nonce: number; hh: number | null; pity: number },
  soldOutMidSpin: (id: string) => boolean,
) {
  const snapshot = buildPoolSnapshot(wheel, { happyHourMultiplier: opts.hh, pityCounter: opts.pity });
  const poolHash = await hashPoolSnapshot(snapshot);
  const rng = await makeFairRngV3(opts.serverSeed, opts.clientSeed, opts.nonce, poolHash);
  const excluded = new Set<string>();
  const order: string[] = [];
  for (let attempt = 0; attempt < snapshot.prizes.length + 1; attempt++) {
    let draw;
    try {
      draw = drawFromSnapshot(snapshot, excluded, rng);
    } catch {
      return null; // nothing left: the real path refunds
    }
    const live = wheel.prizes.find((p) => p.id === draw.prize.id)!;
    if (live.stock != null && soldOutMidSpin(live.id)) {
      excluded.add(live.id);
      order.push(live.id);
      continue;
    }
    const trace: FairTrace = { excluded: order, won: live.id };
    return { snapshot, poolHash, trace, prize: live };
  }
  return null;
}

async function main() {
  // --- canonical JSON ---------------------------------------------------------
  check("keys sorted at every level", canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } }) === '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  check("key order does not change the output", canonicalJson({ a: 1, b: 2 }) === canonicalJson({ b: 2, a: 1 }));
  check("arrays keep their order", canonicalJson([2, 1]) !== canonicalJson([1, 2]));
  check("undefined keys are dropped", canonicalJson({ a: undefined, b: null }) === '{"b":null}');
  for (const bad of [NaN, Infinity, -Infinity]) {
    let threw = false;
    try {
      canonicalJson({ w: bad });
    } catch {
      threw = true;
    }
    check(`non-finite ${bad} is refused`, threw);
  }

  // --- snapshot construction -------------------------------------------------
  const costly: WheelConfig = {
    ...SAMPLE_WHEEL,
    prizes: SAMPLE_WHEEL.prizes.map((p, i) => ({
      ...p,
      id: ["zz", "m", "a", "q", "b", "k", "c"][i],
      cost: 777,
      description: "private",
      imageUrl: "https://example.test/x.png",
    })),
  };
  costly.prizes[5].stock = 0; // sold out
  const snap = buildPoolSnapshot(costly, { happyHourMultiplier: null, pityCounter: 3 });
  const ids = snap.prizes.map((p) => p.id);
  check("prizes ordered by id", ids.join(",") === [...ids].sort().join(","));
  check(
    "sold-out prizes left out exactly as prizeOdds/availablePrizes leave them out",
    ids.slice().sort().join(",") === availablePrizes(costly).map((p) => p.id).sort().join(",") && !ids.includes("k"),
  );
  check("weights are integers", snap.prizes.every((p) => Number.isInteger(p.w)));
  const json = JSON.stringify(snap);
  check("no cost in the snapshot", !/cost/i.test(json) && !json.includes("777"));
  check("no other creator-private or display-only field", !/description|private|imageUrl|example\.test|stock/.test(json));
  check(
    "each prize carries exactly id, label, emoji, rarity, w",
    snap.prizes.every((p) => Object.keys(p).sort().join(",") === "emoji,id,label,rarity,w"),
  );
  check(
    "modifiers are explicit: happy hour null, pity recorded, focus/chase null",
    snap.modifiers.happyHour === null &&
      snap.modifiers.pity.counter === 3 &&
      snap.modifiers.pity.threshold === 10 &&
      snap.modifiers.focus === null &&
      snap.modifiers.chase === null &&
      "focus" in snap.modifiers &&
      "chase" in snap.modifiers,
  );
  check("game kind recorded", snap.game === "wheel" && snap.v === 3);

  const hhSnap = buildPoolSnapshot(costly, { happyHourMultiplier: 1.5, pityCounter: 0 });
  const boosted = applyRareBoost(costly, 1.5);
  check(
    "happy hour applied exactly like applyRareBoost, multiplier recorded",
    hhSnap.modifiers.happyHour?.multiplier === 1.5 &&
      hhSnap.prizes.every((p) => boosted.prizes.find((b) => b.id === p.id)!.weight === p.w),
  );

  // --- no change to the odds for an unchanged pool ----------------------------
  for (const [label, cfg, m] of [
    ["sample wheel", SAMPLE_WHEEL, null],
    ["sample wheel, happy hour ×2", SAMPLE_WHEEL, 2],
    ["sold-out prize", costly, null],
  ] as const) {
    const s = buildPoolSnapshot(cfg, { happyHourMultiplier: m, pityCounter: 0 });
    const expected = prizeOdds(m ? applyRareBoost(cfg, m) : cfg);
    const got = snapshotOdds(s);
    check(
      `${label}: snapshot odds equal prizeOdds exactly`,
      got.rows.every(({ prize, chance }) => Math.abs(chance - expected.get(prize.id)!) < 1e-12) &&
        [...expected.entries()].every(([id, c]) => c === 0 || got.rows.some((r) => r.prize.id === id)),
    );
  }

  // --- hashing -----------------------------------------------------------------
  const h1 = await hashPoolSnapshot(snap);
  check("pool hash is 64 hex chars", /^[0-9a-f]{64}$/.test(h1));
  check(
    "pool hash = SHA-256 of the canonical JSON",
    h1 === createHash("sha256").update(canonicalJson(snap)).digest("hex"),
  );
  const fr = fixtureRng(7);
  const reread = parsePoolSnapshot(jsonbRoundTrip(snap, fr));
  check("a jsonb-style round trip (keys reordered) re-hashes identically", reread.ok && (await hashPoolSnapshot(reread.snapshot)) === h1);
  const reordered = jsonbRoundTrip({ ...snap, prizes: [...snap.prizes].reverse() }, fr);
  const rp = parsePoolSnapshot(reordered);
  check("prize order in storage doesn't matter (canonical order is by id)", rp.ok && (await hashPoolSnapshot(rp.snapshot)) === h1);
  const oneTicket: PoolSnapshot = structuredClone(snap);
  oneTicket.prizes[0].w += 1;
  check("one extra ticket changes the hash", (await hashPoolSnapshot(oneTicket)) !== h1);

  // --- strict parsing ------------------------------------------------------------
  const withCost = structuredClone(snap) as unknown as { prizes: Record<string, unknown>[] };
  withCost.prizes[0].cost = 777;
  check("an unknown prize key (e.g. cost) is refused", !parsePoolSnapshot(withCost).ok);
  const frac = structuredClone(snap);
  frac.prizes[0].w = 1.5;
  check("a fractional weight is refused", !parsePoolSnapshot(frac).ok);
  const focus = structuredClone(snap) as unknown as { modifiers: Record<string, unknown> };
  focus.modifiers.focus = { prizeId: "a", multiplier: 3 };
  check("a modifier this verifier doesn't implement is refused, not ignored", !parsePoolSnapshot(focus).ok);
  const extraTop = { ...structuredClone(snap), note: "x" };
  check("an unknown top-level key is refused", !parsePoolSnapshot(extraTop).ok);
  check("another game kind is refused until it ships", !parsePoolSnapshot({ ...snap, game: "bingo" }).ok);

  // --- RNG: v2 untouched, v3 bound to the pool ------------------------------------
  {
    const floatsOf = (s: string) => {
      const out: number[] = [];
      for (let block = 0; block < 2; block++) {
        const b = createHash("sha256").update(`${s}:${block}`).digest();
        for (let i = 0; i < 32; i += 4) out.push(b.readUInt32BE(i) / 4294967296);
      }
      return out;
    };
    const v2 = await makeFairRng("seed-A", "client-1", 7);
    check(
      "v2 RNG is still SHA-256(serverSeed:clientSeed:nonce:block) (existing spins re-derive as before)",
      floatsOf("seed-A:client-1:7").every((f) => f === v2()),
    );
    const v3 = await makeFairRngV3("seed-A", "client-1", 7, h1);
    check("v3 RNG is SHA-256(serverSeed:clientSeed:nonce:poolHash:block)", floatsOf(`seed-A:client-1:7:${h1}`).every((f) => f === v3()));
    const other = await makeFairRngV3("seed-A", "client-1", 7, await hashPoolSnapshot(oneTicket));
    const base = await makeFairRngV3("seed-A", "client-1", 7, h1);
    check("changing one ticket changes the random numbers", Array.from({ length: 8 }, () => other() !== base()).every(Boolean));
  }

  // --- replay: server and verifier agree over many random pools -----------------
  const N = 3_000;
  const r = fixtureRng(2026);
  let replayed = 0;
  let withExclusions = 0;
  let pityWins = 0;
  const stored: Array<{ input: V3ReplayInput; wheel: WheelConfig }> = [];
  for (let i = 0; i < N; i++) {
    const wheel = randomWheel(r, i);
    const opts = {
      serverSeed: Math.floor(r() * 2 ** 52).toString(16).padStart(64, "0"),
      clientSeed: r() < 0.2 ? "" : `cs${i}`,
      nonce: Math.floor(r() * 50),
      hh: r() < 0.3 ? 1 + Math.floor(r() * 18) / 2 : null,
      pity: Math.floor(r() * 11),
    };
    const lossRate = r() < 0.2 ? 0.5 : 0;
    const spun = await serverSpin(wheel, opts, () => r() < lossRate);
    if (!spun) continue;
    if (spun.trace.excluded.length) withExclusions++;
    const input: V3ReplayInput = {
      serverSeed: opts.serverSeed,
      clientSeed: opts.clientSeed || null,
      nonce: opts.nonce,
      snapshot: jsonbRoundTrip(spun.snapshot, r),
      poolHash: spun.poolHash,
      trace: jsonbRoundTrip(spun.trace, r),
      prizeId: spun.prize.id,
      prizeLabel: spun.prize.label,
    };
    const rep = await replayV3(input);
    assert.ok(rep.ok, `replay #${i} reproduces the server's draw (${rep.problem})`);
    assert.strictEqual(rep.replayed?.id, spun.prize.id);
    if (rep.pityAwarded) pityWins++;
    replayed++;
    if (stored.length < 300) stored.push({ input, wheel });
  }
  check(`replay reproduces the server's pick for ${replayed} random pools/modifiers/seeds`, replayed > N * 0.9);
  check(`… including ${withExclusions} spins with sold-out re-draws`, withExclusions > 40);
  check(`… and ${pityWins} pity-forced spins`, pityWins > 20);

  // --- tamper detection --------------------------------------------------------------
  {
    let weightKept = 0;
    let weightRehashed = 0;
    let rehashedTotal = 0;
    let seedChanged = 0;
    let exclusionsTampered = 0;
    let exclusionsTotal = 0;
    for (const { input } of stored) {
      const snapIn = input.snapshot as PoolSnapshot;
      // 1. One weight changed, fingerprint left alone → caught by the fingerprint.
      const t1 = structuredClone(snapIn);
      t1.prizes[0].w += 1;
      const r1 = await replayV3({ ...input, snapshot: t1 });
      if (!r1.ok && !r1.poolHashOk) weightKept++;
      // 2. Weight changed AND fingerprint rewritten → the floats change, so the
      //    replay lands elsewhere unless it happens to hit the same prize.
      if (snapIn.prizes.length > 2) {
        rehashedTotal++;
        const t2 = structuredClone(snapIn);
        const target = t2.prizes.find((p) => p.id !== (input.trace as FairTrace).won)!;
        target.w = target.w * 50 + 1000;
        const r2 = await replayV3({ ...input, snapshot: t2, poolHash: await hashPoolSnapshot(parsedOrThrow(t2)) });
        if (!r2.ok) weightRehashed++;
      }
      // 3. Another server seed.
      const r3 = await replayV3({ ...input, serverSeed: input.serverSeed.replace(/.$/, (c) => (c === "0" ? "1" : "0")) });
      if (!r3.ok) seedChanged++;
      // 4. A recorded sold-out re-draw swapped for another prize.
      const trace = input.trace as FairTrace;
      if (trace.excluded.length) {
        exclusionsTotal++;
        const other = snapIn.prizes.find((p) => p.id !== trace.excluded[0])!.id;
        const r4 = await replayV3({ ...input, trace: { ...trace, excluded: [other, ...trace.excluded.slice(1)] } });
        if (!r4.ok) exclusionsTampered++;
      }
    }
    check(`changing one weight (fingerprint untouched) fails every replay (${weightKept}/${stored.length})`, weightKept === stored.length);
    check(`changing a weight and re-fingerprinting fails nearly every replay (${weightRehashed}/${rehashedTotal})`, weightRehashed >= rehashedTotal * 0.6);
    check(`a different server seed fails most replays (${seedChanged}/${stored.length})`, seedChanged >= stored.length * 0.5);
    check(`a swapped sold-out re-draw always fails (${exclusionsTampered}/${exclusionsTotal})`, exclusionsTotal > 0 && exclusionsTampered === exclusionsTotal);

    // Deterministic cases on one spin.
    const { input } = stored.find((s) => (s.input.snapshot as PoolSnapshot).prizes.length > 1)!;
    const snapIn = input.snapshot as PoolSnapshot;
    const won = (input.trace as FairTrace).won;
    const zeroed = structuredClone(snapIn);
    zeroed.prizes.forEach((p) => (p.w = p.id === won ? 0 : 5));
    const rz = await replayV3({ ...input, snapshot: zeroed, poolHash: await hashPoolSnapshot(parsedOrThrow(zeroed)) });
    check("odds rewritten so the won prize is impossible → replay fails even with a matching fingerprint", !rz.ok && rz.poolHashOk);
    const otherPrize = snapIn.prizes.find((p) => p.id !== won)!;
    check("recording a different prize than the replay draws fails", !(await replayV3({ ...input, trace: { ...(input.trace as FairTrace), won: otherPrize.id }, prizeId: otherPrize.id, prizeLabel: otherPrize.label })).ok);
    check("a label that doesn't match the drawn prize fails", !(await replayV3({ ...input, prizeLabel: "Something else" })).ok);
    check("an unreadable trace fails", !(await replayV3({ ...input, trace: { excluded: "x", won } })).ok);
    check("a missing snapshot fails", !(await replayV3({ ...input, snapshot: null })).ok);
    check("the untampered spin still passes", (await replayV3(input)).ok);
  }

  // --- distribution sanity: seeded v3 draws match the weights -------------------------
  {
    // Each RNG instance precomputes 64 floats; a draw consumes one, so 50 draws
    // per seeded instance keep the suite fast without reusing a float.
    const DRAWS = 40_000;
    const PER_RNG = 50;
    for (const [label, s] of [
      ["sample wheel", buildPoolSnapshot(SAMPLE_WHEEL, { happyHourMultiplier: null, pityCounter: 0 })],
      ["sample wheel, happy hour ×3", buildPoolSnapshot(SAMPLE_WHEEL, { happyHourMultiplier: 3, pityCounter: 0 })],
      ["pity due (rare-or-better only)", buildPoolSnapshot(SAMPLE_WHEEL, { happyHourMultiplier: null, pityCounter: 9 })],
    ] as const) {
      const hash = await hashPoolSnapshot(s);
      const counts = new Map<string, number>();
      for (let n = 0; n < DRAWS / PER_RNG; n++) {
        const rng = await makeFairRngV3("d".repeat(64), "dist", n, hash);
        for (let k = 0; k < PER_RNG; k++) {
          const d = drawFromSnapshot(s, new Set(), rng);
          counts.set(d.prize.id, (counts.get(d.prize.id) ?? 0) + 1);
        }
      }
      const { rows } = snapshotOdds(s);
      const within = rows.every(({ prize, chance }) => {
        const got = (counts.get(prize.id) ?? 0) / DRAWS;
        const sigma = Math.sqrt((chance * (1 - chance)) / DRAWS);
        return Math.abs(got - chance) <= Math.max(5 * sigma, 1e-9);
      });
      check(`${label}: ${DRAWS} seeded draws match the weights within 5σ`, within);
      if (label.startsWith("pity")) {
        const rare = (x: Rarity) => RARITY_ORDER.indexOf(x) >= RARITY_ORDER.indexOf("rare");
        check("pity due: every draw is rare or better", rows.every(({ prize }) => rare(prize.rarity) || !counts.get(prize.id)));
      }
    }
  }

  // --- verify-page copy ----------------------------------------------------------
  check(
    "chances format as short percentages",
    formatChance(0.5) === "50%" &&
      formatChance(1 / 3) === "33.3%" &&
      formatChance(0.0125) === "1.25%" &&
      formatChance(0.03) === "3%" &&
      formatChance(1) === "100%" &&
      formatChance(0.00001) === "<0.01%" &&
      formatChance(0) === "0%",
  );
  const neutral = modifierLines(buildPoolSnapshot(SAMPLE_WHEEL, { happyHourMultiplier: null, pityCounter: 2 }), false);
  check("neutral modifiers are stated, not omitted", neutral[0] === "Happy hour: not active." && /2 of 10/.test(neutral[1]));
  check("the plain-language lock-in line", /locked in before/.test(ODDS_LOCKED_LINE));

  console.log(`fairnessV3.test: ${passed} checks passed`);
}

function parsedOrThrow(s: unknown): PoolSnapshot {
  const p = parsePoolSnapshot(s);
  if (!p.ok) throw new Error(p.reason);
  return p.snapshot;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
