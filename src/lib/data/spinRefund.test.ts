import assert from "node:assert";
import { mock } from "node:test";
import { FakeSpinLedger, intentFor } from "./fakeSpinLedger";
import {
  mockAckFan,
  mockCreatePass,
  mockGetFanPass,
  mockGetWheel,
  mockSaveWheel,
  mockSpin,
} from "./mock";

// Regression (COR-8): a fan must never be charged a spin for nothing. On the
// live path (0059) there is no claim-then-refund: the credit, the win row, the
// stock unit and the seed rotation commit together in commit_spin_attempt, so
// every exit that is not a durably recorded win leaves the balance untouched.
// A request that cannot be served is declined through cancel_spin_attempt
// (no_prizes); a request whose commit cannot be confirmed stays pending under
// the SAME request id (spin_pending) and is never "refunded" blindly, because
// the commit may still have landed.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => true, createServiceClient: () => { throw new Error("must use the supplied client"); }, createClient: async () => { throw new Error("no session writer"); } } });
mock.module("@/lib/afterResponse", { namedExports: { runAfterResponse: () => {} } });
mock.module("@/lib/push/notify", { namedExports: { notifyCreator: async () => {} } });
mock.module("@/lib/data/webhooks", { namedExports: { fireWebhooks: async () => {} } });

const LEDGER_RPCS = new Set(["prepare_spin_attempt", "commit_spin_attempt", "cancel_spin_attempt", "get_spin_attempt_status", "get_fan_focus_state", "record_fan_reward_views"]);
const calls = (l: FakeSpinLedger, name: string) => l.rpcs.filter((r) => r.name === name);

