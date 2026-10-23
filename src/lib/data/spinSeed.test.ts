import assert from "node:assert";
import { sha256Hex } from "@/lib/games/wheel/fairness";
import {
  consumeCommittedSeed,
  MAX_SEED_SWAP_ATTEMPTS,
  type CommittedSeed,
  type SeedStore,
} from "./spinSeed";

// Unit test for the Supabase-path seed consumption (COR-3). The fake store
// models the fan_passes row and the compare-and-swap UPDATE
// (`... where id = ? and next_server_seed = <expected>`): a swap succeeds only
// if the row still holds the seed the caller read. Interleaving two consumers
// against one row must hand out two DIFFERENT seeds, each matching a
// commitment that was on the row before it was consumed.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

/** A fan_passes row with a CAS-guarded update, plus an optional hook to
 *  interleave other work between the read and the swap. */
function fakeRow(initial: CommittedSeed) {
  let row: CommittedSeed = { ...initial };
  const history: string[] = []; // every hash that was ever committed on the row
  if (initial.hash) history.push(initial.hash);
  let swaps = 0;
  const store: SeedStore = {
    read: async () => ({ ...row }),
    swap: async (expected, next) => {
      await Promise.resolve(); // yield, like a network hop
      if (row.seed !== expected.seed) return false;
      row = { seed: next.seed, hash: next.hash };
      history.push(next.hash);
      swaps++;
      return true;
    },
  };
  return { store, history, get row() { return row; }, get swaps() { return swaps; } };
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

  // --- Swap committed but its response was lost ------------------------------
  // The UPDATE landed, yet the client saw no row back (data null → false). The
  // consumer must recognise its own next seed on re-read and reveal the seed the
  // fan was shown — not consume its own fresh commitment and burn the shown one.
  {
    const seed0 = "c".repeat(64);
    const hash0 = await sha256Hex(seed0);
    const r = fakeRow({ seed: seed0, hash: hash0 });
    let lostResponses = 0;
    const flaky: SeedStore = {
      read: r.store.read,
      swap: async (expected, next) => {
        const won = await r.store.swap(expected, next);
        if (won && lostResponses === 0) {
          lostResponses++;
          return false; // committed, but the caller never heard
        }
        return won;
      },
    };
    const out = await consumeCommittedSeed(flaky);
    assert.ok(out, "consumer gets a seed");
    check("lost response: reveals the seed the fan was shown", out.serverSeed === seed0 && out.serverSeedHash === hash0);
    check("lost response: the row holds THIS spin's next commitment", r.row.seed === out.nextServerSeed && r.row.hash === out.nextServerSeedHash);
    check("lost response: the row was swapped exactly once", r.swaps === 1 && lostResponses === 1);
  }

  // --- Unwinnable contention gives up (caller refunds the claim) --------------
  {
    let swapCalls = 0;
    const store: SeedStore = {
      read: async () => ({ seed: "s", hash: "h" }),
      swap: async () => {
        swapCalls++;
        return false;
      },
    };
    const out = await consumeCommittedSeed(store);
    check("returns null when the swap never wins", out === null);
    check("bounded retries", swapCalls === MAX_SEED_SWAP_ATTEMPTS);
  }

  console.log(`spinSeed.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
