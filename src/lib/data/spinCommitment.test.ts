import assert from "node:assert";
import { mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { sha256Hex } from "@/lib/games/wheel/fairness";
import VerifyPage from "@/app/verify/[shareId]/page";
import { COMMITMENT_COPY, VERDICT_AMBER, VERDICT_GREEN, verdictColor } from "@/app/verify/[shareId]/commitmentCopy";
import { FakeSpinLedger } from "./fakeSpinLedger";
import {
  mockAckFan,
  mockCreatePass,
  mockGetFanPass,
  mockGetSpinVerification,
  mockSpin,
} from "./mock";

// Provably-fair commit-reveal (#23 / 0041): every spin row records HOW its
// server seed was obtained, and the public verify page describes exactly that.
//   published  the hash the fan saw on the page before spinning is the hash
//              of the seed this spin consumed (the strong claim);
//   stored     the pass held a committed seed, but the fan's request named a
//              different (older) hash, so the seed was fixed before the spin
//              yet not shown to this fan in advance;
//   fresh      the pass held no commitment at all (spun before its page was
//              ever loaded): the seed was generated for this spin.
// On the live path the TS side decides the value from the committed context
// (serverSeedHash, commitment) and the fan's intent (publishedSeedHash), and
// commit_spin_attempt stores it immutably with the proof.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

mock.module("@/lib/afterResponse", { namedExports: { runAfterResponse: () => {} } });
mock.module("@/lib/push/notify", { namedExports: { notifyCreator: async () => {} } });
mock.module("@/lib/data/webhooks", { namedExports: { fireWebhooks: async () => {} } });
// The verify page and the mock spins below run on the demo store; the live
// spins receive the fake ledger explicitly.
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => false, createServiceClient: () => { throw new Error("no service client in this test"); }, createClient: async () => { throw new Error("no session client in this test"); } } });

