// Provably-fair primitives for spins.
//
// Commit-reveal scheme (v2):
//  1. COMMIT — before a fan spins, the server has already generated the spin's
//     `serverSeed` and published only sha256(serverSeed) to the fan (shown on
//     the spin page). The server cannot grind seeds after seeing the request.
//  2. CONTRIBUTE — the fan's browser sends a `clientSeed` with the spin, mixed
//     into the RNG. The server cannot fully control the outcome.
//  3. REVEAL — after the spin, the seed is revealed on the logged spin. The
//     public verify page recomputes sha256(serverSeed), confirms it equals the
//     pre-published commitment, and shows the full derivation formula.
//
// RNG entropy: outcome floats are drawn directly from SHA-256 blocks of
// `serverSeed:clientSeed:nonce:block` — the full 256 bits per block, not a
// 32-bit fold.

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

/** SHA-256 of a string as raw bytes. */
async function sha256Bytes(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return new Uint8Array(digest);
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
 * LEGACY deterministic RNG (pre-commit-reveal spins): hashes
 * `${serverSeed}:${nonce}` into a 32-bit int and seeds mulberry32. Kept so old
 * spins remain re-derivable; new spins use `makeFairRng`.
 */
export function makeRng(serverSeed: string, nonce: number): () => number {
  return mulberry32(xfnv1a(`${serverSeed}:${nonce}`));
}

/** How many SHA-256 blocks of floats to precompute (8 floats per block). */
const FAIR_RNG_BLOCKS = 8;

/**
 * Commit-reveal RNG for a spin. Floats come straight from SHA-256 blocks of
 * `serverSeed:clientSeed:nonce:blockIndex` (4 bytes big-endian per float, so 8
 * floats per block — 64 precomputed, far more than a pick ever consumes).
 * Fully deterministic and independently re-derivable by anyone holding the
 * revealed seed, the client seed, and the nonce. If the pool is ever exhausted
 * it falls back to a mulberry32 seeded from the final block — still
 * deterministic, so verification never breaks.
 */
export async function makeFairRng(
  serverSeed: string,
  clientSeed: string,
  nonce: number
): Promise<() => number> {
  const floats: number[] = [];
  let lastBlockHex = "";
  for (let block = 0; block < FAIR_RNG_BLOCKS; block++) {
    const bytes = await sha256Bytes(
      `${serverSeed}:${clientSeed}:${nonce}:${block}`
    );
    lastBlockHex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    for (let i = 0; i + 4 <= bytes.length; i += 4) {
      const n =
        ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>>
        0;
      floats.push(n / 4294967296);
    }
  }
  let cursor = 0;
  const fallback = mulberry32(xfnv1a(lastBlockHex));
  return () => (cursor < floats.length ? floats[cursor++] : fallback());
}

/** Server-side sanity bound for client seeds (hex-ish, bounded length). */
export function normalizeClientSeed(input: unknown): string {
  if (typeof input !== "string") return "";
  const s = input.trim().slice(0, 64);
  return /^[0-9a-zA-Z_-]*$/.test(s) ? s : "";
}
