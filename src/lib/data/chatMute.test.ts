import assert from "node:assert/strict";
import { mock } from "node:test";

// TS-17 / TS-07 on the Supabase path (a scripted stand-in for the client):
//   - setFanChatMute resolves the live link first and then asks
//     set_fan_chat_mute; `unavailable` and `not_found` answer not_found (the
//     acknowledgement's answer), a dead link never reaches the RPC;
//   - sendCreatorMessage maps the database's 42501 "muted" refusal to
//     { error: "muted" } (any other refusal stays db_error), and the route
//     answers 409 muted;
//   - ensureChatIntro / sendChatOutro skip a muted fan silently (no error, no
//     row), also when the mute lands between their read and their insert;
//   - nothing pushes anything to anyone for a refused creator message;
//   - the fan's thread carries fromTeam, computed on the server, and never
//     actor_id or creator_id.

type Stmt = { table: string; op: string; columns?: string; filters: [string, unknown][]; payload?: unknown; rpc?: string; args?: unknown };
type Answer = { data?: unknown; error?: { code?: string; message?: string } | null; count?: number | null };
let statements: Stmt[] = [];
let answer: (s: Stmt) => Answer = () => ({ data: null });
const pushes: unknown[] = [];

function builder(table: string) {
  const stmt: Stmt = { table, op: "select", filters: [] };
  const run = () => {
    statements.push(stmt);
    const a = answer(stmt);
    return { data: a.data ?? null, error: a.error ?? null, count: a.count ?? null };
  };
  const b = {
    select(columns: string) { if (stmt.op === "select") stmt.columns = columns; return b; },
    insert(payload: unknown) { stmt.op = "insert"; stmt.payload = payload; return b; },
    update(payload: unknown) { stmt.op = "update"; stmt.payload = payload; return b; },
    eq(col: string, value: unknown) { stmt.filters.push([col, value]); return b; },
    is(col: string, value: unknown) { stmt.filters.push([col, value]); return b; },
    lt(col: string, value: unknown) { stmt.filters.push([col, value]); return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle: async () => run(),
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) { return Promise.resolve(run()).then(resolve, reject); },
  };
  return b;
}
const client = {
  from: (table: string) => builder(table),
  rpc: async (name: string, args: unknown) => {
    const stmt: Stmt = { table: "", op: "rpc", filters: [], rpc: name, args };
    statements.push(stmt);
    const a = answer(stmt);
    return { data: a.data ?? null, error: a.error ?? null };
  },
  auth: { getUser: async () => ({ data: { user: { id: "creator-1" } } }) },
};

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createServiceClient: () => client,
    createClient: async () => client,
  },
});
mock.module("./wheels", { namedExports: { resolveWheelId: async () => "wheel-1", resolveActiveWheelId: async () => "wheel-1", getActiveHappyHour: async () => null } });
mock.module("./seatScope", { namedExports: {
  resolveActingCreator: async (_sb: unknown, userId: string) => ({ creatorId: userId }),
  demoActingCreator: () => null,
} });
mock.module("@/lib/push/notify", { namedExports: { notifyCreator: async (...args: unknown[]) => { pushes.push(args); return {}; } } });
mock.module("@/lib/afterResponse", { namedExports: { runAfterResponse: (fn: () => unknown) => { void fn(); } } });

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

const LIVE_CREATOR = { is_active: true, approval_status: "approved", role: "creator" };
function passRow(over: { muted?: boolean; active?: boolean; blocked?: boolean; creator?: unknown } = {}) {
  return {
    creator_id: "creator-1", campaign_id: null, wheel_id: "wheel-1", pinned_wheel_id: null, fan_id: "fan-1",
    is_active: over.active ?? true, expires_at: null,
    fan: { blocked_at: over.blocked ? "2026-11-01T00:00:00Z" : null, acked_at: "2026-11-01T00:00:00Z", acked_terms_version: "2026-11-11", chat_muted_at: over.muted ? "2026-11-02T00:00:00Z" : null },
    creator: over.creator === undefined ? LIVE_CREATOR : over.creator,
  };
}
const inserts = () => statements.filter((s) => s.op === "insert" && s.table === "messages");
const rpcs = (name: string) => statements.filter((s) => s.rpc === name);

