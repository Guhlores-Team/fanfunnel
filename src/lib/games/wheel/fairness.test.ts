// Commit-reveal fairness primitives: determinism, commitment integrity,
// seed sensitivity, and output bounds.
import {
  makeFairRng,
  makeRng,
  normalizeClientSeed,
  randomSeedHex,
  sha256Hex,
} from "./fairness";

let passed = 0;
function ok(cond: boolean, label: string) {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

async function main() {
  // Determinism: same inputs → identical sequence.
  const a = await makeFairRng("seed-A", "client-1", 7);
  const b = await makeFairRng("seed-A", "client-1", 7);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  ok(JSON.stringify(seqA) === JSON.stringify(seqB), "deterministic for identical inputs");

  // Sensitivity: changing ANY input changes the sequence.
  for (const [s, c, n, label] of [
    ["seed-B", "client-1", 7, "server seed"],
    ["seed-A", "client-2", 7, "client seed"],
    ["seed-A", "client-1", 8, "nonce"],
  ] as const) {
    const r = await makeFairRng(s, c, n);
    const seq = Array.from({ length: 20 }, () => r());
    ok(JSON.stringify(seq) !== JSON.stringify(seqA), `sequence changes with ${label}`);
  }

  // Bounds: floats in [0, 1), even deep into the fallback region.
  const r = await makeFairRng(randomSeedHex(), "x", 1);
  for (let i = 0; i < 500; i++) {
    const v = r();
    ok(v >= 0 && v < 1, `float ${i} in [0,1)`);
  }

  // Fallback continuity: two identical rngs agree beyond the precomputed pool.
  const f1 = await makeFairRng("s", "c", 1);
  const f2 = await makeFairRng("s", "c", 1);
  let agree = true;
  for (let i = 0; i < 200; i++) if (f1() !== f2()) agree = false;
  ok(agree, "fallback region is deterministic too");

  // Commitment: sha256 of a random seed is stable + 64 hex chars.
  const seed = randomSeedHex();
  ok(/^[0-9a-f]{64}$/.test(seed), "randomSeedHex shape");
  const h1 = await sha256Hex(seed);
  const h2 = await sha256Hex(seed);
  ok(h1 === h2 && /^[0-9a-f]{64}$/.test(h1), "sha256Hex stable + hex");
  ok((await sha256Hex(seed + "x")) !== h1, "different seed → different hash");

  // Legacy RNG still deterministic (old spins stay re-derivable).
  const l1 = makeRng("legacy", 3);
  const l2 = makeRng("legacy", 3);
  ok(l1() === l2(), "legacy makeRng deterministic");

  // Client seed normalization: bounded, charset-restricted, never throws.
  ok(normalizeClientSeed("abc-DEF_123") === "abc-DEF_123", "normalize passes safe seed");
  ok(normalizeClientSeed("bad;drop table") === "", "normalize rejects unsafe chars");
  ok(normalizeClientSeed("a".repeat(200)).length === 64, "normalize caps length");
  ok(normalizeClientSeed(42) === "", "normalize rejects non-strings");
  ok(normalizeClientSeed(undefined) === "", "normalize handles undefined");

  console.log(`fairness.test: ${passed} checks passed`);
}

main();
