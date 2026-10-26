import assert from "node:assert";
import { sha256Hex } from "@/lib/games/wheel/fairness";
import {
  consumeCommittedSeed,
  MAX_SEED_SWAP_ATTEMPTS,
  type CommittedSeed,
  type ConsumedSeed,
  type SeedStore,
  type SwapOutcome,
} from "./spinSeed";

// Unit test for the Supabase-path seed consumption (COR-3). The fake store
// models the fan_passes row and the compare-and-swap UPDATE
// (`... where id = ? and next_server_seed = <expected>`): a swap wins only if
// the row still holds the seed the caller read. Interleaving two consumers
// against one row must hand out two DIFFERENT seeds, each matching a
// commitment that was on the row before it was consumed. A swap whose outcome
// is unknown (request errored) must yield NO result: the fan never spins on a
// seed we can't attribute.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

/** A fan_passes row with a CAS-guarded update. */
function fakeRow(initial: CommittedSeed) {
  let row: CommittedSeed = { ...initial };
  const history: string[] = []; // every hash that was ever committed on the row
  if (initial.hash) history.push(initial.hash);
  let swaps = 0;
  let reads = 0;
  const store: SeedStore = {
    read: async () => {
      reads++;
      return { ...row };
    },
    swap: async (expected, next): Promise<SwapOutcome> => {
      await Promise.resolve(); // yield, like a network hop
      if (row.seed !== expected.seed) return "lost";
      row = { seed: next.seed, hash: next.hash };
      history.push(next.hash);
      swaps++;
      return "won";
    },
  };
  return {
    store,
    history,
    get row() {
      return row;
    },
    get swaps() {
      return swaps;
    },
    get reads() {
      return reads;
    },
  };
}

/** Wrap a store so the first swap that commits reports `unknown` instead. */
function withLostResponse(inner: SeedStore): SeedStore & { lost: () => number } {
  let lost = 0;
  return {
    read: inner.read,
    swap: async (expected, next) => {
      const out = await inner.swap(expected, next);
      if (out === "won" && lost === 0) {
        lost++;
        return "unknown"; // committed, but the caller never heard
      }
      return out;
    },
    lost: () => lost,
  };
}

