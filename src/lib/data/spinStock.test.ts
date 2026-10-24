import assert from "node:assert";
import { completeClaimedSpin } from "./index";
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
// units under concurrent spins. On the base branch the decrement wrote
// `stock: <value read with the wheel> - 1` guarded only by `.gt("stock", 0)`,
// so two spins that both read stock=3 both wrote 2: one unit vanished from the
// count and the prize was awarded more times than its stock. The decrement is
// now a compare-and-swap on the value read (retried from a fresh read on a
// miss), so N concurrent spins on a prize with stock K award it at most K
// times and leave stock == K - awards.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- A scriptable fake Supabase client with an interleaving hook ------------
// Same shape as spinRefund.test.ts: `from(table)` returns a chainable builder
// that records every call and, when awaited, resolves to the table handler's
// answer for that op list. `before(table, ops)` runs right before the handler
// and lets a test park concurrent spins at a chosen query (a barrier) so they
// reach the stock write holding the same stale read.

type Op = { name: string; args: unknown[] };
type Resp = { data: unknown; error: { message: string } | null };
type Handler = (ops: Op[]) => Resp;
type Before = (table: string, ops: Op[]) => Promise<void>;
const ok = (data: unknown): Resp => ({ data, error: null });
const has = (ops: Op[], name: string, arg?: string) =>
  ops.some((o) => o.name === name && (arg === undefined || String(o.args[0]).includes(arg)));

function fakeClient(handlers: Record<string, Handler>, before?: Before) {
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const builder = (table: string) => {
    const ops: Op[] = [];
    const run = async () => {
      const h = handlers[table];
      if (!h) throw new Error(`fake client: no handler for table ${table}`);
      if (before) await before(table, ops);
      return h(ops);
    };
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (res: (v: Resp) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej);
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
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return ok(null);
    },
  };
  return { sb: client as unknown as Parameters<typeof completeClaimedSpin>[0], rpcs };
}

/** Lets the first `n` arrivals through together, once they have ALL arrived. */
function barrier(n: number) {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  return async () => {
    if (arrived >= n) return;
    arrived++;
    if (arrived === n) release();
    await open;
  };
}

const PASS = {
  id: "pass-1",
  creator_id: "creator-1",
  campaign_id: null,
  wheel_id: "wheel-1",
  fan_id: "fan-1",
  next_server_seed: "f".repeat(64),
  next_server_seed_hash: "0".repeat(64),
};

type PrizeSpec = { id: string; weight: number; stock: number | null; rarity?: string };

/**
 * An in-memory `prizes` table that honours the query the spin path sends:
 * an UPDATE applies only when every `.eq`/`.gt` filter on `stock` matches the
 * CURRENT value (as Postgres would), a SELECT returns the current row.
 */
function prizeTable(specs: PrizeSpec[]) {
  const stock = new Map(specs.map((p) => [p.id, p.stock]));
  let writes = 0;
  const handler: Handler = (ops) => {
    const id = ops.find((o) => o.name === "eq" && o.args[0] === "id")?.args[1] as string;
    const current = stock.get(id);
    if (current === undefined) return ok(null);
    const upd = ops.find((o) => o.name === "update");
    if (!upd) return ok({ id, stock: current });
    writes++;
    const eqStock = ops.find((o) => o.name === "eq" && o.args[0] === "stock");
    const gtStock = ops.find((o) => o.name === "gt" && o.args[0] === "stock");
    if (eqStock && current !== eqStock.args[1]) return ok(null);
    if (gtStock && !(typeof current === "number" && current > (gtStock.args[1] as number))) return ok(null);
    stock.set(id, (upd.args[0] as { stock: number }).stock);
    return ok({ id });
  };
  const wheelRow = () => ({
    id: "wheel-1",
    title: "W",
    subtitle: null,
    brand_color: null,
    label_color: null,
    label_size: null,
    is_active: true,
    active_from: null,
    active_until: null,
    archived_at: null,
    prizes: specs.map((p, i) => ({
      id: p.id,
      label: p.id,
      description: null,
      rarity: p.rarity ?? "common",
      weight: p.weight,
      color: null,
      emoji: null,
      image_url: null,
      cost_cents: null,
      stock: stock.get(p.id),
      sort_order: i,
    })),
  });
  return { handler, wheelRow, stock, writes: () => writes };
}

