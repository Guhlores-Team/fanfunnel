import assert from "node:assert";
import { LEGAL } from "@/lib/legal";
import { mock } from "node:test";
import type { PublicPrize, PublicStock, SpinResult, WheelConfig } from "@/lib/games/wheel/types";

// RM-2 negative + parity test: with a wheel's "Show stock to fans" switch OFF,
// no stock count reaches a fan — not on the fan page payload, not in the spin
// response (the won prize AND the live stock map), not from the unauthenticated
// GET /api/public/wheel/[creatorId], not on the link-in-bio teaser — on BOTH
// the mock (demo) path and the Supabase path. Only `soldOut` remains, because
// a sold-out prize has 0% odds. With the switch ON the counts are the exact,
// live values. Saving the switch persists only a real boolean.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

/** Round-trip through JSON, exactly what reaches the browser / API caller. */
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** Every numeric stock value anywhere in a payload (raw JSON, any nesting). */
const stockNumbers = (v: unknown): number[] =>
  JSON.stringify(v).match(/"stock":\s*-?\d+/g)?.map((m) => Number(m.split(":")[1])) ?? [];
const byLabel = (prizes: PublicPrize[], label: string) => prizes.find((p) => p.label === label);

// --- A scriptable Supabase client (same shape as fanPrizePrivacy.test.ts) -----
type Op = { name: string; args: unknown[] };
type Resp = { data: unknown; error: { message: string } | null };
const ok = (data: unknown): Resp => ({ data, error: null });
const has = (ops: Op[], name: string, arg?: string) =>
  ops.some((o) => o.name === name && (arg === undefined || String(o.args[0]).includes(arg)));

const CREATOR = "creator-1";
const WHEEL_ID = "wheel-1";
// One unlimited, one limited (3 left), one sold out. Only the limited prize is
// winnable by weight, so every Supabase spin takes a unit of it.
const PRIZE_ROWS = [
  { id: "pz-1", label: "Shoutout", description: null, rarity: "common", weight: 0, color: null, emoji: "📣", image_url: null, cost_cents: 5, stock: null, sort_order: 0 },
  { id: "pz-2", label: "Signed photo", description: null, rarity: "epic", weight: 10, color: null, emoji: "📸", image_url: null, cost_cents: 900, stock: 3, sort_order: 1 },
  { id: "pz-3", label: "Video call", description: null, rarity: "legendary", weight: 1, color: null, emoji: "📞", image_url: null, cost_cents: 9900, stock: 0, sort_order: 2 },
];
// The prizes table after the spin's decrement (what the live read returns).
const LIVE_ROWS = [
  { id: "pz-2", stock: 2 },
  { id: "pz-3", stock: 0 },
];
let showStockColumn: boolean | undefined = false;
let wheelUpdates: Record<string, unknown>[] = [];
const wheelRow = () => ({
  id: WHEEL_ID, title: "Live wheel", subtitle: null, brand_color: "#ec4899", label_color: null, label_size: null,
  ...(showStockColumn === undefined ? {} : { show_stock: showStockColumn }),
  is_active: true, active_from: null, active_until: null, archived_at: null, prizes: PRIZE_ROWS,
});
const PASS_ROW = {
  id: "pass-1", creator_id: CREATOR, campaign_id: null, wheel_id: WHEEL_ID, fan_id: "fan-1", is_active: true,
  spins_remaining: 3, next_server_seed: "f".repeat(64), next_server_seed_hash: "0".repeat(64),
  fan: { id: "fan-1", display_name: "Sam", handle: null, spins_remaining: 3, spins_granted_total: 3, referral_code: "ABC", acked_at: "2026-01-01T00:00:00Z", acked_terms_version: LEGAL.version, leaderboard_opt_in: false },
  creator: { display_name: "Creator", tip_url: null, leaderboard_enabled: false, creator_note: null, avatar_url: null },
};
const TABLES: Record<string, (ops: Op[]) => Resp> = {
  fan_passes: () => ok(PASS_ROW),
  wheels: (ops) => {
    const upd = ops.find((o) => o.name === "update");
    if (upd) {
      wheelUpdates.push(upd.args[0] as Record<string, unknown>);
      return ok({ id: WHEEL_ID });
    }
    if (has(ops, "select", "prizes(")) return ok(wheelRow());
    if (has(ops, "maybeSingle")) return ok({ id: WHEEL_ID });
    return ok([{ id: WHEEL_ID, is_active: true, active_from: null, active_until: null, created_at: "2026-01-01T00:00:00Z" }]);
  },
  prizes: (ops) => {
    if (has(ops, "update")) return ok({ id: "pz-2" }); // the CAS takes a unit
    if (has(ops, "select", "id, stock")) return ok(LIVE_ROWS);
    if (has(ops, "select", "*")) return ok(PRIZE_ROWS);
    if (has(ops, "delete") || has(ops, "insert")) return ok(null);
    return ok({ stock: 3 });
  },
  spins: (ops) => (has(ops, "insert") ? ok({ id: "spin-1", share_id: "share-1" }) : ok([])),
  wishlists: () => ok([]),
  happy_hours: () => ok([]),
  profiles: () => ok({ id: CREATOR, display_name: "Creator", public_tagline: null, tip_url: null, avatar_url: null }),
  fans: () => ok({ pity_counter: 0 }),
  redemptions: () => ok(null),
  webhooks: () => ok([]),
};
function fakeClient() {
  const builder = (table: string) => {
    const ops: Op[] = [];
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (res: (v: Resp) => unknown, rej: (e: unknown) => unknown) => {
              const h = TABLES[table];
              if (!h) return Promise.reject(new Error(`fake client: no handler for ${table}`)).then(res, rej);
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
  return {
    from: (table: string) => builder(table),
    rpc: async (name: string) => ok(name === "can_act_for" ? true : name === "get_fan_focus_state" ? {status:"ok",focus:null} : null),
    auth: { getUser: async () => ({ data: { user: { id: CREATOR } }, error: null }) },
  };
}

let useSupabase = false;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createClient: async () => fakeClient(),
    createServiceClient: () => fakeClient(),
  },
});

