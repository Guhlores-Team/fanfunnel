import assert from "node:assert";
import {
  mockAckFan,
  mockCreatePass,
  mockGetFanPass,
  mockGetSpinVerification,
  mockSpin,
} from "./mock";

// Regression (COR-3): two concurrent spins on ONE pass must never consume the
// same pre-committed server seed. Before the fix both requests read the pass's
// `nextServerSeed` before either rotated it, so one commitment produced two
// logged spins (the seed was revealed twice and, in mock mode, with the same
// nonce — identical outcomes), and the loser's rotation clobbered the winner's
// freshly published commitment. The invariant locked in here: every revealed
// seed hashes to a commitment that was published BEFORE that spin consumed it,
// each commitment is consumed exactly once, and the balance never oversells.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

function mustView<T>(view: T | null, label: string): T {
  if (!view) throw new Error(`expected a value: ${label}`);
  return view;
}

type Ok = Exclude<Awaited<ReturnType<typeof mockSpin>>, { error: string }>;
function mustWin(r: Awaited<ReturnType<typeof mockSpin>>, label: string): Ok {
  if ("error" in r) throw new Error(`${label}: spin failed with ${r.error}`);
  return r;
}

async function main() {
  // --- Concurrent double-spin on a pass with plenty of balance ---------------
  {
    const { token } = mockCreatePass("Racer", 5);
    mockAckFan(token);
    const before = mustView(await mockGetFanPass(token), "pass view");
    const committed = before.nextSpinHash;
    assert.ok(committed, "page load publishes a commitment");

    // Fire both spins in the same tick — the browser double-tap / two-tab case.
    const [a, b] = await Promise.all([mockSpin(token, "same-client-seed"), mockSpin(token, "same-client-seed")]);
    const ra = mustWin(a, "spin A");
    const rb = mustWin(b, "spin B");

    const va = mustView(await mockGetSpinVerification(ra.shareId), "verify A");
    const vb = mustView(await mockGetSpinVerification(rb.shareId), "verify B");
    check("both spins verify (hash matches)", va.hashOk && vb.hashOk);
    check("the two spins reveal DIFFERENT server seeds", va.serverSeed !== vb.serverSeed);
    check(
      "the page's commitment is consumed by exactly one spin",
      [va.serverSeedHash, vb.serverSeedHash].filter((h) => h === committed).length === 1,
    );

    // The other spin must have consumed the commitment the first spin published
    // (the rotation chain is unbroken: no seed is used that was never committed).
    const published = new Set([committed, ra.nextSpinHash, rb.nextSpinHash]);
    check("spin A revealed a previously published commitment", published.has(va.serverSeedHash));
    check("spin B revealed a previously published commitment", published.has(vb.serverSeedHash));
    check(
      "a commitment is never consumed twice",
      va.serverSeedHash !== vb.serverSeedHash,
    );

    // Whatever the pass holds for the NEXT spin is one of the commitments the
    // fan was actually shown — not an orphaned one clobbered by the loser.
    const after = mustView(await mockGetFanPass(token), "pass view after");
    check(
      "the pass's next commitment was returned by one of the spins",
      after.nextSpinHash === ra.nextSpinHash || after.nextSpinHash === rb.nextSpinHash,
    );
    check(
      "the surviving commitment is the one not yet consumed",
      after.nextSpinHash !== va.serverSeedHash && after.nextSpinHash !== vb.serverSeedHash,
    );
    check("balance decremented exactly twice", after.spinsRemaining === 3);
  }

  // --- Concurrent spins on a balance of 1: exactly one may win ---------------
  {
    const { token } = mockCreatePass("LastSpin", 1);
    mockAckFan(token);
    mustView(await mockGetFanPass(token), "pass view");
    const settled = await Promise.all(Array.from({ length: 4 }, () => mockSpin(token, "x")));
    const wins = settled.filter((r) => !("error" in r)).length;
    const noSpins = settled.filter((r) => "error" in r && r.error === "no_spins").length;
    check("balance 1 + 4 concurrent spins → exactly 1 win", wins === 1);
    check("the other 3 are rejected as no_spins", noSpins === 3);
    const after = mustView(await mockGetFanPass(token), "pass view after");
    check("balance never goes negative", after.spinsRemaining === 0);
  }

  console.log(`spinSeedRace.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
