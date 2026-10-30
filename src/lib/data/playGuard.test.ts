import assert from "node:assert";
import { LEGAL } from "@/lib/legal";
import { mock } from "node:test";

// AUTH-SENSITIVE (AGENTS.md rules 3/5 + the RM-6 negative tests): a fan's
// reminder and break are written through token-scoped server routes with the
// service client. These pin, on BOTH the mock path and the Supabase path:
//   - a break refuses spins (on_break) and can't be shortened;
//   - a token reaches only its own fan, and only while its link is live;
//   - the break end is computed on the server (the client sends a duration);
//   - the creator sees the break state but never the fan's reminder or counts;
//   - fans on a break drop out of win-back and the out-of-spins bell (F6).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// --- A recording Supabase client ------------------------------------------------
type Op = { name: string; args: unknown[] };
type Resp = { data: unknown; error: { message: string } | null; count?: number | null };
type Call = { table: string; ops: Op[] };
const calls: Call[] = [];
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let handler: (table: string, ops: Op[]) => Resp = () => ({ data: null, error: null });
let rpcHandler: (name: string, args: Record<string, unknown>) => Resp = () => ({ data: null, error: null });
const eqArg = (ops: Op[], col: string) => ops.find((o) => o.name === "eq" && o.args[0] === col)?.args[1];
const has = (ops: Op[], name: string, arg?: string) =>
  ops.some((o) => o.name === name && (arg === undefined || String(o.args[0]).includes(arg)));