async function renderVerify(shareId: string): Promise<string> {
  const el = await VerifyPage({ params: Promise.resolve({ shareId }) });
  return renderToStaticMarkup(el).replace(/&#x27;|&rsquo;|’/g, "'");
}

async function main() {
  const { commitSpinAttempt } = await import("./spinAttempts");
  const spinRow = (l: FakeSpinLedger) => l.rpcs.find((r) => r.name === "commit_spin_attempt")?.args.p_spin as Record<string, unknown> | undefined;

  // --- Supabase path: the spin row carries the commitment ---------------------
  {
    // The fan's request names the hash the page published: published.
    const l = await new FakeSpinLedger([{ id: "prize-1", weight: 1, stock: null }]).init();
    const shown = l.seedHash;
    const published = await commitSpinAttempt("tok", { requestId: crypto.randomUUID(), clientSeed: "cs", publishedSeedHash: shown }, l.client());
    assert.ok(!("error" in published), "spin succeeded");
    check("spin row records seed_commitment=published for the pre-committed seed the fan saw", spinRow(l)?.seed_commitment === "published");
    check("the consumed seed is the one whose hash the page showed", spinRow(l)?.server_seed_hash === shown && (await sha256Hex(String(spinRow(l)?.server_seed))) === shown);
    check("the response publishes the NEXT commitment, not the consumed one", published.nextSpinHash === l.seedHash && published.nextSpinHash !== shown);
  }
  {
    // COR-3 on the live path: two concurrent spins on ONE pass (double tap,
    // two tabs) both name the hash the page showed. The commitment is consumed
    // exactly once: the second commit is refused (the nonce moved), re-prepares
    // and spends the winner's NEW commitment, which this fan was never shown.
    const l = await new FakeSpinLedger([{ id: "prize-1", weight: 1, stock: null }], { balance: 5 }).init();
    const shown = l.seedHash;
    const results = await Promise.all([0, 1].map(() =>
      commitSpinAttempt("tok", { requestId: crypto.randomUUID(), clientSeed: "same-client-seed", publishedSeedHash: shown }, l.client())));
    check("double spin: both requests win", results.every((r) => !("error" in r)));
    const [a, b] = l.spinRows as { id: string; server_seed: string; server_seed_hash: string; nonce: number; seed_commitment: string }[];
    const winner = results.find((r) => !("error" in r) && r.attemptId === a.id);
    check("double spin: two rows with DIFFERENT revealed seeds and nonces", l.spinRows.length === 2 && a.server_seed !== b.server_seed && a.nonce !== b.nonce);
    check("double spin: the shown commitment is consumed by exactly one spin", [a, b].filter((x) => x.server_seed_hash === shown).length === 1);
    check("double spin: each revealed seed hashes to its recorded hash", (await sha256Hex(a.server_seed)) === a.server_seed_hash && (await sha256Hex(b.server_seed)) === b.server_seed_hash);
    check("double spin: the loser reveals the commitment the winner's response published", !!winner && !("error" in winner) && b.server_seed_hash === winner.nextSpinHash);
    check("double spin: the winner is published, the loser only stored", a.seed_commitment === "published" && b.seed_commitment === "stored");
    check("double spin: the balance moved exactly twice", l.balance === 3);
  }
  {
    // The pass holds a committed seed, but the request names an older hash
    // (a second tab, a stale page): stored, never published.
    const l = await new FakeSpinLedger([{ id: "prize-1", weight: 1, stock: null }]).init();
    const stale = await sha256Hex("not-the-committed-seed");
    const r = await commitSpinAttempt("tok", { requestId: crypto.randomUUID(), clientSeed: "cs", publishedSeedHash: stale }, l.client());
    assert.ok(!("error" in r), "spin succeeded");
    check("spin row records seed_commitment=stored when the fan's hash is not the committed one", spinRow(l)?.seed_commitment === "stored");
    const l2 = await new FakeSpinLedger([{ id: "prize-1", weight: 1, stock: null }]).init();
    const r2 = await commitSpinAttempt("tok", { requestId: crypto.randomUUID(), clientSeed: "cs" }, l2.client());
    assert.ok(!("error" in r2), "spin succeeded");
    check("spin row records seed_commitment=stored when the request names no hash", spinRow(l2)?.seed_commitment === "stored");
  }
  {
    // A legacy pass with no committed seed: the ledger minted one for this spin.
    const l = await new FakeSpinLedger([{ id: "prize-1", weight: 1, stock: null }], { commitment: "fresh" }).init();
    const r = await commitSpinAttempt("tok", { requestId: crypto.randomUUID(), clientSeed: "cs", publishedSeedHash: l.seedHash }, l.client());
    assert.ok(!("error" in r), "spin succeeded");
    check("spin row records seed_commitment=fresh for a pass without a commitment, whatever the request claims", spinRow(l)?.seed_commitment === "fresh");
  }
  {
    // The committed context is the only source: a request can't claim a hash
    // the ledger never committed (the row says stored, the proof still replays
    // against the real seed).
    const l = await new FakeSpinLedger([{ id: "prize-1", weight: 1, stock: null }]).init();
    const forged = "0".repeat(64);
    const r = await commitSpinAttempt("tok", { requestId: crypto.randomUUID(), clientSeed: "cs", publishedSeedHash: forged }, l.client());
    assert.ok(!("error" in r), "spin succeeded");
    const row = spinRow(l)!;
    check("a forged published hash is recorded as stored", row.seed_commitment === "stored");
    check("the row's seed/hash pair is the committed one, not the forged claim", (await sha256Hex(String(row.server_seed))) === row.server_seed_hash && row.server_seed_hash !== forged);
    check("the commit carries the fan's claim for the ledger to check, lower-cased", (l.rpcs.find((c) => c.name === "commit_spin_attempt")?.args.p_context as { publishedSeedHash: string }).publishedSeedHash === forged);
  }

  // --- Mock path + verify page copy -------------------------------------------
  {
    // A pass spun before its page was ever loaded has no commitment: the seed
    // is generated at spin time, so the page must not claim it was committed.
    const { token } = mockCreatePass("Commitment", 3);
    mockAckFan(token);
    const fresh = await mockSpin(token, "cs");
    assert.ok(!("error" in fresh), "mock spin (no commitment yet) succeeded");
    const vFresh = await mockGetSpinVerification(fresh.shareId);
    check("mock: spin on an uncommitted pass → fresh", vFresh?.commitment === "fresh");
    check("mock: hash still matches (the pair is self-consistent)", vFresh?.hashOk === true);
    const htmlFresh = await renderVerify(fresh.shareId);
    check("verify page: a fresh seed is NOT described as committed before the spin", !/committed before/i.test(htmlFresh));
    check("verify page: a fresh seed says the hash was not published in advance", /not published/i.test(htmlFresh));
    check("verify page: a fresh seed still shows the hash check", /hash matches/i.test(htmlFresh));

    // Loading the spin page commits the next seed; that spin IS pre-committed.
    const view = await mockGetFanPass(token);
    assert.ok(view?.nextSpinHash, "spin page published a commitment");
    const committed = await mockSpin(token, "cs", crypto.randomUUID(), view.nextSpinHash);
    assert.ok(!("error" in committed), "mock spin (committed) succeeded");
    const vCommitted = await mockGetSpinVerification(committed.shareId);
    check("mock: spin on a committed pass → published", vCommitted?.commitment === "published");
    check("mock: the consumed hash is the one the page showed", vCommitted?.serverSeedHash === view.nextSpinHash);
    const htmlCommitted = await renderVerify(committed.shareId);
    check("verify page: a published commitment IS described as committed before the spin", /committed before/i.test(htmlCommitted));
    check("verify page: a published commitment shows the hash check", /hash matches/i.test(htmlCommitted));
    // The verdict box border is the only `color-mix(... 55%)` on the page (the
    // rarity colour is used elsewhere, and may itself be green).
    const verdictBox = (c: string) => `color-mix(in oklab, ${c} 55%`;
    check("verify page: a published commitment renders green", htmlCommitted.includes(verdictBox(VERDICT_GREEN)) && !htmlCommitted.includes(verdictBox(VERDICT_AMBER)));
    check("verify page: a fresh seed renders amber", htmlFresh.includes(verdictBox(VERDICT_AMBER)) && !htmlFresh.includes(verdictBox(VERDICT_GREEN)));

    // A stored seed was fixed before the spin but its hash never reached this
    // fan's page, so it can't be presented as shown in advance.
    check("verify copy: stored renders amber (not strong)", verdictColor(true, "stored") === VERDICT_AMBER && COMMITMENT_COPY.stored.strong === false);
    check("verify copy: stored does not claim the seed couldn't be chosen", !/couldn't be chosen|couldn’t be chosen/i.test(COMMITMENT_COPY.stored.verdict) && !/committed before/i.test(COMMITMENT_COPY.stored.verdict));
    check("verify copy: stored says the hash was not shown in advance", /not shown to you in advance/i.test(COMMITMENT_COPY.stored.verdict));
    check("verify copy: only published is strong", Object.entries(COMMITMENT_COPY).every(([k, c]) => c.strong === (k === "published")));
  }

  console.log(`spinCommitment.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
