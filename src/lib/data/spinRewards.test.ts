import assert from "node:assert";
import { randomBytes } from "node:crypto";
import { completeClaimedSpin } from "./index";
import { sealReward } from "@/lib/rewards/crypto";

// #26 instant-delivery prizes on the Supabase spin path (recordClaimedSpin),
// against a scriptable fake that models migration 0057's guarantees:
//   * reserve_reward_code hands each unused code to one spin id, atomically;
//   * the spins INSERT refuses a code prize without a code reserved for it
//     (trg_attach_spin_reward), and release_reward_code refuses once the spin
//     row exists.
// What is proven here is the TS side: the spin takes its code as its stock
// unit, an out-of-codes / undeliverable prize is never awarded (it is
// excluded and re-drawn like sold-out stock), a failed spin gives its code
// back, a delivered win is fulfilled + carries the value for the winner only,
// and concurrent spins never share a code. The same race against real
// Postgres row locks is in scripts/db/schema-drift-check.mjs.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// A throwaway key for this process only (never a real key, never committed).
process.env.REWARD_ENCRYPTION_KEY = randomBytes(32).toString("base64");
delete process.env.REWARD_ENCRYPTION_KEY_VERSION;

const CREATOR = "creator-1";
type Op = { name: string; args: unknown[] };
type Resp = { data: unknown; error: { message: string; code?: string } | null };
const ok = (data: unknown): Resp => ({ data, error: null });
const has = (ops: Op[], name: string, arg?: string) =>
  ops.some((o) => o.name === name && (arg === undefined || String(o.args[0]).includes(arg)));
const eqArg = (ops: Op[], col: string) => ops.find((o) => o.name === "eq" && o.args[0] === col)?.args[1];

type PrizeSpec = { id: string; weight: number; stock: number | null; delivery?: "manual" | "link" | "text" | "codes" };

