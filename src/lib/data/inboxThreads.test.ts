import assert from "node:assert";
import { mock } from "node:test";

// A13: the Inbox lists one row per fan thread (latest message + unread count)
// a page at a time, so a creator with thousands of messages never loses an
// old or unread thread off the end of a capped read.
//   - demo: 1,300 messages over 130 threads; every thread (including the
//     oldest, still unread) is reached across pages, none repeats;
//   - Supabase: one RPC per page with the cursor and a look-ahead row, and the
//     message table itself is never read wholesale.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const rpcCalls: [string, Record<string, unknown>][] = [];
const tablesRead: string[] = [];
let rpcRows: unknown[] = [];
let useSupabase = false;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: { id: "creator-1" } }, error: null }) },
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push([name, args]);
        return { data: rpcRows, error: null };
      },
      from: (table: string) => {
        tablesRead.push(table);
        throw new Error(`listThreads must not read ${table} directly`);
      },
    }),
    createServiceClient: () => {
      throw new Error("the inbox must not use the service role");
    },
  },
});

async function main() {
  const data = await import("./index");
  const m = await import("./mock");
  const { GET } = await import("@/app/api/messages/inbox/route");
  const get = async (qs = "") => {
    const res = await GET(new Request(`http://localhost/api/messages/inbox${qs}`));
    return { status: res.status, body: (await res.json()) as { threads?: { fanId: string; unread: number; fanName: string }[]; next?: string | null; hasThread?: boolean } };
  };

  // --- demo path ----------------------------------------------------------------
  const THREADS = 130;
  const fans: { token: string; fanId: string }[] = [];
  for (let i = 0; i < THREADS; i++) {
    const f = m.mockCreatePass(`Inbox Fan ${String(i).padStart(3, "0")}`, 1);
    m.mockAckFan(f.token);
    fans.push(f);
  }
  // The oldest thread is written first and left unread.
  for (let round = 0; round < 10; round++) {
    for (const f of fans) assert.ok("ok" in m.mockSendFanMessage(f.token, `msg ${round}`));
  }
  const oldest = fans[0];
  // Every other thread gets newer activity than the oldest one.
  await new Promise((r) => setTimeout(r, 5));
  for (const f of fans.slice(1)) assert.ok("ok" in m.mockSendFanMessage(f.token, "later"));

  const seen = new Map<string, number>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await get(cursor ? `?before=${encodeURIComponent(cursor)}` : "");
    assert.equal(page.status, 200);
    for (const t of page.body.threads ?? []) seen.set(t.fanId, (seen.get(t.fanId) ?? 0) + 1);
    cursor = page.body.next ?? null;
    pages++;
  } while (cursor && pages < 10);
  const ours = fans.filter((f) => seen.has(f.fanId));
  check("demo: more than one page", pages >= 2);
  check("demo: every thread is reachable", ours.length === THREADS);
  check("demo: no thread repeats across pages", [...seen.values()].every((n) => n === 1));
  const first = await get();
  check("demo: the first page holds 100 threads", (first.body.threads ?? []).length === 100 && !!first.body.next);
  check("demo: the oldest thread is not on the first page", !(first.body.threads ?? []).some((t) => t.fanId === oldest.fanId));
  const rest = await get(`?before=${encodeURIComponent(first.body.next!)}`);
  const old = (rest.body.threads ?? []).find((t) => t.fanId === oldest.fanId);
  check("demo: …but on a later page, with all ten unread", old?.unread === 10);
  check("demo: per-fan check finds an old thread", (await get(`?fanId=${oldest.fanId}`)).body.hasThread === true);
  check("demo: per-fan check for a fan without one", (await get(`?fanId=no-such-fan`)).body.hasThread === false);
  check("demo: malformed cursor → 400", (await get(`?before=garbage`)).status === 400);

  // --- Supabase path ------------------------------------------------------------
  useSupabase = true;
  rpcRows = [
    { fan_id: "aaaaaaaa-0000-4000-8000-000000000002", fan_name: "Sam", last_body: "hi", last_sender: "fan", last_at: "2026-10-01T00:00:02Z", unread: 3 },
    { fan_id: "aaaaaaaa-0000-4000-8000-000000000001", fan_name: "", last_body: "yo", last_sender: "creator", last_at: "2026-10-01T00:00:01Z", unread: 0 },
  ];
  const page = await data.listThreads("2026-10-02T00:00:00.000Z|aaaaaaaa-0000-4000-8000-000000000009", 1);
  assert.ok(!("error" in page));
  const [name, args] = rpcCalls.at(-1)!;
  check("supabase: one RPC per page", name === "creator_inbox_threads");
  check("supabase: cursor and a look-ahead row", JSON.stringify(args) === JSON.stringify({ p_before_at: "2026-10-02T00:00:00.000Z", p_before_fan: "aaaaaaaa-0000-4000-8000-000000000009", p_limit: 2 }));
  check("supabase: rows map to threads with unread counts", page.threads.length === 1 && page.threads[0].fanName === "Sam" && page.threads[0].unread === 3);
  check("supabase: the next cursor is the last returned thread", page.next === "2026-10-01T00:00:02Z|aaaaaaaa-0000-4000-8000-000000000002");
  check("supabase: the messages table is never read wholesale", tablesRead.length === 0);
  const calls = rpcCalls.length;
  check("supabase: a non-uuid cursor is refused", JSON.stringify(await data.listThreads("2026-10-01T00:00:00Z|fan_1")) === '{"error":"bad_request"}' && rpcCalls.length === calls);
  rpcRows = [];
  check("supabase: an empty inbox has no next page", JSON.stringify(await data.listThreads()) === '{"threads":[],"next":null}');

  console.log(`inboxThreads.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
