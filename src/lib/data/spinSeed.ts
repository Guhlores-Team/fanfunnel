import { randomSeedHex, sha256Hex } from "@/lib/games/wheel/fairness";

/** The pass's current commitment: the seed for its NEXT spin and its hash. */
export type CommittedSeed = {
  seed: string | null;
  hash: string | null;
};

/** The seed a spin consumed plus the fresh commitment it left on the pass. */
export type ConsumedSeed = {
  serverSeed: string;
  serverSeedHash: string;
  nextServerSeed: string;
  nextServerSeedHash: string;
};

export type SeedStore = {
  /** Read the pass's current commitment. */
  read(): Promise<CommittedSeed>;
  /**
   * Compare-and-swap: replace the commitment with `next` ONLY if the pass still
   * holds `expected.seed` (null = no commitment yet). Resolves true when the
   * swap happened, false when another spin consumed the seed first.
   */
  swap(expected: CommittedSeed, next: { seed: string; hash: string }): Promise<boolean>;
};

export const MAX_SEED_SWAP_ATTEMPTS = 5;

/**
 * A one-off seed for a DB that has no commit-reveal columns yet (pre-0022):
 * nothing was committed before this spin and nothing can be stored for the
 * next one, so the seed is generated and hashed at spin time.
 */
export async function freshSeed(): Promise<ConsumedSeed> {
  const serverSeed = randomSeedHex();
  const nextServerSeed = randomSeedHex();
  return {
    serverSeed,
    serverSeedHash: await sha256Hex(serverSeed),
    nextServerSeed,
    nextServerSeedHash: await sha256Hex(nextServerSeed),
  };
}

/**
 * Consume the pass's pre-committed server seed exactly once.
 *
 * claim_spin only serializes the BALANCE decrement; a fan holding several spins
 * can legitimately have two requests in flight. Without a guard both read the
 * same `next_server_seed`, both reveal it, and the loser's rotation overwrites
 * the commitment the winner just published — one commitment, two spins. The
 * swap is guarded on the seed we read, so exactly one spin wins each
 * commitment; the loser re-reads and consumes the winner's freshly committed
 * seed instead (a commitment the server stored before it was consumed, and
 * whose hash the winner's response already published).
 *
 * A pass with no commitment yet (legacy row) gets a fresh seed for this spin
 * only; the swap guarantees no other spin shares it.
 */
export async function consumeCommittedSeed(
  store: SeedStore,
  initial?: CommittedSeed,
): Promise<ConsumedSeed | null> {
  let current = initial ?? (await store.read());
  for (let attempt = 0; attempt < MAX_SEED_SWAP_ATTEMPTS; attempt++) {
    const serverSeed = current.seed ?? randomSeedHex();
    const serverSeedHash =
      current.seed && current.hash ? current.hash : await sha256Hex(serverSeed);
    const nextServerSeed = randomSeedHex();
    const nextServerSeedHash = await sha256Hex(nextServerSeed);
    if (await store.swap(current, { seed: nextServerSeed, hash: nextServerSeedHash })) {
      return { serverSeed, serverSeedHash, nextServerSeed, nextServerSeedHash };
    }
    current = await store.read();
  }
  return null;
}
