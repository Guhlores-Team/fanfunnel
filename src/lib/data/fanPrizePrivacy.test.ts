import assert from "node:assert";
import { LEGAL } from "@/lib/legal";
import { mock } from "node:test";
import type { WheelConfig } from "@/lib/games/wheel/types";

// Regression: a prize's fulfilment cost is creator-private (it feeds the Prize
// ROI analytics), but toWheelConfig copied `cost_cents` into every prize and
// that config went straight to the fan's browser (getFanPass), the spin
// response (spin) and the UNAUTHENTICATED GET /api/public/wheel/[creatorId]
// (getPublicWheelTeaser). Every fan- and public-facing prize must now carry
// only the fan-safe fields, on BOTH the mock path and the Supabase path, while
// the creator's own wheel keeps its costs.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// Fields a fan or the public may see on a prize / wheel. Anything else (cost,
// lifecycle/scheduling) is creator-private.
// soldOut (RM-2) is fan-safe: a sold-out prize has 0% odds, and no count rides on it.
const PRIZE_KEYS = new Set(["id", "label", "description", "rarity", "weight", "color", "emoji", "imageUrl", "stock", "soldOut"]);
const WHEEL_KEYS = new Set(["id", "title", "subtitle", "brandColor", "labelColor", "labelSize", "prizes"]);

/** Every key path in `value` whose name mentions cost (cost, cost_cents, costCents …). */
function costPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => costPaths(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(/cost/i.test(k) ? [`${path}.${k}`] : []),
      ...costPaths(v, `${path}.${k}`),
    ]);
  }
  return [];
}

/** Round-trip through JSON, exactly what reaches the browser / API caller. */
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function assertFanSafeWheel(label: string, wheel: { prizes: object[] } & object) {
  check(`${label}: no cost field anywhere (${costPaths(wheel).join(", ")})`, costPaths(wheel).length === 0);
  const extraWheel = Object.keys(wheel).filter((k) => !WHEEL_KEYS.has(k));
  check(`${label}: wheel carries only fan-safe keys (extra: ${extraWheel.join(", ")})`, extraWheel.length === 0);
  const extraPrize = wheel.prizes.flatMap((p) => Object.keys(p).filter((k) => !PRIZE_KEYS.has(k)));
  check(`${label}: prizes carry only fan-safe keys (extra: ${extraPrize.join(", ")})`, extraPrize.length === 0);
  check(`${label}: prizes still render (label + rarity kept)`, wheel.prizes.length >= 2 &&
    wheel.prizes.every((p) => typeof (p as { label?: unknown }).label === "string" && typeof (p as { rarity?: unknown }).rarity === "string"));
}

// --- A scriptable Supabase client (same shape as spinStock.test.ts) -----------
type Op = { name: string; args: unknown[] };
type Resp = { data: unknown; error: { message: string } | null };
const ok = (data: unknown): Resp => ({ data, error: null });
const has = (ops: Op[], name: string, arg?: string) =>
  ops.some((o) => o.name === name && (arg === undefined || String(o.args[0]).includes(arg)));

