import assert from "node:assert";
import { mock } from "node:test";

// Regression (spend safety): the Analytics win-back list (getCreatorCrm's
// `dormant`) suggested messaging fans who had been BLOCKED by the creator or
// had PAUSED (self-excluded) their own link, because listFans never read
// fans.blocked_at or fan_passes.self_excluded_at / is_active. Its "Copy link"
// also used the fan's newest link even when that link was paused. Now:
//   - blocked and self-excluded fans never appear in win-back;
//   - the offered link is the fan's newest ACTIVE link, never a paused one;
//   - a fan with no active link is skipped;
//   - a fan on a break (RM-6) is skipped until it ends;
// and no CRM row (whales included) ever carries a paused link. Both paths.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const DAY = 86_400_000;
const CREATOR = "creator-1";

// --- A scriptable Supabase client: `from(table)` resolves to TABLES[table] ---
type Resp = { data: unknown; error: { message: string } | null };
let TABLES: Record<string, unknown> = {};
function fakeClient() {
  const builder = (table: string) => {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (res: (v: Resp) => unknown, rej: (e: unknown) => unknown) =>
              table in TABLES
                ? Promise.resolve({ data: TABLES[table], error: null }).then(res, rej)
                : Promise.reject(new Error(`fake client: no rows for ${table}`)).then(res, rej);
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  };
  return {
    from: (table: string) => builder(table),
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

const realNow = Date.now;
/** Run `fn` as if it were `days` days from now (wins recorded now look quiet). */
async function later<T>(days: number, fn: () => Promise<T>): Promise<T> {
  const base = realNow();
  Date.now = () => base + days * DAY;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

async function main() {
  const data = await import("./index");
  const m = await import("./mock");

  // --- mock (demo) path -------------------------------------------------------
  useSupabase = false;
  {
    // A spender who won once: dormant once 20 days pass.
    const spender = (name: string) => {
      const r = m.mockCreatePass(name, 3, undefined, undefined, 500);
      m.mockAckFan(r.token);
      return r;
    };
    const active = spender("WB Active");
    await m.mockSpin(active.token);
    // A second, newer link for the same fan on another wheel.
    const { wheel: other } = m.mockDuplicateWheel(m.mockGetWheel().id);
    const newer = m.mockCreatePass("WB Active", 1, active.fanId, undefined, undefined, undefined, undefined, undefined, other.id);

    const blocked = spender("WB Blocked");
    await m.mockSpin(blocked.token);
    const blockRes = await data.setFanBlocked(blocked.fanId, true);
    check("mock: blocking a fan succeeds", "ok" in blockRes);
    check("mock: a blocked fan can't spin (parity with claim_spin)", "error" in (await m.mockSpin(blocked.token)));

    const paused = spender("WB Paused");
    await m.mockSpin(paused.token);
    m.mockSelfExclude(paused.token);

    // RM-6: a fan on a break (30 days, so still in force 20 days on).
    const resting = spender("WB Resting");
    await m.mockSpin(resting.token);
    m.mockTakeBreak(resting.token, 30 * DAY);

    const crm = await later(20, () => data.getCreatorCrm());
    const dormant = new Map(crm.dormant.map((f) => [f.fanId, f]));
    check("mock: an ordinary quiet spender is in win-back", dormant.has(active.fanId));
    check("mock: a fan on a break is not in win-back (F6)", !dormant.has(resting.fanId));
    check("mock: no CRM row offers an on-break fan's link", !crm.whales.some((f) => f.fanId === resting.fanId && f.primaryToken !== null));
    check("mock: win-back offers the fan's newest active link", dormant.get(active.fanId)?.primaryToken === newer.token);
    check("mock: a blocked fan is not in win-back", !dormant.has(blocked.fanId));
    check("mock: a fan who paused their link is not in win-back", !dormant.has(paused.fanId));
    const whaleTokens = new Map(crm.whales.map((f) => [f.fanId, f.primaryToken]));
    check("mock: no CRM row offers a blocked fan's link", (whaleTokens.get(blocked.fanId) ?? null) === null);
    check("mock: no CRM row offers a paused link", (whaleTokens.get(paused.fanId) ?? null) === null);

    // Unblocking puts the fan back.
    await data.setFanBlocked(blocked.fanId, false);
    const again = await later(20, () => data.getCreatorCrm());
    check("mock: an unblocked quiet spender returns to win-back", again.dormant.some((f) => f.fanId === blocked.fanId));
  }

  // --- Supabase path ----------------------------------------------------------
  useSupabase = true;
  {
    const old = new Date(realNow() - 20 * DAY).toISOString();
    const t = (d: number) => new Date(realNow() - d * DAY).toISOString();
    const pass = (token: string, ageDays: number, over: Record<string, unknown> = {}) => ({
      token, created_at: t(ageDays), spins_remaining: 0, wheel_id: "w1", wheel: { title: "W" }, campaign: null,
      is_active: true, self_excluded_at: null, ...over,
    });
    const fan = (id: string, passes: unknown[], over: Record<string, unknown> = {}) => ({
      id, display_name: id, handle: null, spins_remaining: 0, spins_granted_total: 3, tags: [], created_at: t(60),
      blocked_at: null, fan_passes: passes,
      spins: [{ prize_label: "Shoutout", prize_rarity: "common", created_at: old }],
      grants: [{ amount_cents: 500, campaign_id: null, campaign: null }],
      ...over,
    });
    TABLES = {
      fans: [
        fan("ok", [pass("ok-old", 40), pass("ok-new", 30)]),
        fan("blocked", [pass("bl-1", 40)], { blocked_at: t(5) }),
        // Paused their newest link; an older link is still technically active.
        fan("paused", [pass("pa-old", 40), pass("pa-new", 30, { is_active: false, self_excluded_at: t(10) })]),
        // Newest link deactivated (not by the fan): fall back to the older active one.
        fan("inactive-newest", [pass("in-old", 40), pass("in-new", 30, { is_active: false })]),
        fan("no-active", [pass("na-1", 40, { is_active: false })]),
        // RM-6: on a break (in force) and one whose break has ended.
        fan("on-break", [pass("ob-1", 40)], { break_until: new Date(realNow() + 5 * DAY).toISOString() }),
        fan("break-over", [pass("bo-1", 40)], { break_until: t(1) }),
      ],
    };
    const crm = await data.getCreatorCrm();
    const dormant = new Map(crm.dormant.map((f) => [f.fanId, f]));
    check("supabase: an ordinary quiet spender is in win-back", dormant.has("ok"));
    check("supabase: win-back offers the newest active link", dormant.get("ok")?.primaryToken === "ok-new");
    check("supabase: a blocked fan is not in win-back", !dormant.has("blocked"));
    check("supabase: a fan who paused a link is not in win-back", !dormant.has("paused"));
    check(
      "supabase: a paused/inactive newest link is skipped for the newest active one",
      dormant.get("inactive-newest")?.primaryToken === "in-old",
    );
    check("supabase: a fan with no active link is skipped", !dormant.has("no-active"));
    check("supabase: a fan on a break is not in win-back (F6)", !dormant.has("on-break"));
    check("supabase: once the break is over the fan is back", dormant.has("break-over"));
    const offered = [...crm.whales, ...crm.dormant].map((f) => f.primaryToken);
    for (const bad of ["bl-1", "pa-old", "pa-new", "in-new", "na-1", "ob-1"]) {
      check(`supabase: no CRM row offers ${bad}`, !offered.includes(bad));
    }
  }

  console.log(`winBack.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
