import assert from "node:assert";
import { completeClaimedSpin } from "./index";
import {
  mockAckFan,
  mockCreatePass,
  mockGetFanPass,
  mockGetWheel,
  mockSaveWheel,
  mockSpin,
} from "./mock";

// Regression (COR-8): once claim_spin has decremented the fan's balance, EVERY
// exit that is not a durably recorded win must refund it via
// rollback_claimed_spin (and restore a limited prize's stock when one was
// decremented). On main the "no wheel resolves" and "wheel row missing" early
// returns, and any error thrown between the claim and the spins insert,
// charged the fan a spin for nothing.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- A scriptable fake Supabase client -------------------------------------
// `from(table)` returns a chainable builder that records every call; awaiting
// it (or `.single()` / `.maybeSingle()`) resolves to whatever the table's
// handler returns for that op list. `rpc()` is logged so the test can assert
// exactly which refunds were issued.

type Op = { name: string; args: unknown[] };
type Resp = { data: unknown; error: { message: string } | null };
type Handler = (ops: Op[]) => Resp;
const ok = (data: unknown): Resp => ({ data, error: null });
const fail = (message: string): Resp => ({ data: null, error: { message } });
const has = (ops: Op[], name: string, arg?: string) =>
  ops.some((o) => o.name === name && (arg === undefined || String(o.args[0]).includes(arg)));