async function main() {
  // --- Two consumers that both read the SAME committed seed ------------------
  {
    const seed0 = "a".repeat(64);
    const hash0 = await sha256Hex(seed0);
    const r = fakeRow({ seed: seed0, hash: hash0 });
    // Both callers read the row before either swaps (the race window).
    const snapshot = await r.store.read();
    const [a, b] = await Promise.all([
      consumeCommittedSeed(r.store, snapshot),
      consumeCommittedSeed(r.store, snapshot),
    ]);
    assert.ok(a && b, "both consumers get a seed");
    check("the committed seed is consumed by exactly one spin", [a.serverSeed, b.serverSeed].filter((s) => s === seed0).length === 1);
    check("the two spins reveal different seeds", a.serverSeed !== b.serverSeed);
    check("each revealed hash was committed on the row before it was consumed", r.history.includes(a.serverSeedHash) && r.history.includes(b.serverSeedHash));
    check("revealed seeds hash to their commitments", (await sha256Hex(a.serverSeed)) === a.serverSeedHash && (await sha256Hex(b.serverSeed)) === b.serverSeedHash);
    // The loser consumed the winner's freshly committed seed: an unbroken chain.
    const winner = a.serverSeed === seed0 ? a : b;
    const loser = winner === a ? b : a;
    check("the loser reveals the seed the winner committed", loser.serverSeedHash === winner.nextServerSeedHash);
    check("the row ends holding the loser's new commitment", r.row.hash === loser.nextServerSeedHash && r.row.seed === loser.nextServerSeed);
    check("exactly two swaps happened", r.swaps === 2);
  }

  // --- Legacy row with no commitment: a fresh seed, still swapped exactly once
  {
    const r = fakeRow({ seed: null, hash: null });
    const snapshot = await r.store.read();
    const [a, b] = await Promise.all([
      consumeCommittedSeed(r.store, snapshot),
      consumeCommittedSeed(r.store, snapshot),
    ]);
    assert.ok(a && b, "both consumers get a seed");
    check("legacy: fresh seeds differ", a.serverSeed !== b.serverSeed);
    check("legacy: fresh seed hashes to its reported hash", (await sha256Hex(a.serverSeed)) === a.serverSeedHash);
    const winner = r.history[0] === a.nextServerSeedHash ? a : b;
    const loser = winner === a ? b : a;
    check("legacy: the loser consumes the winner's commitment", loser.serverSeedHash === winner.nextServerSeedHash);
    check("legacy: row is committed afterwards", r.row.seed !== null && r.row.hash === loser.nextServerSeedHash);
  }

  // --- Swap committed but its response was lost → no result ------------------
  // The UPDATE landed, yet the request errored. We can't tell a committed swap
  // from one that never ran, so the spin yields nothing (the caller refunds the
  // claim). The shown commitment is rotated without a spin; the row's new
  // commitment is what the next page load republishes.
  {
    const seed0 = "c".repeat(64);
    const hash0 = await sha256Hex(seed0);
    const r = fakeRow({ seed: seed0, hash: hash0 });
    const flaky = withLostResponse(r.store);
    const out = await consumeCommittedSeed(flaky);
    check("lost response: no result on a seed we can't attribute", out === null);
    check("lost response: the swap was not retried", r.swaps === 1 && flaky.lost() === 1);
    check("lost response: no recovery read was attempted", r.reads === 1);
    check("lost response: the row holds a new, unrevealed commitment", r.row.seed !== seed0 && r.row.seed !== null);
  }

  // --- Lost response, then ANOTHER consumer runs before any recovery ----------
  // (Codex's interleaving.) A's swap commits but errors; B then reads A's new
  // seed and consumes it. A must not come back and consume a third seed: the
  // only result is B's, and it reveals the seed that was on the row when B read
  // it. Nothing reveals the originally shown seed twice, or a seed that was
  // never a stored commitment.
  {
    const seed0 = "d".repeat(64);
    const hash0 = await sha256Hex(seed0);
    const r = fakeRow({ seed: seed0, hash: hash0 });
    const flaky = withLostResponse(r.store);
    const captured: { b: ConsumedSeed | null } = { b: null };
    const gated: SeedStore = {
      read: r.store.read,
      swap: async (expected, next) => {
        const out = await flaky.swap(expected, next);
        if (out === "unknown") {
          // B runs to completion while A's response is "in flight".
          captured.b = await consumeCommittedSeed(r.store);
        }
        return out;
      },
    };
    const aResult = await consumeCommittedSeed(gated);
    assert.ok(captured.b, "B gets a seed");
    const b = captured.b;
    check("interleaving: A yields no result", aResult === null);
    check("interleaving: exactly two rotations, not three", r.swaps === 2);
    check("interleaving: B reveals the seed that was on the row when it read", b.serverSeedHash === r.history[1]);
    check("interleaving: B does not reveal the originally shown seed (A's committed swap consumed it)", b.serverSeed !== seed0);
    check("interleaving: B's seed hashes to its commitment", (await sha256Hex(b.serverSeed)) === b.serverSeedHash);
    check("interleaving: the row ends on B's new commitment", r.row.seed === b.nextServerSeed && r.row.hash === b.nextServerSeedHash);
  }

  // --- An unknown outcome on the very first attempt is not retried -----------
  {
    let swapCalls = 0;
    let reads = 0;
    const store: SeedStore = {
      read: async () => {
        reads++;
        return { seed: "s", hash: "h" };
      },
      swap: async () => {
        swapCalls++;
        return "unknown";
      },
    };
    const out = await consumeCommittedSeed(store);
    check("unknown: returns null", out === null);
    check("unknown: exactly one swap, no retry, no re-read", swapCalls === 1 && reads === 1);
  }

  // --- Unwinnable contention gives up (caller refunds the claim) --------------
  {
    let swapCalls = 0;
    const store: SeedStore = {
      read: async () => ({ seed: "s", hash: "h" }),
      swap: async () => {
        swapCalls++;
        return "lost";
      },
    };
    const out = await consumeCommittedSeed(store);
    check("returns null when every swap is definitely lost", out === null);
    check("bounded retries", swapCalls === MAX_SEED_SWAP_ATTEMPTS);
  }

  console.log(`spinSeed.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
