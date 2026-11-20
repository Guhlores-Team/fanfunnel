import assert from "node:assert";
import { randomBytes } from "node:crypto";
import { mock } from "node:test";
import { sealReward } from "@/lib/rewards/crypto";
import { FakeSpinLedger, intentFor } from "./fakeSpinLedger";

// #26 instant-delivery prizes on the live spin path (commitSpinAttempt),
// against a fake that models the 0059 ledger's guarantees:
//   * the TS side picks a sealed candidate (one unused code, or the prize's
//     link/text) and decrypts it BEFORE asking for the commit, so a prize that
//     cannot be delivered is never awarded;
//   * commit_spin_attempt binds that exact candidate to the spin row in the
//     same transaction: a code already taken answers sold_out (redraw), an
//     edited link/text answers changed (re-read and retry), and a committed
//     receipt is immutable and replays for its request id.
// What is proven here is the TS side: a delivered win is fulfilled and carries
// the value for the winner only, concurrent spins never share a code, an
// undeliverable prize never pays out and no retry ever creates a second win.
// The same race against real Postgres row locks is in scripts/db.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// A throwaway key for this process only (never a real key, never committed).
process.env.REWARD_ENCRYPTION_KEY = randomBytes(32).toString("base64");
delete process.env.REWARD_ENCRYPTION_KEY_VERSION;

mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => true, createServiceClient: () => { throw new Error("must use the supplied client"); }, createClient: async () => { throw new Error("no session writer"); } } });
mock.module("@/lib/afterResponse", { namedExports: { runAfterResponse: () => {} } });
mock.module("@/lib/push/notify", { namedExports: { notifyCreator: async () => {} } });
mock.module("@/lib/data/webhooks", { namedExports: { fireWebhooks: async () => {} } });

const CREATOR = "creator-1";
type PrizeSpec = { id: string; weight: number; stock: number | null; delivery?: "manual" | "link" | "text" | "codes" };

async function world(prizes: PrizeSpec[], opts: { codes?: Record<string, string[]>; links?: Record<string, string>; balance?: number } = {}) {
  return new FakeSpinLedger(prizes, {
    creatorId: CREATOR,
    balance: opts.balance ?? 20,
    rewards: Object.fromEntries(Object.entries(opts.links ?? {}).map(([id, value]) => [id, sealReward(value, CREATOR)])),
    codes: Object.fromEntries(Object.entries(opts.codes ?? {}).map(([id, list]) => [id, list.map((v) => sealReward(v, CREATOR))])),
  }).init();
}
const declines = (l: FakeSpinLedger) => l.rpcs.filter((r) => r.name === "cancel_spin_attempt");
const commits = (l: FakeSpinLedger) => l.rpcs.filter((r) => r.name === "commit_spin_attempt");

