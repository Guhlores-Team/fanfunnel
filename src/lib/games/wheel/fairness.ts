// Provably-fair primitives for spins.
//
// The fairness guarantee: at spin time the server commits to a random
// `serverSeed` by storing its SHA-256 hash, derives the spin's RNG
// deterministically from the seed, and reveals the seed afterward. A public
// verify page recomputes `sha256(serverSeed)` and confirms it equals the stored
// hash — proving the seed (and thus the outcome) wasn't swapped after the fact.

/** 32 random bytes as a 64-char lowercase hex string. */
export function randomSeedHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 of a string, lowercase hex. Web Crypto — works in Node 22 + edge. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Seeded PRNG — deterministic, pure, returns floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** xfnv-1a string hash → 32-bit unsigned int (used to seed mulberry32). */
function xfnv1a(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic RNG for a spin: hashes `${serverSeed}:${nonce}` into a 32-bit
 * int and seeds a mulberry32 generator. Pure, sync, reproducible — the same
 * seed + nonce always yields the same sequence.
 */
export function makeRng(serverSeed: string, nonce: number): () => number {
  return mulberry32(xfnv1a(`${serverSeed}:${nonce}`));
}
