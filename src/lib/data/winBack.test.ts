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

    // RM-5: contacting or snoozing takes a fan off the list; "came back" is derived.
    const inList = async (days: number, fanId: string) =>
      (await later(days, () => data.getCreatorCrm())).dormant.some((f) => f.fanId === fanId);
    check("mock: a dormant row carries the last win for {lastWin}", !!again.dormant.find((f) => f.fanId === active.fanId)?.lastWin);
    check("mock: an unknown fan can't be logged", "error" in (await data.recordOutreach({ fanId: "no-such-fan", action: "contacted" })));
    check("mock: contacting a fan is logged", "ok" in (await later(20, () => data.recordOutreach({ fanId: active.fanId, action: "contacted" }))));
    check("mock: a contacted fan leaves the win-back list", !(await inList(20, active.fanId)));
    check("mock: …and stays off for the whole cooldown (13 days on)", !(await inList(33, active.fanId)));
    check("mock: …and comes back after the cooldown (15 days on)", await inList(35, active.fanId));
    const stats = (await later(21, () => data.getCreatorCrm())).winback;
    check("mock: the contact counts as contacted, not yet came back", stats.contacted === 1 && stats.cameBack === 0);
    check("mock: recent contacts list the fan", stats.recent[0]?.fanId === active.fanId && stats.recent[0]?.cameBack === false);

    check("mock: snoozing a fan is logged", "ok" in (await later(20, () => data.recordOutreach({ fanId: blocked.fanId, action: "snoozed" }))));
    check("mock: a snoozed fan leaves the win-back list", !(await inList(20, blocked.fanId)));
    check("mock: …for the whole snooze (29 days on)", !(await inList(49, blocked.fanId)));
    check("mock: …and returns once it ends (31 days on)", await inList(51, blocked.fanId));
    check("mock: a snooze is not a contact", (await later(21, () => data.getCreatorCrm())).winback.contacted === 1);

    // A contacted fan who plays again came back. (Real time here: mockSpin
    // stamps wins with `new Date()`, which the Date.now shift doesn't move.)
    const ret = spender("WB Return");
    await m.mockSpin(ret.token);
    await data.recordOutreach({ fanId: ret.fanId, action: "contacted" });
    let after = await data.getCreatorCrm();
    check("mock: a contact before any new spin is not came back", after.winback.recent.find((r) => r.fanId === ret.fanId)?.cameBack === false);
    await new Promise((r) => setTimeout(r, 5));
    check("mock: the contacted fan spins again", !("error" in (await m.mockSpin(ret.token))));
    after = await data.getCreatorCrm();
    check("mock: a fan who spun after the contact counts as came back", after.winback.cameBack === 1);
    check("mock: …and their recent row says so", after.winback.recent.find((r) => r.fanId === ret.fanId)?.cameBack === true);
    check("mock: …and they are not on the list", !after.dormant.some((f) => f.fanId === ret.fanId));

    // Deleting a fan drops their log (the table cascades).
    check("mock: both contacts count 22 days on", (await later(22, () => data.getCreatorCrm())).winback.contacted === 2);
    await data.deleteFan(active.fanId);
    const gone = (await later(22, () => data.getCreatorCrm())).winback;
    check("mock: a deleted fan's contacts are gone", gone.contacted === 1 && !gone.recent.some((r) => r.fanId === active.fanId));
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
        // RM-5 outreach states.
        fan("contacted-recently", [pass("cr-1", 40)]),
        fan("contacted-long-ago", [pass("cl-1", 40)]),
        fan("snoozed", [pass("sn-1", 40)]),
        fan("snooze-over", [pass("so-1", 40)]),
        fan("returned", [pass("re-1", 40)], {
          spins: [{ prize_label: "Selfie", prize_rarity: "common", created_at: t(2) }],
        }),
      ],
      fan_outreach: [
        { fan_id: "contacted-recently", contacted_at: t(3), snoozed_until: null },
        { fan_id: "contacted-long-ago", contacted_at: t(15), snoozed_until: null },
        { fan_id: "snoozed", contacted_at: null, snoozed_until: new Date(realNow() + 5 * DAY).toISOString() },
        { fan_id: "snooze-over", contacted_at: null, snoozed_until: t(1) },
        { fan_id: "returned", contacted_at: t(10), snoozed_until: null },
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

    // RM-5: the outreach log.
    check("supabase: a fan contacted 3 days ago is not in win-back", !dormant.has("contacted-recently"));
    check("supabase: a fan contacted 15 days ago is back in win-back", dormant.has("contacted-long-ago"));
    check("supabase: a snoozed fan is not in win-back", !dormant.has("snoozed"));
    check("supabase: a fan whose snooze ended is back", dormant.has("snooze-over"));
    check("supabase: a fan who played after the contact is not quiet", !dormant.has("returned"));
    check(
      "supabase: 3 fans contacted in the window, 1 came back",
      crm.winback.contacted === 3 && crm.winback.cameBack === 1,
    );
    check(
      "supabase: recent contacts are newest first with their status",
      crm.winback.recent.map((r) => `${r.fanId}:${r.cameBack}`).join(",") ===
        "contacted-recently:false,returned:true,contacted-long-ago:false",
    );

    // Fail closed: if the log can't be read, nobody is suggested (the contact
    // cooldown can't be checked), but the rest of the CRM still loads.
    delete TABLES.fan_outreach;
    const blind = await data.getCreatorCrm();
    check("supabase: an unreadable outreach log empties the win-back list", blind.dormant.length === 0);
    check("supabase: …while whales still load", blind.whales.length > 0);
  }

  console.log(`winBack.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
