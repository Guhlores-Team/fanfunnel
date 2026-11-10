import assert from "node:assert";
import { mock } from "node:test";

// A5: once a creator has more than the overview's 200 newest wins, older
// pending prizes must still be reachable and fulfillable. The queue is read
// server-side (status + search + keyset cursor), continuing from the window.
//   - demo: 260 wins; the oldest pending ones sit outside the window, are found
//     page by page through GET /api/redemptions and can be fulfilled;
//   - Supabase: the session RPC gets exactly the filters and cursor, the rows
//     map like the overview's, and a bad cursor never reaches the database.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const rpcCalls: [string, Record<string, unknown>][] = [];
let signedIn = true;
let rpcRows: unknown[] = [];
let useSupabase = false;
let canAct: unknown = false;
let serviceUses = 0;
const STAFF = "cccccccc-0000-4000-8000-000000000001";
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: signedIn ? { id: "creator-1" } : null }, error: null }) },
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push([name, args]);
        if (name === "can_act_for") return { data: canAct, error: null };
        return { data: rpcRows, error: null };
      },
    }),
    // The queue itself never uses the service role; only the team-name read
    // (WG-07) does, and only after the session proved can_act_for.
    createServiceClient: () => {
      serviceUses++;
      if (canAct !== true) throw new Error("the service role was used without a permission proof");
      const rows = (table: string) => table === "org_members" ? [{ profile_id: STAFF }] : table === "profiles" ? [{ id: STAFF, display_name: "Robin Chatter" }] : [];
      return { from: (table: string) => ({ select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: table === "profiles" ? { org_id: "org-1" } : { owner_id: "owner-1" }, error: null }), in: async () => ({ data: rows(table), error: null }) }),
        in: async () => ({ data: rows(table), error: null }),
      }) }) };
    },
  },
});

