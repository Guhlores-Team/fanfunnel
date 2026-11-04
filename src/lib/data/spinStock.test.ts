import assert from "node:assert";
import { mock } from "node:test";
import { FakeSpinLedger, intentFor } from "./fakeSpinLedger";
import {
  mockAckFan,
  mockCreateHappyHour,
  mockCreatePass,
  mockDeleteHappyHour,
  mockGetWheel,
  mockSaveWheel,
  mockSpin,
} from "./mock";

// Regression (COR-9): a limited prize's stock must never be oversold or lose
// units under concurrent spins. On the live path (0059) the database owns the
// stock inside commit_spin_attempt: a commit that finds no unit left answers
// `sold_out`, and the TS side excludes that prize and redraws from the same
// committed pool (recorded in the fair trace) or, with nothing left to draw,
// declines the attempt through cancel_spin_attempt. No refund, decrement or
// compensating write ever happens outside the one commit, so N concurrent
// spins on a prize with stock K award it at most K times, leave stock ==
// K - awards, and spend exactly `awards` credits.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => true, createServiceClient: () => { throw new Error("must use the supplied client"); }, createClient: async () => { throw new Error("no session writer"); } } });
mock.module("@/lib/afterResponse", { namedExports: { runAfterResponse: () => {} } });
mock.module("@/lib/push/notify", { namedExports: { notifyCreator: async () => {} } });
mock.module("@/lib/data/webhooks", { namedExports: { fireWebhooks: async () => {} } });

/** Writers the live path may call. Anything else would be a split write. */
const LEDGER_RPCS = new Set(["prepare_spin_attempt", "commit_spin_attempt", "cancel_spin_attempt", "get_spin_attempt_status", "get_fan_focus_state", "record_fan_reward_views"]);
const declines = (l: FakeSpinLedger) => l.rpcs.filter((r) => r.name === "cancel_spin_attempt");