function handlers(prizes: ReturnType<typeof prizeTable>): Record<string, Handler> {
  return {
    fan_passes: (ops) => (has(ops, "update") ? ok({ id: PASS.id }) : ok(PASS)),
    campaigns: () => ok(null),
    wheels: (ops) => (has(ops, "eq", "creator") ? ok([]) : ok(prizes.wheelRow())),
    fans: () => ok({ pity_counter: 0 }),
    happy_hours: () => ok([]),
    prizes: prizes.handler,
    spins: () => ok({ id: "spin-1", share_id: "share-1" }),
    redemptions: () => ok(null),
  };
}

/** Park every spin's FIRST stock write until all `n` have reached it. */
function stockWriteBarrier(n: number): Before {
  const wait = barrier(n);
  return async (table, ops) => {
    if (table === "prizes" && has(ops, "update")) await wait();
  };
}

const refunds = (rpcs: { name: string; args: Record<string, unknown> }[]) =>
  rpcs.filter((r) => r.name === "rollback_claimed_spin");

async function main() {
  // --- Supabase path ----------------------------------------------------------
  {
    // The only prize has stock 3; five spins all read 3 and race to write.
    const K = 3;
    const N = 5;
    const prizes = prizeTable([{ id: "prize-1", weight: 1, stock: K }]);
    const { sb, rpcs } = fakeClient(handlers(prizes), stockWriteBarrier(N));
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => completeClaimedSpin(sb, "tok", `cs-${i}`, N - i)),
    );
    const awards = results.filter((r) => !("error" in r)).length;
    const losers = results.filter((r) => "error" in r);
    check(`${N} concurrent spins on stock ${K} award at most ${K} (got ${awards})`, awards <= K);
    check(`all ${K} units are sold (got ${awards})`, awards === K);
    check(`stock ends at K - awards (${prizes.stock.get("prize-1")})`, prizes.stock.get("prize-1") === K - awards);
    check("every loser is told the wheel sold out", losers.every((r) => r.error === "no_prizes"));
    check(
      "every loser is refunded WITHOUT restoring a unit it never took",
      refunds(rpcs).length === N - awards && refunds(rpcs).every((r) => r.args.p_prize_id === null),
    );
    check("contention was real: more writes than units", prizes.writes() > K);
  }
  {
    // A limited prize (stock 1, dominant weight) next to an unlimited one: the
    // CAS losers must re-pick onto the unlimited prize instead of overselling
    // or failing the spin.
    const N = 3;
    const prizes = prizeTable([
      { id: "limited", weight: 1000, stock: 1 },
      { id: "unlimited", weight: 1, stock: null },
    ]);
    const { sb, rpcs } = fakeClient(handlers(prizes), stockWriteBarrier(N));
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => completeClaimedSpin(sb, "tok", "cs", N - i)),
    );
    const won = results.map((r) => ("error" in r ? r.error : r.prize.id));
    const limited = won.filter((id) => id === "limited").length;
    check("the limited prize was contended (at least one write)", prizes.writes() >= 1);
    check(`limited prize awarded at most once (got ${limited})`, limited <= 1);
    check(`limited stock ends at 1 - awards (${prizes.stock.get("limited")})`, prizes.stock.get("limited") === 1 - limited);
    check("every spin still wins a prize", won.every((id) => id === "limited" || id === "unlimited"));
    check("no spin is refunded", refunds(rpcs).length === 0);
  }
  {
    // Lost CAS whose stock is re-read as 0 while the prize is the ONLY one: the
    // spin fails as sold out and refunds without touching stock.
    const prizes = prizeTable([{ id: "prize-1", weight: 1, stock: 1 }]);
    const { sb, rpcs } = fakeClient(handlers(prizes), stockWriteBarrier(2));
    const results = await Promise.all([
      completeClaimedSpin(sb, "tok", "a", 2),
      completeClaimedSpin(sb, "tok", "b", 1),
    ]);
    const awards = results.filter((r) => !("error" in r)).length;
    check("two spins on stock 1: exactly one wins", awards === 1);
    check("two spins on stock 1: stock ends at 0", prizes.stock.get("prize-1") === 0);
    check("two spins on stock 1: the loser refunds with no prize", refunds(rpcs).length === 1 && refunds(rpcs)[0].args.p_prize_id === null);
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
