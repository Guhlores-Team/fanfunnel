import assert from "node:assert";
import { mock } from "node:test";

// A3 (spend safety, F6): Autopilot's "Check in with your top spenders" and
// "{fan} is out of spins … nudge them to grab more" cards come from the CRM's
// whales. A blocked fan, a fan who paused their link and a fan on a break must
// never be a whale, however much they spent. Both paths: the demo store's CRM,
// and the Supabase CRM + the real getAutopilot card builder.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const DAY = 86_400_000;
let TABLES: Record<string, unknown> = {};
function fakeClient() {
  const builder = (table: string) => {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            // Tables this test doesn't seed read as empty.
            // listFans reads each table in exact-count id pages (readPages.ts);
            // the whole seeded table is one complete page.
            const rows = (TABLES[table] ?? []) as unknown[];
            return (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null, count: rows.length }).then(res);
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  };
  return {
    from: (table: string) => builder(table),
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async () => ({ data: { user: { id: "creator-1" } }, error: null }) },
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
  const m = await import("./mock");

  // --- demo path ---------------------------------------------------------------
  {
    const spender = (name: string, cents: number) => {
      const r = m.mockCreatePass(name, 1, undefined, undefined, cents);
      m.mockAckFan(r.token);
      return r;
    };
    const ok = spender("A3 Eligible", 100);
    const blocked = spender("A3 Blocked", 90_000);
    const paused = spender("A3 Paused", 80_000);
    const resting = spender("A3 Resting", 70_000);
    await data.setFanBlocked(blocked.fanId, true);
    m.mockSelfExclude(paused.token);
    m.mockTakeBreak(resting.token, 30 * DAY);

    const crm = await data.getCreatorCrm();
    const ids = new Set(crm.whales.map((w) => w.fanId));
    check("demo: an eligible spender is a whale", ids.has(ok.fanId));
    check("demo: a blocked top spender is not a whale", !ids.has(blocked.fanId));
    check("demo: a paused top spender is not a whale", !ids.has(paused.fanId));
    check("demo: an on-break top spender is not a whale", !ids.has(resting.fanId));

    await data.setFanBlocked(blocked.fanId, false);
    check("demo: unblocking makes them a whale again", (await data.getCreatorCrm()).whales.some((w) => w.fanId === blocked.fanId));
  }

  // --- Supabase path: CRM and the Autopilot cards built from it ------------------
  useSupabase = true;
  {
    const t = (d: number) => new Date(Date.now() - d * DAY).toISOString();
    // One row per table, keyed by fan_id, as listFans reads them (ids ascending).
    const passRows: Record<string, unknown>[] = [];
    const pass = (fanId: string, token: string, over: Record<string, unknown> = {}) =>
      passRows.push({
        id: `p${passRows.length}`, fan_id: fanId, token, created_at: t(30), spins_remaining: 0, wheel_id: "w1",
        campaign_id: null, wheel: { title: "W" }, campaign: null, is_active: true, self_excluded_at: null, ...over,
      });
    const fans: Record<string, unknown>[] = [];
    const spins: Record<string, unknown>[] = [];
    const grants: Record<string, unknown>[] = [];
    const fan = (id: string, cents: number, over: Record<string, unknown> = {}, ownPass = true) => {
      fans.push({
        id, display_name: id, handle: null, spins_remaining: 0, spins_granted_total: 3, tags: [], created_at: t(60),
        blocked_at: null, break_until: null, ...over,
      });
      if (ownPass) pass(id, `${id}-link`);
      spins.push({ id: `s${spins.length}`, fan_id: id, prize_label: "Shoutout", prize_rarity: "common", created_at: t(1) });
      grants.push({ id: `g${grants.length}`, fan_id: id, amount_cents: cents, campaign_id: null, campaign: null });
    };
    fan("eligible", 500);
    fan("whale-blocked", 90_000, { blocked_at: t(2) });
    fan("whale-paused", 80_000, {}, false);
    pass("whale-paused", "whale-paused-link", { is_active: false, self_excluded_at: t(3) });
    fan("whale-resting", 70_000, { break_until: new Date(Date.now() + 5 * DAY).toISOString() });
    TABLES = { fans, fan_passes: passRows, spins, grants, fan_outreach: [] };
    const crm = await data.getCreatorCrm();
    check("supabase: only the eligible spender is a whale", crm.whales.map((w) => w.fanId).join(",") === "eligible");

    const cards = await data.getAutopilot();
    const whales = cards.find((c) => c.key === "dm_whales");
    check("supabase: the top-spenders card exists for the eligible fan", !!whales && whales.body.includes("eligible"));
    for (const gated of ["whale-blocked", "whale-paused", "whale-resting"]) {
      check(`supabase: the top-spenders card never names ${gated}`, !whales?.body.includes(gated) && !whales?.title.includes(gated));
      check(`supabase: no out-of-spins card for ${gated}`, !cards.some((c) => c.key === `out_of_spins_${gated}`));
      check(`supabase: no card links ${gated}`, !JSON.stringify(cards).includes(`${gated}-link`));
    }
    check("supabase: the eligible dry whale still gets its out-of-spins card", cards.some((c) => c.key === "out_of_spins_eligible"));
  }

  console.log(`autopilotEngagement.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
