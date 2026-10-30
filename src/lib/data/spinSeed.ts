import { randomSeedHex, sha256Hex } from "@/lib/games/wheel/fairness";
import type { SeedCommitment } from "./types";

/** The pass's current commitment: the seed for its NEXT spin and its hash. */
export type CommittedSeed = {
  seed: string | null;
  hash: string | null;
};

/** The seed a spin consumed plus the fresh commitment it left on the pass. */
export type ConsumedSeed = {
  serverSeed: string;
  serverSeedHash: string;
  /** How the seed was obtained — recorded on the spin so /verify claims only what holds. */
  commitment: SeedCommitment;
  nextServerSeed: string;
  nextServerSeedHash: string;
};

/**
 * Outcome of one compare-and-swap attempt.
 * - `won`:     the UPDATE matched and this spin now owns the seed it read.
 * - `lost`:    the UPDATE ran without error and matched 0 rows — another spin
 *              consumed the seed first; retrying on a fresh read is safe.
 * - `unknown`: the request errored (transport, timeout, …). The UPDATE may or
 *              may not have committed, so neither "retry" nor "won" is safe.
 */
export type SwapOutcome = "won" | "lost" | "unknown";

export type SeedStore = {
  /** Read the pass's current commitment. Throws when the row can't be read. */
  read(): Promise<CommittedSeed>;
  /**
   * Compare-and-swap: replace the commitment with `next` ONLY if the pass still
   * holds `expected.seed` (null = no commitment yet).
   */
  swap(expected: CommittedSeed, next: { seed: string; hash: string }): Promise<SwapOutcome>;
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
    commitment: "fresh",
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
 * commitment.
 *
 * The loser re-reads and consumes the seed the winner just committed. That seed
 * was stored (and its hash fixed) before this spin consumed it, so the server
 * still cannot grind it, but its hash reached the fan only in the winner's
 * response — not necessarily before the loser's request was sent. This is a
 * deliberate trade: availability (a fast double-tap still spins) over strict
 * "hash shown before every request"; the alternative is to 409 and refund the
 * loser.
 *
 * A pass with no commitment yet (legacy row) gets a fresh seed for this spin
 * only; the swap guarantees no other spin shares it.
 *
 * Each outcome is tagged (`commitment`) so the verify page can state exactly
 * which guarantee this spin has: the seed read on the first attempt was the one
 * whose hash the fan's page showed (`published`); a seed re-read after losing
 * the swap was committed by the concurrent winner (`stored`); a missing seed
 * is generated now (`fresh`).
 *
 * Only a definite `lost` is retried. An `unknown` swap (the request errored)
 * may have committed: retrying would consume a second seed, and inferring a win
 * from "the row now holds my next seed" is wrong once a concurrent spin has
 * moved the row on again. So the spin fails (`null`) and the caller refunds
 * the claimed spin: the fan never gets a result on a seed we can't attribute.
 * The cost is that the shown commitment may have been rotated without a spin;
 * the next page load / `nextSpinHash` republishes the one now on the row.
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
    const commitment: SeedCommitment = !current.seed
      ? "fresh"
      : attempt === 0
        ? "published"
        : "stored";
    const nextServerSeed = randomSeedHex();
    const nextServerSeedHash = await sha256Hex(nextServerSeed);
    const outcome = await store.swap(current, { seed: nextServerSeed, hash: nextServerSeedHash });
    if (outcome === "won") {
      return { serverSeed, serverSeedHash, commitment, nextServerSeed, nextServerSeedHash };
    }
    if (outcome === "unknown") return null;
    current = await store.read();
  }
  return null;
}
