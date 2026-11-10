import assert from "node:assert/strict";
import { mock } from "node:test";

// PA-03: the Fans list is one bounded server page at a time. With
// creator_fan_summaries (0073) the page is one RPC call; before that it is a
// keyset page of fans plus capped reads of only those fans' spins and
// grants — never a 503 for the size of the account. The CRM's complete read
// keeps its bound.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

type Call = { table: string; ops: { name: string; args: unknown[] }[] };
let calls: Call[] = [];
let rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let TABLES: Record<string, unknown[]> = {};
let rpcAnswer: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown } = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
let useSupabase = true;

function fakeClient() {
  const from = (table: string) => {
    const call: Call = { table, ops: [] };
    calls.push(call);
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          const head = call.ops.some((o) => o.name === "select" && (o.args[1] as { head?: boolean } | undefined)?.head);
          const rows = TABLES[table] ?? [];
          const limitOp = call.ops.find((o) => o.name === "limit");
          const limit = limitOp ? Number(limitOp.args[0]) : rows.length;
          const inOp = call.ops.find((o) => o.name === "in");
          const gtOp = call.ops.find((o) => o.name === "gt");
          let scoped = inOp ? rows.filter((r) => (inOp.args[1] as string[]).includes((r as Record<string, string>)[inOp.args[0] as string])) : rows;
          if (gtOp) scoped = scoped.filter((r) => String((r as Record<string, string>)[gtOp.args[0] as string]) > String(gtOp.args[1]));
          const data = head ? null : scoped.slice(0, limit);
          return (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null, count: scoped.length }).then(res);
        }
        return (...args: unknown[]) => { call.ops.push({ name: String(prop), args }); return proxy; };
      },
    });
    return proxy;
  };
  return {
    from,
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "creator_link_tokens") return { data: (TABLES.fan_passes ?? []).map((p) => ({ pass_id: (p as { id: string }).id, token: `tok-${(p as { id: string }).id}` })), error: null };
      return rpcAnswer(name, args);
    },
    auth: { getUser: async () => ({ data: { user: { id: "creator-1" } }, error: null }) },
  };
}
mock.module("@/lib/supabase/server", {
  namedExports: { isSupabaseConfigured: () => useSupabase, createClient: async () => fakeClient(), createServiceClient: () => fakeClient() },
});