async function main() {
  const { commitSpinAttempt } = await import("./spinAttempts");
  const spinAll = (l: FakeSpinLedger, n: number) =>
    Promise.all(Array.from({ length: n }, (_, i) => commitSpinAttempt("tok", intentFor(l, `cs-${i}`), l.client())));
  {
    // 20 concurrent spins on a 5-code prize, nothing else on the wheel.
    const w = await world([{ id: "codes", weight: 1, stock: null, delivery: "codes" }], { codes: { codes: ["AAAA-1111", "BBBB-2222", "CCCC-3333", "DDDD-4444", "EEEE-5555"] } });
    const results = await spinAll(w, 20);
    const wins = results.filter((r) => !("error" in r));
    const values = wins.map((r) => ("error" in r ? "" : r.reward?.value ?? ""));
    check(`20 spins on 5 codes: exactly 5 win (got ${wins.length})`, wins.length === 5);
    check("each winner got a distinct code", new Set(values).size === 5 && values.every((v) => /^[A-E]{4}-\d{4}$/.test(v)));
    check("every winner's response carries kind 'code'", wins.every((r) => !("error" in r) && r.reward?.kind === "code"));
    check("the 15 others are told the wheel sold out", results.filter((r) => "error" in r && r.error === "no_prizes").length === 15);
    check("the 15 others keep their credit (declined, never refunded)", w.balance === 15 && declines(w).length === 15);
    check("stock (= unused codes) ends at 0", w.freeCodes("codes") === 0);
    check("5 spin rows, each with its own code", w.spinRows.length === 5 && new Set([...w.codes.values()].map((c) => c.spinId)).size === 5);
    check("delivered wins are fulfilled, not pending", w.redemptions.length === 5 && w.redemptions.every((r) => r.status === "fulfilled"));
    check("the prize object sent to the fan carries no reward field", wins.every((r) => !("error" in r) && !/cipher|delivery|reward/i.test(JSON.stringify(r.prize))));
  }
  {
    // Out of codes behaves like sold-out stock: the spin re-draws onto the
    // manual prize instead of awarding a code it can't deliver.
    const w = await world(
      [
        { id: "codes", weight: 1000, stock: null, delivery: "codes" },
        { id: "plain", weight: 1, stock: null },
      ],
      { codes: { codes: ["ONLY-0001"] } },
    );
    const a = await commitSpinAttempt("tok", intentFor(w, "a"), w.client());
    const b = await commitSpinAttempt("tok", intentFor(w, "b"), w.client());
    check("first spin wins the last code", !("error" in a) && a.prize.id === "codes" && a.reward?.value === "ONLY-0001");
    check("with no code left the prize is never awarded", !("error" in b) && b.prize.id === "plain" && b.reward === undefined);
    check("the redraw is recorded in the trace", JSON.stringify(w.spinRows[1]?.fair_trace) === JSON.stringify({ excluded: ["codes"], won: "plain" }));
    check("the manual win stays pending for the creator", w.redemptions[1]?.status === "pending");
  }
  {
    // The code is taken by another spin between the candidate read and the
    // commit: the commit refuses it; the spin redraws rather than sharing it.
    const w = await world(
      [
        { id: "codes", weight: 1000, stock: null, delivery: "codes" },
        { id: "plain", weight: 1, stock: null },
      ],
      { codes: { codes: ["RACE-0001"] } },
    );
    let raced = false;
    w.beforeCommit = () => { if (!raced) { raced = true; for (const c of w.codes.values()) c.spinId = "someone-else"; } };
    const r = await commitSpinAttempt("tok", intentFor(w), w.client());
    check("a code taken at commit is never shared: the spin redraws", !("error" in r) && r.prize.id === "plain" && r.reward === undefined);
    check("one credit, one row, the taken code stays with its owner", w.balance === 19 && w.spinRows.length === 1 && [...w.codes.values()][0].spinId === "someone-else");
  }
  {
    // The commit cannot be confirmed: pending under the same id, no release,
    // no refund (the commit may still have bound the code).
    const w = await world([{ id: "codes", weight: 1, stock: null, delivery: "codes" }], { codes: { codes: ["X-1"] } });
    w.failCommitTransports = 3;
    const r = await commitSpinAttempt("tok", intentFor(w), w.client());
    check("unknown commit outcome → pending; no blind refund or release", "error" in r && r.error === "spin_pending" && declines(w).length === 0 && w.balance === 20);
    check("unknown commit outcome → the code is still unused", w.freeCodes("codes") === 1);
  }
  {
    // A link prize delivers its link; one whose reward is missing is never awarded.
    const w = await world(
      [
        { id: "vip", weight: 1000, stock: null, delivery: "link" },
        { id: "plain", weight: 1, stock: null },
      ],
      { links: { vip: "https://example.com/vip" } },
    );
    const r = await commitSpinAttempt("tok", intentFor(w), w.client());
    check("link prize: the winner gets the link", !("error" in r) && r.reward?.kind === "link" && r.reward.value === "https://example.com/vip");
    check("link prize: fulfilled automatically", w.redemptions[0]?.status === "fulfilled");
    const broken = await world([
      { id: "vip", weight: 1000, stock: null, delivery: "link" },
      { id: "plain", weight: 1, stock: null },
    ]);
    const b = await commitSpinAttempt("tok", intentFor(broken), broken.client());
    check("link prize without a reward: declined, never awarded and never charged", "error" in b && broken.spinRows.length === 0 && broken.balance === 20);
    check("link prize without a reward: the decline names the reason", declines(broken).length === 1 && declines(broken)[0].args.p_error === "reward_unavailable" && commits(broken).length === 0);
  }
  {
    // A limited text prize still takes its stock unit in the commit.
    const w = await world([{ id: "vip", weight: 1, stock: 2, delivery: "text" }], { links: { vip: "Your password is swordfish" } });
    const r = await commitSpinAttempt("tok", intentFor(w), w.client());
    check("limited text prize: delivered and one unit taken", !("error" in r) && r.reward?.value === "Your password is swordfish" && w.stock.get("vip") === 1);
  }
  {
    // Without the key nothing instant can be delivered: declined, not awarded.
    const saved = process.env.REWARD_ENCRYPTION_KEY;
    const w = await world(
      [
        { id: "codes", weight: 1000, stock: null, delivery: "codes" },
        { id: "plain", weight: 1, stock: null },
      ],
      { codes: { codes: ["NOKEY-001"] } },
    );
    delete process.env.REWARD_ENCRYPTION_KEY;
    const r = await commitSpinAttempt("tok", intentFor(w), w.client());
    process.env.REWARD_ENCRYPTION_KEY = saved;
    check("no key: the code prize is not awarded and nothing is charged", "error" in r && w.spinRows.length === 0 && w.balance === 20);
    check("no key: no code was bound and no commit attempted", w.freeCodes("codes") === 1 && commits(w).length === 0 && declines(w)[0]?.args.p_error === "reward_unavailable");
  }
  {
    const w = await world([{ id: "codes", weight: 1, stock: null, delivery: "codes" }], { codes: { codes: ["RECOVER-0001"] } });
    w.loseNextCommitResponse = true;
    const r = await commitSpinAttempt("tok", intentFor(w, "same-seed"), w.client());
    check("lost response after commit is recovered as the original win", !("error" in r) && r.reward?.value === "RECOVER-0001" && r.replayed === true);
    check("timeout retry creates one spin and one redemption only", w.spinRows.length === 1 && w.redemptions.length === 1 && w.freeCodes("codes") === 0);
    check("timeout retry never refunds a recorded win", declines(w).length === 0 && w.balance === 19);
    const calls = commits(w);
    check("timeout retries keep identical committed payload and UUID", calls.length === 2 && JSON.stringify(calls[0].args) === JSON.stringify(calls[1].args));
  }
  {
    const w = await world([{ id: "vip", weight: 1, stock: 2, delivery: "link" }], { links: { vip: "https://example.com/old" } });
    let edited = false;
    w.beforeCommit = () => { if (!edited) { edited = true; const fresh = sealReward("https://example.com/new", CREATOR); w.rewards.set("vip", { kind: "link", cipher: fresh.cipher, iv: fresh.iv, key_version: fresh.keyVersion }); } };
    const r = await commitSpinAttempt("tok", intentFor(w, "same-seed"), w.client());
    check("an edit between decrypt and commit retries onto the immutable new receipt", !("error" in r) && r.reward?.value === "https://example.com/new");
    check("edit retry takes only one stock unit and creates one win", w.stock.get("vip") === 1 && w.spinRows.length === 1 && w.redemptions.length === 1);
    const calls = commits(w);
    check("edit retry preserves the exact fairness snapshot and trace", calls.length === 2 && JSON.stringify(calls[0].args.p_spin) === JSON.stringify(calls[1].args.p_spin));
  }

  console.log(`spinRewards.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
