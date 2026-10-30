import assert from "node:assert";
import { renderToStaticMarkup } from "react-dom/server";
import { sha256Hex } from "@/lib/games/wheel/fairness";
import VerifyPage from "@/app/verify/[shareId]/page";
import { COMMITMENT_COPY, VERDICT_AMBER, VERDICT_GREEN, verdictColor } from "@/app/verify/[shareId]/commitmentCopy";
import { completeClaimedSpin } from "./index";
import {
  mockAckFan,
  mockCreatePass,
  mockGetFanPass,
  mockGetSpinVerification,
  mockSpin,
} from "./mock";
import {
  consumeCommittedSeed,
  freshSeed,
  type CommittedSeed,
  type SeedStore,
  type SwapOutcome,
} from "./spinSeed";

// Regression (COR-4): the public verify page said "committed before it was
// revealed" for EVERY spin whose seed re-hashes to the stored hash — including
// spins whose seed was generated at spin time (pre-0022 DBs, a legacy pass
// with no commitment, the mock's un-visited pass) and the CAS-loser spin whose
// commitment never reached the fan's spin page. Re-hashing a seed stored next
// to its own hash proves nothing about WHEN it was committed, so the spin must
// record how its seed was obtained and the page must only claim what holds.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

/** The fan_passes commitment row with a CAS-guarded update. */
function fakeRow(initial: CommittedSeed, beforeSwap?: () => Promise<void>) {
  let row: CommittedSeed = { ...initial };
  let hooked = false;
  const store: SeedStore = {
    read: async () => ({ ...row }),
    swap: async (expected, next): Promise<SwapOutcome> => {
      if (beforeSwap && !hooked) {
        hooked = true;
        await beforeSwap();
      }
      if (row.seed !== expected.seed) return "lost";
      row = { ...next };
      return "won";
    },
  };
  return { store, get row() { return row; } };
}

// --- A minimal scriptable fake Supabase client (see spinRefund.test.ts) ------
type Op = { name: string; args: unknown[] };
type Resp = { data: unknown; error: { message: string } | null };
type Handler = (ops: Op[]) => Resp;
const ok = (data: unknown): Resp => ({ data, error: null });
const has = (ops: Op[], name: string, arg?: string) =>
  ops.some((o) => o.name === name && (arg === undefined || String(o.args[0]).includes(arg)));

function fakeClient(handlers: Record<string, Handler>) {
  const builder = (table: string) => {
    const ops: Op[] = [];
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (res: (v: Resp) => unknown, rej: (e: unknown) => unknown) => {
              const h = handlers[table];
              if (!h) return Promise.reject(new Error(`no handler for ${table}`)).then(res, rej);
              return Promise.resolve(h(ops)).then(res, rej);
            };
          }
          return (...args: unknown[]) => {
            ops.push({ name: String(prop), args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const client = {
    from: (table: string) => builder(table),
    rpc: async () => ok(null),
  };
  return client as unknown as Parameters<typeof completeClaimedSpin>[0];
}

function wheelRow() {
  return {
    id: "wheel-1", title: "W", subtitle: null, brand_color: null, label_color: null,
    label_size: null, is_active: true, active_from: null, active_until: null, archived_at: null, game_ready: true,
    prizes: [{
      id: "prize-1", label: "Only prize", description: null, rarity: "common", weight: 1,
      color: null, emoji: null, image_url: null, cost_cents: null, stock: null, sort_order: 0,
    }],
  };
}

/** Run one Supabase-path spin against a pass row and return the spins insert. */
async function realSpinInsert(pass: Record<string, unknown>, swapWins: boolean) {
  let inserted: Record<string, unknown> | null = null;
  let swaps = 0;
  const seedAfterLoss = "e".repeat(64);
  const sb = fakeClient({
    fan_passes: (ops) => {
      if (has(ops, "update")) {
        swaps++;
        return ok(swapWins || swaps > 1 ? { id: pass.id } : null);
      }
      // ctx read, then the re-read after a lost swap holds the winner's commitment.
      if (swaps > 0 && !swapWins)
        return ok({ next_server_seed: seedAfterLoss, next_server_seed_hash: "1".repeat(64) });
      return ok(pass);
    },
    campaigns: () => ok(null),
    wheels: (ops) => (has(ops, "eq", "creator") && !has(ops, "maybeSingle") ? ok([]) : ok(wheelRow())),
    fans: () => ok({ pity_counter: 0 }),
    happy_hours: () => ok([]),
    prizes: () => ok({ id: "prize-1" }),
    spins: (ops) => {
      const ins = ops.find((o) => o.name === "insert");
      if (ins) inserted = ins.args[0] as Record<string, unknown>;
      return ok({ id: "spin-1", share_id: "share-1" });
    },
    redemptions: () => ok(null),
  });
  const r = await completeClaimedSpin(sb, "tok", "cs", 4);
  assert.ok(!("error" in r), "spin succeeded");
  assert.ok(inserted, "spins insert happened");
  return inserted as Record<string, unknown>;
}

async function renderVerify(shareId: string): Promise<string> {
  const el = await VerifyPage({ params: Promise.resolve({ shareId }) });
  return renderToStaticMarkup(el).replace(/&#x27;|&rsquo;|’/g, "'");
}

async function main() {
  // --- consumeCommittedSeed records HOW the seed was obtained ----------------
  {
    const seed = "a".repeat(64);
    const { store } = fakeRow({ seed, hash: await sha256Hex(seed) });
    const c = await consumeCommittedSeed(store);
    check("pre-committed seed consumed on the first swap → published", c?.commitment === "published");

    const { store: legacy } = fakeRow({ seed: null, hash: null });
    const l = await consumeCommittedSeed(legacy);
    check("legacy pass with no commitment → fresh", l?.commitment === "fresh");

    const f = await freshSeed();
    check("pre-0022 fallback seed → fresh", f.commitment === "fresh");

    // CAS loser: another spin consumes the committed seed between our read and
    // our swap, so we consume the seed IT committed (stored, never shown to us).
    const seedA = "b".repeat(64);
    const row = fakeRow({ seed: seedA, hash: await sha256Hex(seedA) }, async () => {
      await consumeCommittedSeed(row.store);
    });
    const loser = await consumeCommittedSeed(row.store);
    check("CAS loser consumes the winner's commitment → stored", loser?.commitment === "stored");
  }

  // --- Supabase path: the spin row carries the commitment ---------------------
  {
    const pass = {
      id: "pass-1", creator_id: "creator-1", campaign_id: null, wheel_id: "wheel-1", fan_id: "fan-1",
      next_server_seed: "f".repeat(64), next_server_seed_hash: await sha256Hex("f".repeat(64)),
    };
    const won = await realSpinInsert(pass, true);
    check("spins insert records seed_commitment=published for a pre-committed seed", won.seed_commitment === "published");
    const lost = await realSpinInsert(pass, false);
    check("spins insert records seed_commitment=stored for the CAS loser", lost.seed_commitment === "stored");
    const legacy = await realSpinInsert({ ...pass, next_server_seed: null, next_server_seed_hash: null }, true);
    check("spins insert records seed_commitment=fresh for a legacy pass", legacy.seed_commitment === "fresh");
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

    // The CAS loser's seed was generated by the winner while this request was
    // already on the server, so it can't be presented as fixed in advance.
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