async function main() {
  const { listFansPage, listFans, encodeFanCursor, decodeFanCursor, fanPageLimit } = await import("./fans");
  const { GET } = await import("../../app/api/fans/route");

  check("page size defaults to 50 and clamps to 1..200", fanPageLimit(undefined) === 50 && fanPageLimit(0) === 1 && fanPageLimit(999) === 200 && fanPageLimit(7.9) === 7);
  const cursor = encodeFanCursor({ createdAt: "2026-11-01T00:00:00.000Z", fanId: "11111111-1111-4111-8111-111111111111" });
  check("a cursor round-trips", decodeFanCursor(cursor)?.fanId === "11111111-1111-4111-8111-111111111111");
  check("a tampered cursor is refused", decodeFanCursor("2026-11-01T00:00:00Z|../etc") === null && decodeFanCursor("nope") === null);

  // --- 0073 path: one RPC call per page ---------------------------------------
  const fanRow = (i: number) => ({
    fan_id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, display_name: `Fan ${i}`, handle: null, spins_remaining: i, spins_granted_total: 3, tags: ["vip"],
    created_at: `2026-11-0${(i % 9) + 1}T00:00:00.000Z`, blocked_at: null, break_until: null, total_spent_cents: String(i * 100), campaign_names: ["Launch"],
    last_win_label: i % 2 ? "Shoutout" : null, last_win_rarity: i % 2 ? "common" : null, last_win_at: i % 2 ? "2026-11-05T00:00:00.000Z" : null, total_fans: 1234,
  });
  TABLES = { fan_passes: [{ id: "p1", fan_id: fanRow(1).fan_id, created_at: "2026-11-01T00:00:00Z", spins_remaining: 1, wheel_id: "w1", campaign_id: null, is_active: true, self_excluded_at: null, wheel: { title: "Wheel" }, campaign: null }] };
  rpcAnswer = (name) => (name === "creator_fan_summaries" ? { data: [fanRow(1), fanRow(2)], error: null } : { data: null, error: { code: "PGRST202", message: "no" } });
  calls = []; rpcCalls = [];
  let page = await listFansPage({ query: "  fan ", limit: 2 });
  const rpc = rpcCalls.find((c) => c.name === "creator_fan_summaries");
  check("the RPC gets the trimmed query and the clamped limit", rpc?.args.p_query === "fan" && rpc.args.p_limit === 2 && rpc.args.p_before_id === null);
  check("rows map to the list shape (tips, last win, campaign names, tags)", page.fans.length === 2 && page.fans[0].totalSpent === 100 && page.fans[0].lastWin?.label === "Shoutout" && page.fans[1].lastWin === null && page.fans[0].campaignNames[0] === "Launch" && page.fans[0].tags[0] === "vip");
  check("links come from fan_passes of only the page's fans", page.fans[0].links.length === 1 && page.fans[0].primaryToken === "tok-p1" && page.fans[1].links.length === 0 && calls.some((c) => c.table === "fan_passes" && c.ops.some((o) => o.name === "in" && (o.args[1] as string[]).length === 2)));
  check("total and the next cursor come back", page.total === 1234 && page.nextCursor === encodeFanCursor({ createdAt: fanRow(2).created_at, fanId: fanRow(2).fan_id }));
  check("the RPC path never pages spins or grants", !calls.some((c) => c.table === "spins" || c.table === "grants"));
  rpcCalls = [];
  page = await listFansPage({ cursor: page.nextCursor, limit: 2 });
  const next = rpcCalls.find((c) => c.name === "creator_fan_summaries");
  check("the next page passes the cursor to the RPC", next?.args.p_before_created === fanRow(2).created_at && next.args.p_before_id === fanRow(2).fan_id);
  rpcAnswer = (name) => (name === "creator_fan_summaries" ? { data: [fanRow(3)], error: null } : { data: null, error: { code: "PGRST202", message: "no" } });
  page = await listFansPage({ limit: 2 });
  check("a short page is the last one", page.nextCursor === null);

  // --- pre-0073 fallback: a bounded page, never a refusal ----------------------
  rpcAnswer = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.creator_fan_summaries" } });
  const dbFan = (i: number) => ({ id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, display_name: `Fan ${i}`, handle: null, spins_remaining: 0, spins_granted_total: 3, tags: [], created_at: "2026-11-01T00:00:00.000Z", blocked_at: null, break_until: null });
  TABLES = {
    fans: [dbFan(1), dbFan(2), dbFan(3)],
    fan_passes: [],
    spins: Array.from({ length: 6000 }, (_, i) => ({ id: `s${String(i).padStart(5, "0")}`, fan_id: dbFan(1).id, prize_label: `Win ${i}`, prize_rarity: "common", created_at: "2026-11-02T00:00:00Z" })),
    grants: [{ id: "g1", fan_id: dbFan(2).id, amount_cents: 250, campaign_id: "c1", campaign: { name: "Launch" } }, { id: "g2", fan_id: dbFan(2).id, amount_cents: 250, campaign_id: "c1", campaign: { name: "Launch" } }],
  };
  calls = [];
  page = await listFansPage({ query: 'O\'Brien, 100% "x"', limit: 2 });
  const fansCall = calls.find((c) => c.table === "fans" && c.ops.some((o) => o.name === "limit"));
  const orOp = fansCall?.ops.find((o) => o.name === "or");
  check("the fallback reads one keyset page of fans, newest first", fansCall?.ops.some((o) => o.name === "limit" && o.args[0] === 2) && fansCall.ops.some((o) => o.name === "order" && o.args[0] === "created_at" && (o.args[1] as { ascending: boolean }).ascending === false));
  check("the search is a quoted ilike with wildcards escaped", typeof orOp?.args[0] === "string" && (orOp.args[0] as string).includes('display_name.ilike."*O\'Brien, 100\\% x*",handle.ilike."*O\'Brien, 100\\% x*"'));
  check("spins and grants are read for the page's fans only, capped", calls.some((c) => c.table === "spins" && c.ops.some((o) => o.name === "in") && c.ops.some((o) => o.name === "limit" && o.args[0] === 5000)) && calls.some((c) => c.table === "grants" && c.ops.some((o) => o.name === "in")));
  check("the page totals are grouped per fan", page.fans[1].totalSpent === 500 && page.fans[1].campaignNames.join() === "Launch" && page.fans[0].lastWin?.label === "Win 0");
  check("a capped detail read marks the page approximate instead of refusing", page.approximate === true && page.total === 3 && page.nextCursor !== null);
  TABLES.spins = TABLES.spins.slice(0, 10);
  page = await listFansPage({ limit: 3 });
  check("below the caps the page is exact", page.approximate === undefined && page.fans.length === 3);
  const bad = await listFansPage({ cursor: "garbage" });
  check("a bad cursor is an empty page, not a crash", bad.fans.length === 0 && bad.nextCursor === null);

  // --- the CRM's complete read keeps its bound (no RPC → legacy paged read) ---
  calls = [];
  const all = await listFans();
  check("listFans falls back to the complete read without the RPC", all.length === 3 && calls.some((c) => c.table === "fans" && c.ops.some((o) => o.name === "lte" && o.args[0] === "created_at")));
  rpcAnswer = (name) => (name === "creator_fan_summaries" ? { data: [fanRow(1)], error: null } : { data: null, error: { code: "PGRST202", message: "no" } });
  calls = [];
  const viaRpc = await listFans();
  check("listFans pages the RPC when it exists", viaRpc.length === 1 && !calls.some((c) => c.table === "spins"));

  // --- the route ---------------------------------------------------------------
  const res = await GET(new Request("http://localhost/api/fans?limit=abc"));
  check("a non-integer limit is a 400", res.status === 400);
  const long = await GET(new Request(`http://localhost/api/fans?q=${"a".repeat(81)}`));
  check("an over-long query is a 400", long.status === 400);
  const ok = await GET(new Request("http://localhost/api/fans?q=fan&limit=1"));
  const body = (await ok.json()) as { fans: unknown[]; nextCursor: string | null; total: number | null };
  check("the route answers { fans, nextCursor, total }", ok.status === 200 && body.fans.length === 1 && "nextCursor" in body && body.total === 1234);

  // --- demo store: same contract ----------------------------------------------
  useSupabase = false;
  const m = await import("./mock");
  for (let i = 0; i < 3; i++) m.mockCreatePass(`Page Fan ${i}`, 1);
  m.mockCreatePass("Zed Needle", 1);
  const first = await listFansPage({ limit: 2 });
  check("demo: a page of 2 with a cursor and the total", first.fans.length === 2 && first.nextCursor !== null && typeof first.total === "number" && first.total >= 4);
  const second = await listFansPage({ limit: 2, cursor: first.nextCursor });
  check("demo: the next page holds different fans", second.fans.length === 2 && !second.fans.some((f) => first.fans.some((g) => g.fanId === f.fanId)));
  const found = await listFansPage({ query: "zed need" });
  check("demo: the search is served", found.fans.length === 1 && found.fans[0].name === "Zed Needle" && found.nextCursor === null);
  console.log(`fansPage: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