async function main() {
  const fans = await import("./fans");
  const inbox = await import("./inbox");
  const legal = await import("@/lib/legal");
  const creatorRoute = await import("@/app/api/messages/creator/route");

  // --- setFanChatMute ---------------------------------------------------------------
  const muteWith = async (pass: unknown, rpc: Answer) => {
    statements = [];
    answer = (s) => (s.table === "fan_passes" ? { data: pass } : s.rpc === "set_fan_chat_mute" ? rpc : { data: null });
    return fans.setFanChatMute("tok-live", true);
  };
  const ok = await muteWith(passRow(), { data: { status: "ok", muted: true } });
  check("a live link is muted", "ok" in ok && ok.muted === true);
  check("the RPC gets the posted token and the boolean, nothing else", JSON.stringify(rpcs("set_fan_chat_mute")[0]?.args) === JSON.stringify({ p_token: "tok-live", p_muted: true }));
  check("the live-link read pins the token and an active link", statements[0].table === "fan_passes" && statements[0].filters.some(([c, v]) => c === "token" && v === "tok-live") && statements[0].filters.some(([c, v]) => c === "is_active" && v === true));
  statements = [];
  answer = (s) => (s.table === "fan_passes" ? { data: passRow({ muted: true }) } : s.rpc === "set_fan_chat_mute" ? { data: { status: "ok", muted: false } } : { data: null });
  const un = await fans.setFanChatMute("tok-live", false);
  check("unmute answers muted: false", "ok" in un && un.muted === false && JSON.stringify(rpcs("set_fan_chat_mute")[0]?.args) === JSON.stringify({ p_token: "tok-live", p_muted: false }));
  for (const [label, pass] of [
    ["an unknown token", null],
    ["a switched-off link", passRow({ active: false })],
    ["a suspended creator's link", passRow({ creator: { is_active: false, approval_status: "approved", role: "creator" } })],
  ] as const) {
    const r = await muteWith(pass, { data: { status: "ok", muted: true } });
    check(`${label} is not_found and never reaches the RPC`, "error" in r && r.error === "not_found" && rpcs("set_fan_chat_mute").length === 0);
  }
  const unavailable = await muteWith(passRow(), { data: { status: "unavailable" } });
  check("unavailable (paused, blocked, expired between the reads) answers not_found", "error" in unavailable && unavailable.error === "not_found");
  const gone = await muteWith(passRow(), { data: { status: "not_found" } });
  check("the RPC's not_found answers not_found", "error" in gone && gone.error === "not_found");
  const broke = await muteWith(passRow(), { error: { code: "XX000", message: "boom" } });
  check("an RPC error is db_error", "error" in broke && broke.error === "db_error");

  // --- sendCreatorMessage -------------------------------------------------------------
  const sendWith = async (insertError: Answer["error"]) => {
    statements = [];
    answer = (s) => (s.table === "fans" && s.op === "select" ? { data: { id: "fan-1" } } : s.table === "messages" && s.op === "insert" ? { error: insertError } : { data: null });
    return inbox.sendCreatorMessage("fan-1", "hello");
  };
  check("a plain send is ok", "ok" in (await sendWith(null)));
  const refused = await sendWith({ code: "42501", message: "muted" });
  check("the database's 42501 muted refusal maps to { error: 'muted' }", "error" in refused && refused.error === "muted");
  const other = await sendWith({ code: "42501", message: "message references another creator" });
  check("any other 42501 stays db_error", "error" in other && other.error === "db_error");
  check("isMutedRefusal reads code and message, nothing else", inbox.isMutedRefusal({ code: "42501", message: "muted" }) && !inbox.isMutedRefusal({ code: "23505", message: "muted" }) && !inbox.isMutedRefusal(null));
  statements = [];
  answer = (s) => (s.table === "fans" && s.op === "select" ? { data: { id: "fan-1" } } : s.table === "messages" && s.op === "insert" ? { error: { code: "42501", message: "muted" } } : { data: null });
  const res = await creatorRoute.POST(new Request("http://localhost/api/messages/creator", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "192.0.2.77" }, body: JSON.stringify({ fanId: "fan-1", body: "hello" }) }));
  check("the creator route answers 409 muted", res.status === 409 && ((await res.json()) as { error?: string }).error === "muted");
  check("nothing is pushed for a refused creator message", pushes.length === 0);

  // --- auto intro / outro skip a muted fan -------------------------------------------
  const auto = async (fn: (t: string) => Promise<unknown>, muted: boolean, insertError: Answer["error"] = null) => {
    statements = [];
    answer = (s) => {
      if (s.table === "fan_passes") return { data: passRow({ muted }) };
      if (s.table === "profiles") return { data: { chat_intro: "Welcome!", chat_outro: "Out of spins!" } };
      if (s.table === "messages" && s.op === "insert") return { error: insertError };
      if (s.table === "messages") return { data: null, count: 0 };
      return { data: null };
    };
    return fn("tok-live");
  };
  for (const [name, fn] of [["intro", inbox.ensureChatIntro], ["outro", inbox.sendChatOutro]] as const) {
    const sent = await auto(fn, false);
    check(`${name}: a fan who did not mute gets it`, "ok" in (sent as object) && inserts().length === 1);
    const skipped = await auto(fn, true);
    check(`${name}: a muted fan is skipped silently, no row attempted`, "ok" in (skipped as object) && inserts().length === 0);
    const raced = await auto(fn, false, { code: "42501", message: "muted" });
    check(`${name}: muted between the read and the insert is still a silent skip`, "ok" in (raced as object) && !("error" in (raced as object)));
  }
  check("no push for any of it", pushes.length === 0);

  // --- TS-07: fromTeam, computed on the server ----------------------------------------
  const base = { id: "m", body: "b", created_at: "2026-11-10T00:00:00Z", read_at: null, creator_id: "creator-1" };
  check("a creator reply written by a team member is fromTeam", inbox.toChatMessage({ ...base, sender: "creator", actor_id: "seat-9" }).fromTeam === true);
  check("the creator's own reply is not", inbox.toChatMessage({ ...base, sender: "creator", actor_id: "creator-1" }).fromTeam === false);
  check("an older reply with no actor is not", inbox.toChatMessage({ ...base, sender: "creator", actor_id: null }).fromTeam === false);
  check("a fan message is never fromTeam", inbox.toChatMessage({ ...base, sender: "fan", actor_id: "seat-9" }).fromTeam === false);

  statements = [];
  answer = (s) => {
    if (s.table === "fan_passes") return { data: { creator_id: "creator-1", fan_id: "fan-1", is_active: true, expires_at: null, fan: { blocked_at: null, acked_at: "2026-11-01T00:00:00Z", acked_terms_version: legal.LEGAL.version } } };
    if (s.table === "messages" && s.op === "select") return { data: [
      { ...base, id: "m1", sender: "fan", actor_id: null },
      { ...base, id: "m2", sender: "creator", actor_id: "creator-1", read_at: "2026-11-10T00:00:01Z" },
      { ...base, id: "m3", sender: "creator", actor_id: "seat-staff-0042", read_at: "2026-11-10T00:00:01Z" },
    ] };
    return { data: null };
  };
  const thread = await inbox.getFanMessages("tok-live");
  assert.ok(Array.isArray(thread));
  check("the fan's read selects actor_id and creator_id on the server", statements.some((s) => s.table === "messages" && /actor_id/.test(s.columns ?? "") && /creator_id/.test(s.columns ?? "")));
  check("fromTeam marks only the team member's reply", thread.map((m) => m.fromTeam).join() === "false,false,true");
  const wire = JSON.stringify(thread);
  check("the fan's payload carries no actor_id, creator_id or staff id", !/actor_id|creator_id|actorId|creatorId/.test(wire) && !wire.includes("seat-staff-0042") && !wire.includes("creator-1"));

  console.log(`chatMute (supabase path): ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