function world(specs: PrizeSpec[], opts: { codes?: Record<string, string[]>; links?: Record<string, string>; failSpinInsert?: boolean; reserveError?: boolean } = {}) {
  const stock = new Map(specs.map((p) => [p.id, p.stock]));
  const codes = new Map<string, { id: string; prizeId: string; sealed: ReturnType<typeof sealReward>; spinId: string | null }>();
  let n = 0;
  for (const [prizeId, list] of Object.entries(opts.codes ?? {})) {
    for (const value of list) codes.set(`code-${++n}`, { id: `code-${n}`, prizeId, sealed: sealReward(value, CREATOR), spinId: null });
    stock.set(prizeId, list.length);
  }
  const links = new Map(Object.entries(opts.links ?? {}).map(([id, v]) => [id, sealReward(v, CREATOR)]));
  const plainOf = new Map<string, string>(); // code id -> value, for assertions
  for (const [prizeId, list] of Object.entries(opts.codes ?? {})) {
    let i = 0;
    for (const c of codes.values()) if (c.prizeId === prizeId) plainOf.set(c.id, list[i++]);
  }
  const spinRows: { id: string; prize_id: string }[] = [];
  const redemptions: Record<string, unknown>[] = [];
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const free = (prizeId: string) => [...codes.values()].filter((c) => c.prizeId === prizeId && c.spinId === null);
  const delivery = (id: string) => specs.find((p) => p.id === id)?.delivery ?? "manual";

  const handlers: Record<string, (ops: Op[], payload?: unknown) => Resp> = {
    fan_passes: (ops) =>
      has(ops, "update")
        ? ok({ id: "pass-1" })
        : ok({ id: "pass-1", creator_id: CREATOR, campaign_id: null, wheel_id: "wheel-1", fan_id: "fan-1", next_server_seed: "f".repeat(64), next_server_seed_hash: "0".repeat(64) }),
    campaigns: () => ok(null),
    wheels: (ops) =>
      has(ops, "eq", "creator") ? ok([]) : ok({
        id: "wheel-1", title: "W", subtitle: null, brand_color: null, label_color: null, label_size: null,
        show_stock: true, is_active: true, active_from: null, active_until: null, archived_at: null,
        prizes: specs.map((p, i) => ({
          id: p.id, label: p.id, description: null, rarity: "common", weight: p.weight, color: null, emoji: null,
          image_url: null, cost_cents: null, stock: stock.get(p.id) ?? null, sort_order: i, delivery: delivery(p.id),
        })),
      }),
    fans: () => ok({ pity_counter: 0 }),
    happy_hours: () => ok([]),
    prizes: (ops) => {
      const id = eqArg(ops, "id") as string;
      const upd = ops.find((o) => o.name === "update");
      if (upd) {
        if (delivery(id) === "codes") throw new Error("the stock CAS must never run on a code prize");
        const want = eqArg(ops, "stock");
        if (want !== stock.get(id)) return ok(null);
        stock.set(id, (upd.args[0] as { stock: number }).stock);
        return ok({ id });
      }
      if (id) return ok({ id, stock: stock.get(id) ?? null });
      return ok(specs.map((p) => ({ id: p.id, stock: stock.get(p.id) ?? null })));
    },
    prize_rewards: (ops) => {
      const id = eqArg(ops, "prize_id") as string;
      const s = links.get(id);
      return ok(s ? { kind: delivery(id), cipher: s.cipher, iv: s.iv, key_version: s.keyVersion } : null);
    },
    spins: (ops) => {
      const ins = ops.find((o) => o.name === "insert")?.args[0] as { id: string; prize_id: string } | undefined;
      if (!ins) return ok([]);
      if (opts.failSpinInsert) return { data: null, error: { message: "insert failed" } };
      // trg_attach_spin_reward
      if (delivery(ins.prize_id) === "codes" && ![...codes.values()].some((c) => c.spinId === ins.id)) {
        return { data: null, error: { message: "no reward code reserved for this spin", code: "23514" } };
      }
      spinRows.push({ id: ins.id, prize_id: ins.prize_id });
      return ok({ id: ins.id, share_id: `share-${spinRows.length}` });
    },
    redemptions: (ops) => {
      redemptions.push(ops.find((o) => o.name === "insert")?.args[0] as Record<string, unknown>);
      return ok(null);
    },
  };

  const builder = (table: string) => {
    const ops: Op[] = [];
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (res: (v: Resp) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve()
                .then(() => {
                  const h = handlers[table];
                  if (!h) throw new Error(`fake: no handler for ${table}`);
                  return h(ops);
                })
                .then(res, rej);
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
    from: (t: string) => builder(t),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      // An await before the body, so concurrent spins really interleave here.
      await Promise.resolve();
      if (name === "reserve_reward_code") {
        if (opts.reserveError) return { data: null, error: { message: "connection reset" } };
        const prizeId = args.p_prize as string;
        const code = free(prizeId)[0];
        if (!code) return ok([]);
        code.spinId = args.p_spin as string;
        stock.set(prizeId, free(prizeId).length);
        return ok([{ code_id: code.id, code_cipher: code.sealed.cipher, code_iv: code.sealed.iv, code_key_version: code.sealed.keyVersion }]);
      }
      if (name === "release_reward_code") {
        const spinId = args.p_spin as string;
        if (spinRows.some((s) => s.id === spinId)) return ok(false);
        const code = [...codes.values()].find((c) => c.spinId === spinId);
        if (!code) return ok(false);
        code.spinId = null;
        stock.set(code.prizeId, free(code.prizeId).length);
        return ok(true);
      }
      return ok(null);
    },
  };
  return {
    sb: client as unknown as Parameters<typeof completeClaimedSpin>[0],
    rpcs,
    stock,
    codes,
    plainOf,
    spinRows,
    redemptions,
  };
}

const releases = (rpcs: { name: string }[]) => rpcs.filter((r) => r.name === "release_reward_code").length;
const refunds = (rpcs: { name: string }[]) => rpcs.filter((r) => r.name === "rollback_claimed_spin").length;

