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
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: signedIn ? { id: "creator-1" } : null }, error: null }) },
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push([name, args]);
        return { data: rpcRows, error: null };
      },
    }),
    createServiceClient: () => {
      throw new Error("the queue must not use the service role");
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

  // --- Supabase path ------------------------------------------------------------
  useSupabase = true;
  rpcRows = [
    { id: "aaaaaaaa-0000-4000-8000-000000000002", status: "pending", created_at: "2026-10-01T00:00:02Z", notes: null, due_at: null, prize_label: "Selfie", prize_rarity: "rare", fan_name: "Sam", pool_snapshot: null, fair_trace: null, reward_kind: "code", reward_views: 2, reward_last_viewed_at: "2026-10-02T00:00:00Z" },
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
  const calls = rpcCalls.length;
  check("supabase: a non-uuid cursor id is refused", JSON.stringify(await listRedemptionQueue({ before: "2026-10-01T00:00:00Z|red_123" })) === '{"error":"bad_request"}');
  check("supabase: …without a database call", rpcCalls.length === calls);
  check("cursor decoding rejects junk", decodeQueueCursor("x|y") === null && decodeQueueCursor("2026-10-01T00:00:00Z|ok_id")?.id === "ok_id");
  signedIn = false;
  check("supabase: signed out → unauthorized", JSON.stringify(await listRedemptionQueue({})) === '{"error":"unauthorized"}');

  console.log(`redemptionQueue.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