const CREATOR = "creator-1";
const WHEEL_ID = "wheel-1";
const PRIZE_ROWS = [
  { id: "pz-1", label: "Shoutout", description: null, rarity: "common", weight: 60, color: null, emoji: "📣", image_url: null, cost_cents: 0, stock: null, sort_order: 0 },
  { id: "pz-2", label: "Signed photo", description: "Real ink", rarity: "rare", weight: 30, color: "#3b82f6", emoji: "🖼️", image_url: null, cost_cents: 1234, stock: null, sort_order: 1 },
  { id: "pz-3", label: "Video call", description: null, rarity: "legendary", weight: 10, color: null, emoji: "📞", image_url: null, cost_cents: 9900, stock: null, sort_order: 2 },
];
const WHEEL_ROW = {
  id: WHEEL_ID, title: "Live wheel", subtitle: null, brand_color: "#ec4899", label_color: null, label_size: null,
  is_active: true, active_from: null, active_until: null, archived_at: null, prizes: PRIZE_ROWS,
};
const PASS_ROW = {
  id: "pass-1", creator_id: CREATOR, campaign_id: null, wheel_id: WHEEL_ID, fan_id: "fan-1", is_active: true,
  spins_remaining: 3, next_server_seed: "f".repeat(64), next_server_seed_hash: "0".repeat(64),
  fan: { id: "fan-1", display_name: "Sam", handle: null, spins_remaining: 3, spins_granted_total: 3, referral_code: "ABC", acked_at: "2026-01-01T00:00:00Z", acked_terms_version: LEGAL.version, leaderboard_opt_in: false },
  creator: { display_name: "Creator", tip_url: null, leaderboard_enabled: false, creator_note: null, avatar_url: null },
};
const TABLES: Record<string, (ops: Op[]) => Resp> = {
  fan_passes: () => ok(PASS_ROW),
  wheels: (ops) =>
    has(ops, "select", "prizes(")
      ? ok(WHEEL_ROW)
      : ok([{ id: WHEEL_ID, is_active: true, active_from: null, active_until: null, created_at: "2026-01-01T00:00:00Z" }]),
  spins: (ops) => (has(ops, "insert") ? ok({ id: "spin-1", share_id: "share-1" }) : ok([])),
  wishlists: () => ok([]),
  happy_hours: () => ok([]),
  profiles: () => ok({ display_name: "Creator" }),
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
    rpc: async (name: string) => ok(name === "can_act_for" ? true : null),
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
  const { mockAckFan, mockCreatePass } = await import("./mock");
  const { GET: publicWheelGET } = await import("@/app/api/public/wheel/[creatorId]/route");

  async function publicWheel(creatorId: string) {
    const res = await publicWheelGET(new Request(`http://localhost/api/public/wheel/${creatorId}`), {
      params: Promise.resolve({ creatorId }),
    });
    return { status: res.status, body: (await res.json()) as { wheel: WheelConfig } };
  }

  // --- mock (demo) path -------------------------------------------------------
  useSupabase = false;
  {
    const base = await data.getWheel();
    assert.ok(base, "mock wheel");
    const costed: WheelConfig = { ...base, prizes: base.prizes.map((p, i) => ({ ...p, cost: 100 * (i + 1) })) };
    const saved = await data.saveWheel(costed);
    assert.ok("wheel" in saved, "mock: saving a wheel with costs");

    const creatorView = await data.getWheel();
    check("mock: the creator's own wheel keeps its costs (Prize ROI)", !!creatorView && creatorView.prizes.every((p) => typeof p.cost === "number" && p.cost > 0));

    const { token } = mockCreatePass("Privacy fan", 3);
    mockAckFan(token);
    const pass = await data.getFanPass(token);
    assert.ok(pass, "mock: fan pass view");
    assertFanSafeWheel("mock fan page payload", wire(pass).wheel);

    const spun = await data.spin(token, "privacy");
    assert.ok(!("error" in spun), "mock: spin succeeded");
    const prize = wire(spun).prize;
    check("mock spin response: no cost on the won prize", costPaths(prize).length === 0);
    check("mock spin response: only fan-safe prize keys", Object.keys(prize).every((k) => PRIZE_KEYS.has(k)));

    const teaser = await data.getPublicWheelTeaser("demo-creator");
    assert.ok(teaser, "mock: teaser");
    assertFanSafeWheel("mock public teaser", wire(teaser).wheel);

    const api = await publicWheel("demo-creator");
    check("mock GET /api/public/wheel → 200", api.status === 200);
    check("mock GET /api/public/wheel: no cost field in the body", costPaths(api.body).length === 0);
    assertFanSafeWheel("mock GET /api/public/wheel", api.body.wheel);
  }

  // --- Supabase path ----------------------------------------------------------
  useSupabase = true;
  {
    const creatorView = toWheelConfig(WHEEL_ROW as unknown as Parameters<typeof toWheelConfig>[0]);
    check("supabase: the creator's wheel mapping keeps cost_cents as cost", creatorView.prizes.map((p) => p.cost).join() === "0,1234,9900");

    const pass = await data.getFanPass("tok-1");
    assert.ok(pass, "supabase: fan pass view");
    assertFanSafeWheel("supabase fan page payload", wire(pass).wheel);

    const spun = await data.completeClaimedSpin(
      fakeClient() as unknown as Parameters<typeof data.completeClaimedSpin>[0],
      "tok-1",
      "privacy",
      2,
    );
    assert.ok(!("error" in spun), `supabase: spin succeeded (${JSON.stringify(spun)})`);
    const prize = wire(spun).prize;
    check("supabase spin response: no cost on the won prize", costPaths(prize).length === 0);
    check("supabase spin response: only fan-safe prize keys", Object.keys(prize).every((k) => PRIZE_KEYS.has(k)));

    const teaser = await data.getPublicWheelTeaser(CREATOR);
    assert.ok(teaser, "supabase: teaser");
    assertFanSafeWheel("supabase public teaser", wire(teaser).wheel);

    const api = await publicWheel(CREATOR);
    check("supabase GET /api/public/wheel → 200", api.status === 200);
    check("supabase GET /api/public/wheel: no cost field in the body", costPaths(api.body).length === 0);
    assertFanSafeWheel("supabase GET /api/public/wheel", api.body.wheel);
  }

  console.log(`fanPrizePrivacy.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