function fakeClient() {
  const builder = (table: string) => {
    const call: Call = { table, ops: [] };
    calls.push(call);
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (res: (v: Resp) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve()
                .then(() => handler(table, call.ops))
                .then(res, rej);
          }
          return (...args: unknown[]) => {
            call.ops.push({ name: String(prop), args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  return {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpcHandler(name, args);
    },
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
  const { getNotifications } = await import("./notifications");

  // --- mock (demo) path -------------------------------------------------------
  useSupabase = false;
  {
    const fan = (name: string, spins = 30) => {
      const r = m.mockCreatePass(name, spins, undefined, undefined, 500);
      m.mockAckFan(r.token);
      return r;
    };
    const a = fan("Guard A");
    const b = fan("Guard B");

    // Counts + reminder.
    const set = await data.setPlayReminder(a.token, 20);
    check("mock: the fan sets a reminder of 20", "ok" in set && set.reminder === 20);
    let due = false;
    let last: unknown = null;
    for (let i = 0; i < 20; i++) {
      const r = await data.spin(a.token, "seed");
      assert.ok(!("error" in r), `mock: spin ${i + 1} succeeded (${JSON.stringify(r)})`);
      if (i < 19) due ||= r.reminderDue === true;
      last = r;
    }
    const lastSpin = last as { reminderDue?: boolean; play?: { today: number; week: number } };
    check("mock: reminderDue stays false below the number", !due);
    check("mock: the 20th spin of the day reports reminderDue", lastSpin.reminderDue === true);
    check("mock: the spin response carries today's count", lastSpin.play?.today === 20 && lastSpin.play?.week === 20);
    const pageA = await data.getFanPass(a.token);
    check("mock: the fan page shows the fan's own counts and reminder", pageA?.play?.today === 20 && pageA.play.reminder === 20);
    check("mock: no break yet", pageA?.play?.breakUntil === null);
    const off = await data.setPlayReminder(a.token, null);
    check("mock: the reminder can be turned off", "ok" in off && off.reminder === null);
    check("mock: off means no reminderDue", (await data.spin(a.token, "x") as { reminderDue?: boolean }).reminderDue === false);

    // Break: refuses spins, only lengthens, reaches only its own fan.
    const t = Date.now();
    const brk = await data.takeBreak(a.token, 7 * DAY);
    assert.ok("ok" in brk, "mock: break taken");
    const end = Date.parse(brk.breakUntil);
    check("mock: the break ends about 7 days out (server-computed)", Math.abs(end - (t + 7 * DAY)) < 5000);
    const spunOnBreak = await data.spin(a.token, "x");
    check("mock: a spin during the break is refused with on_break", "error" in spunOnBreak && spunOnBreak.error === "on_break");
    const shorter = await data.takeBreak(a.token, DAY);
    check("mock: asking for a shorter break keeps the longer one", "ok" in shorter && shorter.breakUntil === brk.breakUntil);
    const longer = await data.takeBreak(a.token, 30 * DAY);
    check("mock: a longer break lengthens it", "ok" in longer && Date.parse(longer.breakUntil) > end);
    check("mock: another fan is untouched and still spins", !("error" in (await data.spin(b.token, "x"))));
    check("mock: another fan's page shows no break", (await data.getFanPass(b.token))?.play?.breakUntil === null);
    check("mock: the fan page shows the break", (await data.getFanPass(a.token))?.play?.breakUntil === (longer as { breakUntil: string }).breakUntil);
    check("mock: an unknown token reaches nobody", "error" in (await data.takeBreak("nope-" + t, DAY)));
    check("mock: an unknown token can't set a reminder", "error" in (await data.setPlayReminder("nope-" + t, 20)));
    check("mock: a duration past the bound is refused", "error" in (await data.takeBreak(b.token, 400 * DAY)));
    const paused = fan("Guard Paused");
    m.mockSelfExclude(paused.token);
    const pausedRes = await data.takeBreak(paused.token, DAY);
    check("mock: a paused link is refused (blocked)", "error" in pausedRes && pausedRes.error === "blocked");

    // The creator's view: the break state only.
    const rows = await data.listFans();
    const rowA = rows.find((r) => r.fanId === a.fanId);
    const rowB = rows.find((r) => r.fanId === b.fanId);
    check("mock: the Fans list shows A on a break", typeof rowA?.breakUntil === "string");
    check("mock: the Fans list shows B not on a break", (rowB?.breakUntil ?? null) === null);
    const leaked = JSON.stringify([rows, await data.getFanDetail(a.fanId)]);
    check("mock: the creator never sees the reminder or the fan's counts", !/reminder|playReminder|spinTimes|"today"|"week"/i.test(leaked));
    check("mock: the fan drawer shows the break", typeof (await data.getFanDetail(a.fanId))?.breakUntil === "string");

    // F6: out of the win-back list and the out-of-spins bell.
    const drained = fan("Guard Drained", 1);
    await data.spin(drained.token, "x");
    await data.takeBreak(drained.token, DAY);
    const sources = m.mockGetNotificationSources();
    check("mock: a fan on a break is not in out-of-spins", !sources.outOfSpins.some((f) => f.fanId === drained.fanId));
    const feed = await getNotifications();
    check(
      "mock: nor in the bell's out-of-spins items",
      !(feed?.items ?? []).some((i) => i.kind === "out_of_spins" && JSON.stringify(i).includes("Guard Drained"))
    );
    // Control: the same fan without a break IS suggested (the filter is the break).
    const drained2 = fan("Guard Drained Two", 1);
    await data.spin(drained2.token, "x");
    check("mock: an out-of-spins fan not on a break is suggested", m.mockGetNotificationSources().outOfSpins.some((f) => f.fanId === drained2.fanId));
  }

  // --- Supabase path ----------------------------------------------------------
  useSupabase = true;
  {
    const FAN_A = "fan-a";
    const passes: Record<string, { fan_id: string; is_active: boolean; self_excluded_at: string | null; fan: { blocked_at: string | null } }> = {
      "tok-a": { fan_id: FAN_A, is_active: true, self_excluded_at: null, fan: { blocked_at: null } },
      "tok-inactive": { fan_id: "fan-i", is_active: false, self_excluded_at: null, fan: { blocked_at: null } },
      "tok-paused": { fan_id: "fan-p", is_active: false, self_excluded_at: "2026-01-01T00:00:00Z", fan: { blocked_at: null } },
      "tok-blocked": { fan_id: "fan-b", is_active: true, self_excluded_at: null, fan: { blocked_at: "2026-01-01T00:00:00Z" } },
    };
    let breakUntil: string | null = null;
    const reset = () => {
      calls.length = 0;
      rpcCalls.length = 0;
    };
    handler = (table, ops) => {
      if (table === "fan_passes") return { data: passes[String(eqArg(ops, "token"))] ?? null, error: null };
      if (table === "fans") return { data: { break_until: breakUntil, pity_counter: 0 }, error: null };
      if (table === "fan_play_reminders") return { data: has(ops, "select") ? { daily: 50 } : null, error: null };
      if (table === "spins") return { data: null, error: null, count: 7 };
      return { data: null, error: null };
    };
    rpcHandler = (name, args) =>
      name === "fan_take_break" ? { data: String(args.p_until), error: null } : { data: null, error: null };

    // takeBreak: the RPC is the only write, keyed by the token, end computed here.
    reset();
    const t = Date.now();
    const res = await data.takeBreak("tok-a", 7 * DAY);
    check("supabase: takeBreak succeeds for a live link", "ok" in res);
    const rpc = rpcCalls.find((c) => c.name === "fan_take_break");
    check("supabase: it calls fan_take_break once", rpcCalls.length === 1 && !!rpc);
    check("supabase: keyed by the link token only (no fan id from the client)", rpc?.args.p_token === "tok-a" && Object.keys(rpc.args).sort().join() === "p_token,p_until");
    check("supabase: the end is now + the duration, computed on the server", Math.abs(Date.parse(String(rpc?.args.p_until)) - (t + 7 * DAY)) < 5000);
    check("supabase: no direct write to fans.break_until", !calls.some((c) => c.table === "fans" && has(c.ops, "update")));

    for (const [tok, code] of [
      ["tok-unknown", "not_found"],
      ["tok-inactive", "not_found"],
      ["tok-paused", "blocked"],
      ["tok-blocked", "blocked"],
    ] as const) {
      reset();
      const r = await data.takeBreak(tok, DAY);
      check(`supabase: ${tok} is refused with ${code}`, "error" in r && r.error === code);
      check(`supabase: ${tok} reaches no RPC`, rpcCalls.length === 0);
      reset();
      const s = await data.setPlayReminder(tok, 20);
      check(`supabase: ${tok} can't set a reminder (${code})`, "error" in s && s.error === code);
      check(`supabase: ${tok} writes no reminder`, !calls.some((c) => c.table === "fan_play_reminders"));
    }
    reset();
    check("supabase: an out-of-bound duration is refused before any DB call", "error" in (await data.takeBreak("tok-a", 400 * DAY)) && calls.length === 0 && rpcCalls.length === 0);

    // setPlayReminder: writes the token's own fan, never a client-supplied id.
    reset();
    const rem = await data.setPlayReminder("tok-a", 50);
    check("supabase: the reminder is saved", "ok" in rem && rem.reminder === 50);
    const up = calls.find((c) => c.table === "fan_play_reminders" && has(c.ops, "upsert"));
    const row = up?.ops.find((o) => o.name === "upsert")?.args[0] as { fan_id?: string; daily?: number } | undefined;
    check("supabase: upserted for the token's fan", row?.fan_id === FAN_A && row.daily === 50);
    reset();
    await data.setPlayReminder("tok-a", null);
    const del = calls.find((c) => c.table === "fan_play_reminders" && has(c.ops, "delete"));
    check("supabase: Off deletes the token's fan's reminder", !!del && eqArg(del.ops, "fan_id") === FAN_A);

    // spin(): a refused claim during a break maps to on_break; otherwise no_spins.
    handler = (table, ops) => {
      if (table === "fan_passes") {
        if (has(ops, "select", "acked_at")) return { data: { fan_id: FAN_A, fan: { acked_at: "2026-01-01T00:00:00Z", acked_terms_version: LEGAL.version } }, error: null };
        return { data: { id: "p", is_active: true, self_excluded_at: null, fan: { blocked_at: null } }, error: null };
      }
      if (table === "fans") return { data: { break_until: breakUntil }, error: null };
      return { data: null, error: null };
    };
    rpcHandler = (name) => name === "prepare_spin_attempt"
      ? { data: { status: "declined", error: breakUntil && Date.parse(breakUntil) > Date.now() ? "on_break" : "no_spins" }, error: null }
      : { data: null, error: null }; // atomic preparation refuses before any spend
    breakUntil = new Date(Date.now() + DAY).toISOString();
    const onBreak = await data.spin("tok-a", "x");
    check("supabase: a refused claim during a break is on_break", "error" in onBreak && onBreak.error === "on_break");
    breakUntil = new Date(Date.now() - HOUR).toISOString();
    const ended = await data.spin("tok-a", "x");
    check("supabase: after the break a refused claim is no_spins again", "error" in ended && ended.error === "no_spins");
    breakUntil = null;
    const none = await data.spin("tok-a", "x");
    check("supabase: no break: no_spins", "error" in none && none.error === "no_spins");
  }

  console.log(`playGuard (data) test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