async function main() {
  {
    // 20 concurrent spins on a 5-code prize, nothing else on the wheel.
    const w = world([{ id: "codes", weight: 1, stock: null, delivery: "codes" }], { codes: { codes: ["AAAA-1111", "BBBB-2222", "CCCC-3333", "DDDD-4444", "EEEE-5555"] } });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => completeClaimedSpin(w.sb, "tok", `cs-${i}`, 20 - i)));
    const wins = results.filter((r) => !("error" in r));
    const values = wins.map((r) => ("error" in r ? "" : r.reward?.value ?? ""));
    check(`20 spins on 5 codes: exactly 5 win (got ${wins.length})`, wins.length === 5);
    check("each winner got a distinct code", new Set(values).size === 5 && values.every((v) => /^[A-E]{4}-\d{4}$/.test(v)));
    check("every winner's response carries kind 'code'", wins.every((r) => !("error" in r) && r.reward?.kind === "code"));
    check("the 15 others are told the wheel sold out", results.filter((r) => "error" in r && r.error === "no_prizes").length === 15);
    check("the 15 others are refunded", refunds(w.rpcs) === 15);
    check("stock (= unused codes) ends at 0", w.stock.get("codes") === 0);
    check("5 spin rows, each with its own code", w.spinRows.length === 5 && new Set([...w.codes.values()].map((c) => c.spinId)).size === 5);
    check("delivered wins are fulfilled, not pending", w.redemptions.length === 5 && w.redemptions.every((r) => r.status === "fulfilled" && typeof r.fulfilled_at === "string"));
    check("the prize object sent to the fan carries no reward field", wins.every((r) => !("error" in r) && !/cipher|delivery|reward/i.test(JSON.stringify(r.prize))));
  }
  {
    // Out of codes behaves like sold-out stock: the spin re-draws onto the
    // manual prize instead of awarding a code it can't deliver.
    const w = world(
      [
        { id: "codes", weight: 1000, stock: null, delivery: "codes" },
        { id: "plain", weight: 1, stock: null },
      ],
      { codes: { codes: ["ONLY-0001"] } },
    );
    const a = await completeClaimedSpin(w.sb, "tok", "a", 3);
    const b = await completeClaimedSpin(w.sb, "tok", "b", 2);
    check("first spin wins the last code", !("error" in a) && a.prize.id === "codes" && a.reward?.value === "ONLY-0001");
    check("with no code left the prize is never awarded", !("error" in b) && b.prize.id === "plain" && b.reward === undefined);
    check("the manual win stays pending for the creator", w.redemptions[1]?.status === "pending");
  }
  {
    // The spin row can't be recorded after the code was reserved: the spin
    // fails, is refunded, and the code goes back to the pool.
    const w = world([{ id: "codes", weight: 1, stock: null, delivery: "codes" }], { codes: { codes: ["KEEP-0001"] }, failSpinInsert: true });
    const r = await completeClaimedSpin(w.sb, "tok", "cs", 1);
    check("insert failure → db_error", "error" in r && r.error === "db_error");
    check("insert failure → refunded and the code released", refunds(w.rpcs) === 1 && releases(w.rpcs) === 1);
    check("insert failure → the code is unused again (stock 1)", w.stock.get("codes") === 1 && [...w.codes.values()][0].spinId === null);
    check("insert failure → the rollback never touches a code prize's stock", w.rpcs.find((x) => x.name === "rollback_claimed_spin")?.args.p_prize_id === null);
  }
  {
    // The reservation call errors (it may or may not have committed).
    const w = world([{ id: "codes", weight: 1, stock: null, delivery: "codes" }], { codes: { codes: ["X-1"] }, reserveError: true });
    const r = await completeClaimedSpin(w.sb, "tok", "cs", 1);
    check("unknown reservation outcome → db_error, refunded, release attempted", "error" in r && r.error === "db_error" && refunds(w.rpcs) === 1 && releases(w.rpcs) === 1);
  }
  {
    // A link prize delivers its link; one whose reward is missing is never awarded.
    const w = world(
      [
        { id: "vip", weight: 1000, stock: null, delivery: "link" },
        { id: "plain", weight: 1, stock: null },
      ],
      { links: { vip: "https://example.com/vip" } },
    );
    const r = await completeClaimedSpin(w.sb, "tok", "cs", 1);
    check("link prize: the winner gets the link", !("error" in r) && r.reward?.kind === "link" && r.reward.value === "https://example.com/vip");
    check("link prize: fulfilled automatically", w.redemptions[0]?.status === "fulfilled");
    const broken = world([
      { id: "vip", weight: 1000, stock: null, delivery: "link" },
      { id: "plain", weight: 1, stock: null },
    ]);
    const b = await completeClaimedSpin(broken.sb, "tok", "cs", 1);
    check("link prize without a reward: re-drawn, never awarded", !("error" in b) && b.prize.id === "plain" && b.reward === undefined);
  }
  {
    // A limited link prize still takes its stock unit through the CAS.
    const w = world([{ id: "vip", weight: 1, stock: 2, delivery: "text" }], { links: { vip: "Your password is swordfish" } });
    const r = await completeClaimedSpin(w.sb, "tok", "cs", 1);
    check("limited text prize: delivered and one unit taken", !("error" in r) && r.reward?.value === "Your password is swordfish" && w.stock.get("vip") === 1);
  }
  {
    // Without the key nothing instant can be delivered: excluded like sold out.
    const saved = process.env.REWARD_ENCRYPTION_KEY;
    const w = world(
      [
        { id: "codes", weight: 1000, stock: null, delivery: "codes" },
        { id: "plain", weight: 1, stock: null },
      ],
      { codes: { codes: ["NOKEY-001"] } },
    );
    delete process.env.REWARD_ENCRYPTION_KEY;
    const r = await completeClaimedSpin(w.sb, "tok", "cs", 1);
    process.env.REWARD_ENCRYPTION_KEY = saved;
    check("no key: the code prize is not awarded", !("error" in r) && r.prize.id === "plain");
    check("no key: the reserved code went back to the pool", w.stock.get("codes") === 1 && releases(w.rpcs) === 1);
  }

  console.log(`spinRewards.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