async function main() {
  const data = await import("./index");
  const { toWheelConfig } = await import("./shared");
  const { mockAckFan, mockCreatePass, mockGetWheel, mockSpin } = await import("./mock");
  const { GET: publicWheelGET } = await import("@/app/api/public/wheel/[creatorId]/route");

  async function publicWheel(creatorId: string) {
    const res = await publicWheelGET(new Request(`http://localhost/api/public/wheel/${creatorId}`), {
      params: Promise.resolve({ creatorId }),
    });
    return { status: res.status, body: (await res.json()) as { wheel: { prizes: PublicPrize[] } } };
  }

  /** Everything a fan or the public can read for this creator, as sent. */
  async function fanSurfaces(creatorId: string, spin: () => Promise<SpinResult | { error: string }>, passToken: string) {
    const pass = await data.getFanPass(passToken);
    assert.ok(pass, "fan pass view");
    const spun = await spin();
    assert.ok(!("error" in spun), `spin succeeded (${JSON.stringify(spun)})`);
    const teaser = await data.getPublicWheelTeaser(creatorId);
    assert.ok(teaser, "teaser");
    const api = await publicWheel(creatorId);
    assert.ok(api.status === 200, "public wheel API → 200");
    const bio = await data.getPublicProfileBySlug("some-slug");
    assert.ok(bio, "link-in-bio profile");
    return {
      page: wire(pass).wheel.prizes,
      spin: wire(spun as SpinResult),
      teaser: wire(teaser).wheel.prizes,
      api: api.body.wheel.prizes,
      bio: wire(bio).profile.prizes,
    };
  }

  // --- mock (demo) path -------------------------------------------------------
  useSupabase = false;
  {
    const base = await data.getWheel();
    assert.ok(base, "mock wheel");
    check("mock: a wheel shows stock by default", base.showStock !== false);
    // Stock 3 on the epic, sold out on the legendary, the rest unlimited.
    const limited: WheelConfig = {
      ...base,
      showStock: false,
      prizes: base.prizes.map((p) =>
        p.rarity === "epic" ? { ...p, stock: 3 } : p.rarity === "legendary" ? { ...p, stock: 0 } : { ...p, stock: null }
      ),
    };
    const saved = await data.saveWheel(limited);
    assert.ok("wheel" in saved, "mock: save with the switch off");
    check("mock: the creator's own wheel keeps the real counts", saved.wheel.prizes.some((p) => p.stock === 3));
    check("mock: the switch is saved off", (await data.getWheel())?.showStock === false);
    const epic = base.prizes.find((p) => p.rarity === "epic")!.label;
    const legendary = base.prizes.find((p) => p.rarity === "legendary")!.label;

    const { token } = mockCreatePass("Stock fan", 5);
    mockAckFan(token);
    const off = await fanSurfaces("demo-creator", () => data.spin(token, "stock-off"), token);
    for (const [where, v] of Object.entries(off)) {
      check(`mock OFF: no stock count in the ${where} payload (${stockNumbers(v).join()})`, stockNumbers(v).length === 0);
    }
    check("mock OFF: the won prize carries no stock key", !("stock" in off.spin.prize));
    check("mock OFF: the spin's live map lists only sold-out prizes", Object.values(off.spin.stock ?? {}).every((s) => s.soldOut === true && s.stock === undefined));
    check("mock OFF: the sold-out prize still reads sold out", byLabel(off.page, legendary)?.soldOut === true && byLabel(off.api, legendary)?.soldOut === true);
    check("mock OFF: the in-stock limited prize looks unlimited", byLabel(off.page, epic)?.soldOut === undefined && byLabel(off.page, epic)?.stock === undefined);

    // Saving without the field keeps the switch where it was.
    const { showStock: _drop, ...noField } = (await data.getWheel())!;
    assert.ok("wheel" in (await data.saveWheel(noField as WheelConfig)), "mock: save without showStock");
    check("mock: a save without the field keeps the switch off", (await data.getWheel())?.showStock === false);

    // Switch ON: exact live counts everywhere.
    assert.ok("wheel" in (await data.saveWheel({ ...(await data.getWheel())!, showStock: true })), "mock: switch on");
    const live = (await data.getWheel())!.prizes.find((p) => p.rarity === "epic")!.stock;
    const on = await fanSurfaces("demo-creator", () => data.spin(token, "stock-on"), token);
    const after = (await data.getWheel())!.prizes.find((p) => p.rarity === "epic")!;
    check("mock ON: the fan page shows the exact count", byLabel(on.page, epic)?.stock === live);
    check("mock ON: the public API shows the live count", byLabel(on.api, epic)?.stock === after.stock);
    check("mock ON: the link-in-bio teaser shows the live count", byLabel(on.bio as PublicPrize[], epic)?.stock === after.stock);
    const map = on.spin.stock as Record<string, PublicStock>;
    check("mock ON: the spin's live map has the count after the spin", map[after.id]?.stock === after.stock);
    check("mock ON: sold out = stock 0 + soldOut", byLabel(on.page, legendary)?.stock === 0 && byLabel(on.page, legendary)?.soldOut === true);

    // Displayed stock 1, two concurrent spins: exactly one fan wins it, and
    // both responses agree it is gone afterwards.
    const w = (await data.getWheel())!;
    assert.ok(
      "wheel" in (await data.saveWheel({
        ...w,
        prizes: w.prizes.map((p) => (p.rarity === "epic" ? { ...p, stock: 1, weight: 100 } : { ...p, stock: null, weight: 0 })),
      })),
      "mock: last-unit wheel"
    );
    const lastId = (await data.getWheel())!.prizes.find((p) => p.rarity === "epic")!.id;
    const fanA = mockCreatePass("Race A", 1);
    const fanB = mockCreatePass("Race B", 1);
    mockAckFan(fanA.token);
    mockAckFan(fanB.token);
    const both = await Promise.all([mockSpin(fanA.token, "a"), mockSpin(fanB.token, "b")]);
    const won = both.filter((r) => !("error" in r) && r.prize.id === lastId).length;
    check(`mock: displayed "1 left" + two concurrent spins → exactly one wins it (${won})`, won === 1);
    check("mock: the last unit is gone", (await data.getWheel())!.prizes.find((p) => p.id === lastId)!.stock === 0);
    check(
      "mock: the later response already shows it sold out",
      both.some((r) => !("error" in r) && r.stock?.[lastId]?.soldOut === true && r.stock?.[lastId]?.stock === 0)
    );
    // Put the demo wheel back.
    assert.ok("wheel" in (await data.saveWheel({ ...base, showStock: true })), "mock: restore");
    check("mock: restored", mockGetWheel().prizes.length === base.prizes.length);
  }

  // --- Supabase path ----------------------------------------------------------
  useSupabase = true;
  {
    showStockColumn = false;
    const cfg = toWheelConfig(wheelRow() as unknown as Parameters<typeof toWheelConfig>[0]);
    check("supabase: show_stock=false maps to showStock false", cfg.showStock === false);
    check("supabase: the creator still sees the real counts", cfg.prizes.map((p) => p.stock).join() === ",3,0");
    showStockColumn = undefined;
    check(
      "supabase: a row without the column reads as the default (on)",
      toWheelConfig(wheelRow() as unknown as Parameters<typeof toWheelConfig>[0]).showStock === true
    );

    const spinOnce = () =>
      data.completeClaimedSpin(
        fakeClient() as unknown as Parameters<typeof data.completeClaimedSpin>[0],
        "tok-1",
        "stock",
        2,
      );

    showStockColumn = false;
    const off = await fanSurfaces(CREATOR, spinOnce, "tok-1");
    for (const [where, v] of Object.entries(off)) {
      check(`supabase OFF: no stock count in the ${where} payload (${stockNumbers(v).join()})`, stockNumbers(v).length === 0);
    }
    check("supabase OFF: the won prize carries no stock key", off.spin.prize.label === "Signed photo" && !("stock" in off.spin.prize));
    check("supabase OFF: live map = only the sold-out prize", JSON.stringify(off.spin.stock) === '{"pz-3":{"soldOut":true}}');
    check("supabase OFF: sold out still reads sold out", byLabel(off.page, "Video call")?.soldOut === true);

    showStockColumn = true;
    const on = await fanSurfaces(CREATOR, spinOnce, "tok-1");
    check("supabase ON: the fan page shows the exact count", byLabel(on.page, "Signed photo")?.stock === 3);
    check("supabase ON: the public API shows it too", byLabel(on.api, "Signed photo")?.stock === 3);
    check("supabase ON: the link-in-bio teaser shows it too", byLabel(on.bio as PublicPrize[], "Signed photo")?.stock === 3);
    check("supabase ON: the spin's live map is the post-spin read", JSON.stringify(on.spin.stock) === '{"pz-2":{"stock":2},"pz-3":{"stock":0,"soldOut":true}}');
    check("supabase ON: no cost anywhere", !/cost/i.test(JSON.stringify(on)));

    // Saving: only a real boolean reaches the column.
    wheelUpdates = [];
    const base = toWheelConfig(wheelRow() as unknown as Parameters<typeof toWheelConfig>[0]);
    await data.saveWheel({ ...base, showStock: false });
    check("supabase save: showStock false → show_stock false", wheelUpdates[0]?.show_stock === false);
    wheelUpdates = [];
    const { showStock: _drop, ...noField } = base;
    await data.saveWheel(noField as WheelConfig);
    check("supabase save: no field → column untouched", wheelUpdates.length === 1 && !("show_stock" in wheelUpdates[0]));
    wheelUpdates = [];
    await data.saveWheel({ ...base, showStock: "off" as unknown as boolean });
    check("supabase save: a non-boolean never reaches the column", wheelUpdates.length === 1 && !("show_stock" in wheelUpdates[0]));
  }

  console.log(`fanStockPrivacy.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