async function main() {
  const { commitSpinAttempt } = await import("./spinAttempts");
  const world = (stock: number | null, opts: ConstructorParameters<typeof FakeSpinLedger>[1] = {}) =>
    new FakeSpinLedger([{ id: "prize-1", weight: 1, stock }], { balance: 4, ...opts }).init();

  // --- Supabase path (fake ledger) -------------------------------------------
  {
    const l = await world(null);
    const r = await commitSpinAttempt("tok", intentFor(l), l.client());
    check("control: a working spin returns a prize", !("error" in r) && r.prize.id === "prize-1");
    check("control: a working spin spends exactly one credit and is never declined", l.balance === 3 && calls(l, "cancel_spin_attempt").length === 0);
    check("control: the response carries the post-commit balance", !("error" in r) && r.spinsRemaining === 3);
  }
  {
    // The game is not ready to play: declined before any commit, credit kept.
    const l = await world(null, { gameReady: false });
    const r = await commitSpinAttempt("tok", intentFor(l), l.client());
    check("game not ready → no_prizes", "error" in r && r.error === "no_prizes");
    check("game not ready → declined through the ledger, nothing committed", calls(l, "cancel_spin_attempt").length === 1 && calls(l, "commit_spin_attempt").length === 0);
    check("game not ready → balance untouched", l.balance === 4);
  }
  {
    // Every prize sold out (the only prize has stock 0): nothing can be won.
    const l = await world(0);
    const r = await commitSpinAttempt("tok", intentFor(l), l.client());
    check("sold out → no_prizes", "error" in r && r.error === "no_prizes");
    check("sold out → declined once, balance and stock untouched", calls(l, "cancel_spin_attempt").length === 1 && l.balance === 4 && l.stock.get("prize-1") === 0);
    check("sold out → no spin row, no redemption", l.spinRows.length === 0 && l.redemptions.length === 0);
  }
  {
    // The last unit goes to another fan between prepare and commit: the
    // commit answers sold_out, and with nothing left to draw the attempt is
    // declined, not charged.
    const l = await world(1);
    l.beforeCommit = () => { l.stock.set("prize-1", 0); };
    const r = await commitSpinAttempt("tok", intentFor(l), l.client());
    check("unit lost at commit → no_prizes", "error" in r && r.error === "no_prizes");
    check("unit lost at commit → the commit was refused, then the attempt declined", calls(l, "commit_spin_attempt").length === 1 && calls(l, "cancel_spin_attempt").length === 1);
    check("unit lost at commit → balance untouched", l.balance === 4 && l.spinRows.length === 0);
  }
  {
    // The pass vanished (or was paused/blocked) before the attempt opened:
    // prepare answers unavailable. Nothing is charged and nothing is committed.
    const l = await world(null);
    l.prepareReply = { status: "unavailable" };
    const r = await commitSpinAttempt("tok", intentFor(l), l.client());
    check("pass missing → an error, never a win", "error" in r);
    check("pass missing → no commit, no decline, balance untouched", calls(l, "commit_spin_attempt").length === 0 && calls(l, "cancel_spin_attempt").length === 0 && l.balance === 4);
  }
  {
    // No game resolves for the link (no campaign pin, no ready wheel, the
    // stored wheel archived or deleted): prepare declines no_wheel itself.
    const l = await world(null);
    l.prepareReply = { status: "declined", error: "no_wheel" };
    const r = await commitSpinAttempt("tok", intentFor(l), l.client());
    check("no wheel resolves → no_prizes", "error" in r && r.error === "no_prizes");
    check("no wheel resolves → nothing committed, balance untouched", calls(l, "commit_spin_attempt").length === 0 && l.balance === 4 && l.spinRows.length === 0);
  }
  {
    // A read between prepare and commit fails (the sealed reward candidate):
    // the attempt stays pending under its id; nothing is written or refunded.
    const l = await new FakeSpinLedger([{ id: "prize-1", weight: 1, stock: 2, delivery: "codes" }], { balance: 4, codes: { "prize-1": [{ cipher: "c", iv: "i", keyVersion: 1 }] } }).init();
    l.failNextReadOf = "prize_reward_codes";
    const r = await commitSpinAttempt("tok", intentFor(l), l.client());
    check("read error before commit → spin_pending, not a 500", "error" in r && r.error === "spin_pending");
    check("read error before commit → no commit, no decline, stock and balance untouched", calls(l, "commit_spin_attempt").length === 0 && calls(l, "cancel_spin_attempt").length === 0 && l.balance === 4 && l.stock.get("prize-1") === 2 && l.freeCodes("prize-1") === 1);
  }
  {
    // No credit left: the ledger declines at prepare; nothing is committed.
    const l = await world(null, { balance: 0 });
    const r = await commitSpinAttempt("tok", intentFor(l), l.client());
    check("no credit → no_spins", "error" in r && r.error === "no_spins");
    check("no credit → no commit, no decline", calls(l, "commit_spin_attempt").length === 0 && calls(l, "cancel_spin_attempt").length === 0);
  }
  {
    // The prepare call never reaches the database.
    const l = await world(null);
    l.failNextPrepare = true;
    const r = await commitSpinAttempt("tok", intentFor(l), l.client());
    check("prepare transport failure → spin_pending, not a 500", "error" in r && r.error === "spin_pending");
    check("prepare transport failure → nothing written", calls(l, "commit_spin_attempt").length === 0 && l.balance === 4);
  }
  {
    // The commit cannot be confirmed: pending under the same id, no refund.
    const l = await world(3);
    l.failCommitTransports = 3;
    const r = await commitSpinAttempt("tok", intentFor(l), l.client());
    check("commit transport failure → spin_pending", "error" in r && r.error === "spin_pending");
    check("commit transport failure → the three retries reuse one request id", calls(l, "commit_spin_attempt").length === 3 && new Set(calls(l, "commit_spin_attempt").map((c) => c.args.p_attempt)).size === 1);
    check("commit transport failure → balance and stock untouched, nothing declined", l.balance === 4 && l.stock.get("prize-1") === 3 && calls(l, "cancel_spin_attempt").length === 0);
  }
  {
    // The commit landed but its response was lost: the retry recovers the
    // recorded win instead of charging a second credit or refunding one.
    const l = await world(3);
    l.loseNextCommitResponse = true;
    const intent = intentFor(l);
    const r = await commitSpinAttempt("tok", intent, l.client());
    check("lost response → the original win is returned (replayed)", !("error" in r) && r.replayed === true && r.attemptId === intent.requestId);
    check("lost response → one credit, one unit, one row", l.balance === 3 && l.stock.get("prize-1") === 2 && l.spinRows.length === 1);
    check("lost response → never refunded", calls(l, "cancel_spin_attempt").length === 0);
  }
  {
    // Something throws after prepare (the focus/stock projection read dies):
    // the win is still recorded; the response says pending, never a refund.
    const l = await world(null);
    let reads = 0;
    const client = l.client();
    const broken = { from: client.from.bind(client), rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "get_fan_focus_state" && reads++ === 0) throw new Error("boom");
      return l.rpc(name, args);
    } } as unknown as typeof client;
    const r = await commitSpinAttempt("tok", intentFor(l), broken);
    check("throw after commit → spin_pending, not a 500 and not a refund", "error" in r && r.error === "spin_pending" && calls(l, "cancel_spin_attempt").length === 0);
    check("throw after commit → the recorded win and its credit stand", l.spinRows.length === 1 && l.balance === 3);
  }
  {
    // Nothing in any of the above ever reached a split writer.
    const l = await world(null);
    await commitSpinAttempt("tok", intentFor(l), l.client());
    check("no claim/refund/stock/pity writer exists on the live path", l.rpcs.every((r) => LEDGER_RPCS.has(r.name)));
  }

  // --- Mock path: sold-out wheel refunds the spin ---------------------------
  {
    const { token } = mockCreatePass("Refund", 3);
    mockAckFan(token);
    const view = await mockGetFanPass(token);
    assert.ok(view, "pass view");
    const wheel = mockGetWheel();
    const soldOut = { ...wheel, prizes: wheel.prizes.map((p) => ({ ...p, stock: 0 })) };
    mockSaveWheel(soldOut);
    try {
      const r = await mockSpin(token, "x");
      check("mock sold out → no_prizes (not a throw)", "error" in r && r.error === "no_prizes");
      const after = await mockGetFanPass(token);
      check("mock sold out → balance refunded", after?.spinsRemaining === 3);
    } finally {
      mockSaveWheel(wheel); // restore for any later suite sharing the store
    }
  }

  console.log(`spinRefund.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