async function main() {
  const data = await import("./index");
  const m = await import("./mock");
  const { listRedemptionQueue, decodeQueueCursor, OVERVIEW_REDEMPTION_WINDOW } = await import("./redemptionQueue");
  const { GET } = await import("@/app/api/redemptions/route");
  const get = async (qs: string) => {
    const res = await GET(new Request(`http://localhost/api/redemptions${qs}`));
    return { status: res.status, body: (await res.json()) as { items?: { id: string; status: string; fanName: string }[]; next?: string | null; error?: string } };
  };

  // --- demo path ----------------------------------------------------------------
  const TOTAL = 260;
  const fan = m.mockCreatePass("Queue Fan", TOTAL);
  m.mockAckFan(fan.token);
  for (let i = 0; i < TOTAL; i++) {
    const r = await m.mockSpin(fan.token);
    assert.ok(!("error" in r), `spin ${i} failed`);
  }
  const overview = await data.getOverview();
  check("demo: the overview still carries only the newest 200", overview.redemptions.length === OVERVIEW_REDEMPTION_WINDOW);
  const pendingTotal = overview.metrics.pending;
  const windowPending = overview.redemptions.filter((r) => r.status === "pending").length;
  check("demo: some pending wins are outside the window", pendingTotal > windowPending);

  // Continue from the window's last row, as PrizesPanel does.
  const end = overview.redemptions[overview.redemptions.length - 1];
  let cursor: string | null = `${end.at}|${end.id}`;
  const older: { id: string; status: string }[] = [];
  let pages = 0;
  while (cursor && pages < 20) {
    const page = await get(`?status=pending&before=${encodeURIComponent(cursor)}`);
    assert.equal(page.status, 200);
    older.push(...(page.body.items ?? []));
    cursor = page.body.next ?? null;
    pages++;
  }
  check("demo: every pending win outside the window is reachable", windowPending + older.length === pendingTotal);
  check("demo: older pages only hold pending wins", older.every((r) => r.status === "pending"));
  check("demo: no older row repeats a window row", !older.some((r) => overview.redemptions.some((w) => w.id === r.id)));
  check("demo: paging stops", cursor === null);

  const oldest = older[older.length - 1];
  check("demo: the oldest pending win can be fulfilled", "ok" in (await data.setRedemptionStatus(oldest.id, "fulfilled")));
  const after = await data.getOverview();
  check("demo: the pending count drops", after.metrics.pending === pendingTotal - 1);
  const again = await get(`?status=pending&before=${encodeURIComponent(`${end.at}|${end.id}`)}`);
  check("demo: the fulfilled win left the pending queue", !(again.body.items ?? []).some((r) => r.id === oldest.id));
  const fulfilled = await get(`?status=fulfilled`);
  check("demo: it is in the fulfilled queue", (fulfilled.body.items ?? []).some((r) => r.id === oldest.id));

  const search = await get(`?q=${encodeURIComponent("queue fan")}`);
  check("demo: search matches the fan name, case-insensitively", (search.body.items ?? []).length === 50 && search.body.next !== null);
  check("demo: a search with no match is empty", ((await get(`?q=nobody-here`)).body.items ?? []).length === 0);
  check("demo: unknown status → 400", (await get(`?status=lost`)).status === 400);
  check("demo: malformed cursor → 400", (await get(`?before=not-a-cursor`)).status === 400);
  check("demo: over-long search → 400", (await get(`?q=${"x".repeat(101)}`)).status === 400);

  // Wins in the same millisecond (a fast loop, or a bingo line bonus sharing its
  // play's time) straddling the window's edge: the window and the queue must
  // order ties the same way (at, then id), or paging on skips or repeats them.
  // A frozen clock makes every one of these wins a tie, deterministically.
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 86_400_000 });
  const tieFan = m.mockCreatePass("Tie Fan", 230);
  m.mockAckFan(tieFan.token);
  for (let i = 0; i < 230; i++) assert.ok(!("error" in await m.mockSpin(tieFan.token)), `tie spin ${i} failed`);
  const tied = await data.getOverview();
  const tiedEnd = tied.redemptions[tied.redemptions.length - 1];
  check("demo ties: the window ends inside one millisecond of wins", tied.redemptions.filter((r) => r.at === tiedEnd.at).length === OVERVIEW_REDEMPTION_WINDOW);
  let tieCursor: string | null = `${tiedEnd.at}|${tiedEnd.id}`;
  const tiedOlder: { id: string; status: string }[] = [];
  for (let page = 0; tieCursor && page < 20; page++) {
    const next = await get(`?status=pending&before=${encodeURIComponent(tieCursor)}`);
    tiedOlder.push(...(next.body.items ?? []));
    tieCursor = next.body.next ?? null;
  }
  const tiedWindowPending = tied.redemptions.filter((r) => r.status === "pending").length;
  check("demo ties: every pending win past a tied window edge is reachable", tiedWindowPending + tiedOlder.length === tied.metrics.pending);
  check("demo ties: no row past the edge repeats a window row", !tiedOlder.some((r) => tied.redemptions.some((w) => w.id === r.id)));
  mock.timers.reset();

  // --- Supabase path ------------------------------------------------------------
  useSupabase = true;
  rpcRows = [
    { id: "aaaaaaaa-0000-4000-8000-000000000002", status: "pending", created_at: "2026-10-01T00:00:02Z", notes: null, due_at: null, prize_label: "Selfie", prize_rarity: "rare", fan_name: "Sam", fan_id: "bbbbbbbb-0000-4000-8000-000000000009", pool_snapshot: null, fair_trace: null, reward_kind: "code", reward_views: 2, reward_last_viewed_at: "2026-10-02T00:00:00Z" },
    { id: "aaaaaaaa-0000-4000-8000-000000000001", status: "pending", created_at: "2026-10-01T00:00:01Z", notes: "n", due_at: null, prize_label: "Shoutout", prize_rarity: "common", fan_name: "Ana", pool_snapshot: null, fair_trace: null, reward_kind: null, reward_views: null, reward_last_viewed_at: null },
  ];
  const before = "2026-10-01T00:00:03.000Z|aaaaaaaa-0000-4000-8000-000000000003";
  const page = await listRedemptionQueue({ status: "pending", query: " sam ", before, limit: 1 });
  assert.ok(!("error" in page));
  const [name, args] = rpcCalls.at(-1)!;
  check("supabase: one session RPC", name === "creator_redemption_queue");
  check("supabase: filters, cursor and a look-ahead row", JSON.stringify(args) === JSON.stringify({ p_status: "pending", p_query: "sam", p_before_at: "2026-10-01T00:00:03.000Z", p_before_id: "aaaaaaaa-0000-4000-8000-000000000003", p_limit: 2 }));
  check("supabase: one row per page, and a next cursor", page.items.length === 1 && page.next === "2026-10-01T00:00:02Z|aaaaaaaa-0000-4000-8000-000000000002");
  check("supabase: rows map like the overview's", page.items[0].fanName === "Sam" && page.items[0].auto?.kind === "code" && page.items[0].auto?.views === 2);
  // 0073 (DB-10): rows name their fan; `fanId` narrows the queue to one fan.
  check("supabase: a row carries its fan id", page.items[0].fanId === "bbbbbbbb-0000-4000-8000-000000000009");
  await listRedemptionQueue({ fanId: "bbbbbbbb-0000-4000-8000-000000000009" });
  check("supabase: fanId is passed as p_fan", rpcCalls.at(-1)![1].p_fan === "bbbbbbbb-0000-4000-8000-000000000009");
  const fanCalls = rpcCalls.length;
  check("supabase: a fanId that is no uuid is refused without a call", JSON.stringify(await listRedemptionQueue({ fanId: "fan_1" })) === '{"error":"bad_request"}' && rpcCalls.length === fanCalls);
  const calls = rpcCalls.length;
  check("supabase: a non-uuid cursor id is refused", JSON.stringify(await listRedemptionQueue({ before: "2026-10-01T00:00:00Z|red_123" })) === '{"error":"bad_request"}');
  check("supabase: …without a database call", rpcCalls.length === calls);
  // --- WG-07: paged rows say which team member moved the prize -----------------
  {
    const row = (id: string, status: string, actor: string | null) => ({ id, status, created_at: "2026-10-02T00:00:00Z", notes: null, due_at: null, prize_label: "Selfie", prize_rarity: "rare", fan_name: "Sam", pool_snapshot: null, fair_trace: null, reward_kind: null, reward_views: null, reward_last_viewed_at: null, actor_id: actor });
    rpcRows = [
      row("aaaaaaaa-0000-4000-8000-000000000011", "in_progress", STAFF),
      row("aaaaaaaa-0000-4000-8000-000000000012", "fulfilled", "creator-1"),
      row("aaaaaaaa-0000-4000-8000-000000000013", "pending", STAFF),
      row("aaaaaaaa-0000-4000-8000-000000000014", "fulfilled", null),
    ];
    canAct = true;
    let usesBefore = serviceUses;
    const named = await listRedemptionQueue({});
    assert.ok(!("error" in named));
    const proof = rpcCalls.filter(([n]) => n === "can_act_for").at(-1);
    check("a prize a team member moved says who", named.items[0].via === "Robin Chatter");
    check("the creator's own move, a pending prize and an untouched one carry no line", named.items.slice(1).every((i) => i.via === undefined));
    check("the session proved can_act_for(self, 'view') before the names were read", proof?.[1].perm === "view" && proof?.[1].target_creator === "creator-1" && serviceUses === usesBefore + 1);
    canAct = false;
    usesBefore = serviceUses;
    const unnamed = await listRedemptionQueue({});
    assert.ok(!("error" in unnamed));
    check("without the proof the rows still load, with no names and no service read", unnamed.items.length === 4 && unnamed.items.every((i) => i.via === undefined) && serviceUses === usesBefore);
    rpcRows = [row("aaaaaaaa-0000-4000-8000-000000000015", "fulfilled", "creator-1")];
    canAct = true;
    usesBefore = serviceUses;
    await listRedemptionQueue({});
    check("a page with no team moves asks nothing and reads nothing", serviceUses === usesBefore);
    canAct = false;
  }
  check("cursor decoding rejects junk", decodeQueueCursor("x|y") === null && decodeQueueCursor("2026-10-01T00:00:00Z|ok_id")?.id === "ok_id");
  signedIn = false;
  check("supabase: signed out → unauthorized", JSON.stringify(await listRedemptionQueue({})) === '{"error":"unauthorized"}');

  console.log(`redemptionQueue.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