async function main() {
  const { commitSpinAttempt } = await import("./spinAttempts");
  const spinAll = (l: FakeSpinLedger, n: number) =>
    Promise.all(Array.from({ length: n }, (_, i) => commitSpinAttempt("tok", intentFor(l, `cs-${i}`), l.client())));

  // --- Supabase path ----------------------------------------------------------
  {
    // The only prize has stock 3; five concurrent spins race for it.
    const K = 3;
    const N = 5;
    const l = await new FakeSpinLedger([{ id: "prize-1", weight: 1, stock: K }], { balance: N }).init();
    const results = await spinAll(l, N);
    const awards = results.filter((r) => !("error" in r)).length;
    const losers = results.filter((r) => "error" in r);
    check(`${N} concurrent spins on stock ${K} award at most ${K} (got ${awards})`, awards <= K);
    check(`all ${K} units are sold (got ${awards})`, awards === K);
    check(`stock ends at K - awards (${l.stock.get("prize-1")})`, l.stock.get("prize-1") === K - awards);
    check("every loser is told the wheel sold out", losers.length === N - K && losers.every((r) => r.error === "no_prizes"));
    check("a loser spends nothing: the balance moved once per award", l.balance === N - awards);
    check("every loser was declined through the ledger, never refunded", declines(l).length === N - awards && declines(l).every((r) => r.args.p_error === "no_prizes"));
    // Contention was real: a loser whose commit raced another spin re-prepares
    // and sees the refreshed (sold-out) pool before it is declined.
    check("contention was real: losers re-prepared after another spin committed", l.rpcs.filter((r) => r.name === "prepare_spin_attempt").length > N);
    check("no split claim/refund/stock/pity writer is called", l.rpcs.every((r) => LEDGER_RPCS.has(r.name)));
  }
  {
    // A limited prize (stock 1, dominant weight) next to an unlimited one: the
    // commits that lose the unit must redraw onto the unlimited prize instead
    // of overselling or failing the spin.
    const N = 3;
    const l = await new FakeSpinLedger([
      { id: "limited", weight: 1000, stock: 1 },
      { id: "unlimited", weight: 1, stock: null },
    ], { balance: N }).init();
    const results = await spinAll(l, N);
    const won = results.map((r) => ("error" in r ? r.error : r.prize.id));
    const limited = won.filter((id) => id === "limited").length;
    check("the limited prize was contended (at least one commit)", l.writes() >= 1);
    check(`limited prize awarded at most once (got ${limited})`, limited <= 1);
    check(`limited stock ends at 1 - awards (${l.stock.get("limited")})`, l.stock.get("limited") === 1 - limited);
    check("every spin still wins a prize", won.every((id) => id === "limited" || id === "unlimited"));
    check("no spin is declined", declines(l).length === 0);
    // Same pass: a loser's commit is refused as retry_context (the nonce moved),
    // so it re-prepares and draws from the refreshed pool, where the sold-out
    // prize is simply absent (never in the trace, never in the snapshot).
    const after = l.spinRows.filter((s) => s.prize_id === "unlimited");
    check("a same-pass loser redraws from the refreshed pool: the sold-out prize is not in its snapshot", after.every((s) => !JSON.stringify(s.pool_snapshot).includes('"id":"limited"')));
    check("every committed trace names the prize that row won", l.spinRows.every((s) => (s.fair_trace as { won: string }).won === s.prize_id));
    check("every credit spent is a recorded win", l.balance === 0 && l.spinRows.length === N);
  }
  {
    // Another FAN takes the last unit between this spin's prepare and commit
    // (stock is not part of the context hash, so the context still matches):
    // the commit answers sold_out and the TS side redraws from the SAME
    // committed pool, recording the exclusion in the fair trace.
    const l = await new FakeSpinLedger([
      { id: "limited", weight: 1000, stock: 1 },
      { id: "unlimited", weight: 1, stock: null },
    ], { balance: 1 }).init();
    let raced = false;
    l.beforeCommit = (args) => {
      if (!raced && (args.p_spin as { prize_id: string }).prize_id === "limited") { raced = true; l.stock.set("limited", 0); }
    };
    const r = await commitSpinAttempt("tok", intentFor(l), l.client());
    const commits = l.rpcs.filter((c) => c.name === "commit_spin_attempt").map((c) => c.args.p_spin as Record<string, unknown>);
    check("cross-fan race: the limited prize was drawn first and refused at commit", raced && commits.length === 2 && commits[0].prize_id === "limited");
    check("cross-fan race: the redraw wins the unlimited prize", !("error" in r) && r.prize.id === "unlimited");
    check("cross-fan race: the redraw is recorded in the fair trace", JSON.stringify(l.spinRows[0]?.fair_trace) === JSON.stringify({ excluded: ["limited"], won: "unlimited" }));
    check("cross-fan race: the redraw reuses the committed pool, seed and nonce", commits[0].pool_hash === commits[1].pool_hash && commits[0].server_seed === commits[1].server_seed && commits[0].nonce === commits[1].nonce);
    check("cross-fan race: one credit, one row, the other fan's unit untouched", l.balance === 0 && l.spinRows.length === 1 && l.stock.get("limited") === 0);
  }
  {
    // Two spins on the last unit of the ONLY prize: exactly one wins; the other
    // is declined without touching stock or balance.
    const l = await new FakeSpinLedger([{ id: "prize-1", weight: 1, stock: 1 }], { balance: 2 }).init();
    const results = await spinAll(l, 2);
    const awards = results.filter((r) => !("error" in r)).length;
    check("two spins on stock 1: exactly one wins", awards === 1);
    check("two spins on stock 1: stock ends at 0", l.stock.get("prize-1") === 0);
    check("two spins on stock 1: the loser is declined and keeps its credit", declines(l).length === 1 && l.balance === 1);
  }
  {
    // The commit succeeds but its response is lost (connection reset). The
    // same request id is retried and recovers the SAME win: one unit taken,
    // one credit spent, never two.
    const l = await new FakeSpinLedger([{ id: "prize-1", weight: 1, stock: 3 }], { balance: 2 }).init();
    l.loseNextCommitResponse = true;
    const r = await commitSpinAttempt("tok", intentFor(l), l.client());
    check("lost commit response → the original win is recovered, not a db_error", !("error" in r) && r.replayed === true);
    check("lost commit response → exactly one unit taken, never two", l.stock.get("prize-1") === 2 && l.spinRows.length === 1);
    check("lost commit response → one credit spent and nothing refunded", l.balance === 1 && declines(l).length === 0);
    check("lost commit response → the retry reused the request id", l.rpcs.filter((c) => c.name === "commit_spin_attempt").length === 2 && new Set(l.rpcs.filter((c) => c.name === "commit_spin_attempt").map((c) => c.args.p_attempt)).size === 1);
  }
  {
    // The commit never reaches the database: the attempt stays pending and
    // nothing moves. A compensating refund would be wrong (it may still land).
    const l = await new FakeSpinLedger([{ id: "prize-1", weight: 1, stock: 3 }], { balance: 2 }).init();
    l.failCommitTransports = 3;
    const r = await commitSpinAttempt("tok", intentFor(l), l.client());
    check("commit transport failure → spin_pending, not a win", "error" in r && r.error === "spin_pending");
    check("commit transport failure → stock and balance untouched", l.stock.get("prize-1") === 3 && l.balance === 2 && l.spinRows.length === 0);
    check("commit transport failure → no decline or compensating write", declines(l).length === 0 && l.rpcs.every((c) => LEDGER_RPCS.has(c.name)));
  }

  // --- Mock path --------------------------------------------------------------
  // mockSpin picks and decrements synchronously, so outside a happy hour it
  // cannot oversell. During a happy hour the boosted clone used for the pick
  // carried a stock snapshot taken BEFORE the awaits, so concurrent spins could
  // all see stock 1 and all decrement the live wheel.
  async function mockRace(label: string, K: number, N: number, happyHour: boolean) {
    const wheel = mockGetWheel();
    const limited = {
      ...wheel,
      prizes: [{ ...wheel.prizes[0], rarity: "common" as const, weight: 1, stock: K }],
    };
    mockSaveWheel(limited);
    const hh = happyHour
      ? mockCreateHappyHour({
          wheelId: wheel.id,
          multiplier: 2,
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: new Date(Date.now() + 60_000).toISOString(),
        })
      : null;
    try {
      const { token } = mockCreatePass("Stock", N);
      mockAckFan(token);
      const results = await Promise.all(Array.from({ length: N }, () => mockSpin(token, "x")));
      const awards = results.filter((r) => !("error" in r)).length;
      const stock = mockGetWheel().prizes[0].stock;
      check(`${label}: at most ${K} awards (got ${awards})`, awards <= K);
      check(`${label}: all ${K} units sold (got ${awards})`, awards === K);
      check(`${label}: stock ends at K - awards (${stock})`, stock === K - awards);
      check(`${label}: losers see no_prizes`, results.every((r) => !("error" in r) || r.error === "no_prizes"));
    } finally {
      if (hh && "id" in hh) mockDeleteHappyHour(hh.id);
      mockSaveWheel(wheel);
    }
  }
  await mockRace("mock, no happy hour", 2, 4, false);
  await mockRace("mock, happy hour", 1, 3, true);

  console.log(`spinStock.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