function fakeClient(handlers: Record<string, Handler>) {
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const builder = (table: string) => {
    const ops: Op[] = [];
    const run = () => {
      const h = handlers[table];
      if (!h) throw new Error(`fake client: no handler for table ${table}`);
      return h(ops);
    };
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (res: (v: Resp) => unknown, rej: (e: unknown) => unknown) => {
              try {
                return Promise.resolve(run()).then(res, rej);
              } catch (e) {
                return Promise.reject(e).then(res, rej);
              }
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
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return ok(null);
    },
  };
  return { sb: client as unknown as Parameters<typeof completeClaimedSpin>[0], rpcs };
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

function wheelRow(stock: number | null) {
  return {
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
    prizes: [
      {
        id: "prize-1",
        label: "Only prize",
        description: null,
        rarity: "common",
        weight: 1,
        color: null,
        emoji: null,
        image_url: null,
        cost_cents: null,
        stock,
        sort_order: 0,
      },
    ],
  };
}

/** Handlers for a fully working spin; override per scenario. */
function happyPath(overrides: Partial<Record<string, Handler>> = {}, pass = PASS): Record<string, Handler> {
  return {
    fan_passes: (ops) => {
      if (has(ops, "update")) return ok({ id: pass.id }); // seed CAS wins
      return ok(pass); // ctx read and seed re-read
    },
    campaigns: () => ok(null),
    wheels: (ops) => (has(ops, "eq", "creator") ? ok([]) : ok(wheelRow(null))),
    fans: () => ok({ pity_counter: 0 }),
    happy_hours: () => ok([]),
    prizes: () => ok({ id: "prize-1" }),
    spins: () => ok({ id: "spin-1", share_id: "share-1" }),
    redemptions: () => ok(null),
    ...overrides,
  };
}

const refunds = (rpcs: { name: string; args: Record<string, unknown> }[]) =>
  rpcs.filter((r) => r.name === "rollback_claimed_spin");

async function main() {
  // --- Supabase path (fake client) ------------------------------------------
  {
    const { sb, rpcs } = fakeClient(happyPath());
    const r = await completeClaimedSpin(sb, "tok", "cs", 4);
    check("control: a working spin returns a prize", !("error" in r) && r.prize.id === "prize-1");
    check("control: a working spin issues NO refund", refunds(rpcs).length === 0);
  }
  {
    // Pass row vanished between claim and read (both selects come back empty).
    const { sb, rpcs } = fakeClient(happyPath({ fan_passes: () => fail("no rows") }));
    const r = await completeClaimedSpin(sb, "tok", "cs", 4);
    check("pass missing after claim → db_error", "error" in r && r.error === "db_error");
    check("pass missing after claim → refunded once, no prize to restore", refunds(rpcs).length === 1 && refunds(rpcs)[0].args.p_prize_id === null);
  }
  {
    // No wheel resolves: no campaign pin, no creator wheels, pass has no wheel_id.
    const { sb, rpcs } = fakeClient(happyPath({ wheels: () => ok([]) }, { ...PASS, wheel_id: null as unknown as string }));
    const r = await completeClaimedSpin(sb, "tok", "cs", 4);
    check("no wheel resolves → no_prizes", "error" in r && r.error === "no_prizes");
    check("no wheel resolves → refunded once", refunds(rpcs).length === 1 && refunds(rpcs)[0].args.p_token === "tok" && refunds(rpcs)[0].args.p_prize_id === null);
  }
  {
    // The wheel id resolves (pass.wheel_id) but the wheel row is gone.
    const { sb, rpcs } = fakeClient(happyPath({ wheels: (ops) => (has(ops, "eq", "creator") ? ok([]) : ok(null)) }));
    const r = await completeClaimedSpin(sb, "tok", "cs", 4);
    check("wheel row missing → no_prizes", "error" in r && r.error === "no_prizes");
    check("wheel row missing → refunded once", refunds(rpcs).length === 1 && refunds(rpcs)[0].args.p_prize_id === null);
  }
  {
    // Something throws between the claim and the insert.
    const { sb, rpcs } = fakeClient(
      happyPath({
        happy_hours: () => {
          throw new Error("boom");
        },
      }),
    );
    const r = await completeClaimedSpin(sb, "tok", "cs", 4);
    check("thrown error after claim → db_error, not a 500", "error" in r && r.error === "db_error");
    check("thrown error after claim → refunded once", refunds(rpcs).length === 1 && refunds(rpcs)[0].args.p_prize_id === null);
  }
  {
    // Every prize sold out (only prize has stock 0): nothing can be won.
    const { sb, rpcs } = fakeClient(happyPath({ wheels: (ops) => (has(ops, "eq", "creator") ? ok([]) : ok(wheelRow(0))) }));
    const r = await completeClaimedSpin(sb, "tok", "cs", 4);
    check("sold out → no_prizes", "error" in r && r.error === "no_prizes");
    check("sold out → refunded once, nothing to restore", refunds(rpcs).length === 1 && refunds(rpcs)[0].args.p_prize_id === null);
  }
  {
    // A limited prize's stock was decremented, then the spins insert failed:
    // the refund must also restore that unit.
    const { sb, rpcs } = fakeClient(
      happyPath({
        wheels: (ops) => (has(ops, "eq", "creator") ? ok([]) : ok(wheelRow(3))),
        spins: () => fail("insert failed"),
      }),
    );
    const r = await completeClaimedSpin(sb, "tok", "cs", 4);
    check("insert failed → db_error", "error" in r && r.error === "db_error");
    check("insert failed → refunded once WITH the decremented prize", refunds(rpcs).length === 1 && refunds(rpcs)[0].args.p_prize_id === "prize-1");
  }
  {
    // A throw AFTER the limited stock was decremented (pity update explodes).
    let fansCalls = 0;
    const { sb, rpcs } = fakeClient(
      happyPath({
        wheels: (ops) => (has(ops, "eq", "creator") ? ok([]) : ok(wheelRow(3))),
        fans: (ops) => {
          fansCalls++;
          if (has(ops, "update")) throw new Error("boom");
          return ok({ pity_counter: 0 });
        },
      }),
    );
    const r = await completeClaimedSpin(sb, "tok", "cs", 4);
    check("throw after stock decrement → db_error", "error" in r && r.error === "db_error" && fansCalls >= 2);
    check("throw after stock decrement → refund restores the prize unit", refunds(rpcs).length === 1 && refunds(rpcs)[0].args.p_prize_id === "prize-1");
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
