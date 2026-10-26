import assert from "node:assert";
import { mock } from "node:test";

// Route-level tests for the notification bell (RD-7 / spec #1):
//   GET  /api/notifications       → the derived feed + unread count
//   POST /api/notifications/seen  → marks everything seen (set_notifications_seen)
//
// The Supabase server module is swapped for a recording fake so the test can
// flip between the demo path (not configured) and the real path (configured)
// and see every query the data layer makes. AUTH: a signed-out caller must get
// 401 from both routes without a single table read or RPC.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

type Call = { table: string; ops: [string, unknown[]][] };
const calls: Call[] = [];
const rpcs: string[] = [];
let configured = false;
let user: { id: string } | null = null;
let canned: Record<string, unknown[]> = {};
let failTable: string | null = null;

// A chainable stand-in for the supabase-js query builder: records every method
// and resolves to the canned rows for the table (or an error for `failTable`).
function builder(table: string) {
  const call: Call = { table, ops: [] };
  calls.push(call);
  const result = () =>
    failTable === table
      ? { data: null, error: { message: "boom" }, count: null }
      : { data: canned[table] ?? [], error: null, count: (canned[table] ?? []).length };
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => resolve(result());
        }
        if (prop === "maybeSingle" || prop === "single") {
          return () => {
            call.ops.push([prop, []]);
            const r = result();
            return Promise.resolve({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data });
          };
        }
        return (...args: unknown[]) => {
          call.ops.push([prop, args]);
          return proxy;
        };
      },
    }
  );
  return proxy;
}

const client = {
  auth: { getUser: async () => ({ data: { user }, error: null }) },
  from: (table: string) => builder(table),
  rpc: async (name: string) => {
    rpcs.push(name);
    return { data: null, error: null };
  },
};

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createClient: async () => client,
    createServiceClient: () => {
      throw new Error("the notification routes must never use the service role");
    },
  },
});

async function main() {
  const { GET } = await import("./route");
  const { POST } = await import("./seen/route");
  const mockLayer = await import("@/lib/data/mock");

  const get = async () => {
    const res = await GET();
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const post = async () => {
    const res = await POST();
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };

  // --- 1. Signed out (Supabase configured, no session) → 401, nothing read ----
  configured = true;
  user = null;
  {
    calls.length = 0;
    rpcs.length = 0;
    const g = await get();
    check("GET signed out → 401", g.status === 401);
    check("GET signed out → unauthorized", g.data.error === "unauthorized");
    check("GET signed out → no feed in the body", !("items" in g.data));
    check("GET signed out → no table read", calls.length === 0);
    const p = await post();
    check("POST seen signed out → 401", p.status === 401 && p.data.error === "unauthorized");
    check("POST seen signed out → RPC not called", rpcs.length === 0);
  }

  // --- 2. Signed in (Supabase path): every read is scoped to the caller -------
  user = { id: "creator-1" };
  {
    calls.length = 0;
    const now = Date.now();
    const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    canned = {
      profiles: [
        { notifications_seen_at: iso(30), notify_new_spin: true, notify_low_balance: true, notify_messages: true },
      ],
      redemptions: [
        { id: "r1", created_at: iso(5), spin: { prize_label: "Shoutout", fan: { display_name: "Ava", handle: null } } },
        { id: "r0", created_at: iso(60), spin: { prize_label: "Old", fan: { display_name: "Zed", handle: null } } },
      ],
      messages: [{ fan_id: "f1", body: "hey", created_at: iso(2), fan: { display_name: "Ava", handle: null } }],
      wheels: [{ id: "w1", title: "Main", updated_at: iso(90) }],
      prizes: [{ id: "p1", label: "Photo", emoji: null, stock: 0, wheel_id: "w1" }],
      spins: [{ prize_id: "p1", created_at: iso(10) }],
      fan_passes: [],
      fans: [],
    };
    const g = await get();
    check("GET signed in → 200", g.status === 200);
    const items = g.data.items as { id: string; unread: boolean; kind: string }[];
    check("feed has the win, the thread and the stock item", items.length === 4);
    check("unread = items newer than notifications_seen_at", g.data.unread === 3);
    check("the old win is listed but read", items.find((i) => i.id === "win:r0")?.unread === false);

    for (const c of calls) {
      // prizes has no creator_id: it is read only for the wheel ids that the
      // creator-scoped wheels query returned.
      const scoped = c.ops.some(
        ([op, args]) =>
          (op === "eq" && (args[0] === "creator_id" || (c.table === "profiles" && args[0] === "id")) && args[1] === "creator-1") ||
          (c.table === "prizes" && op === "in" && args[0] === "wheel_id" && JSON.stringify(args[1]) === JSON.stringify(["w1"]))
      );
      check(`${c.table} read is scoped to the signed-in creator`, scoped);
      check(`${c.table} read never writes`, !c.ops.some(([op]) => ["update", "insert", "upsert", "delete"].includes(op)));
    }
    check("pending wins only", calls.some((c) => c.table === "redemptions" && c.ops.some(([op, a]) => op === "eq" && a[0] === "status" && a[1] === "pending")));
    check("fan messages only", calls.some((c) => c.table === "messages" && c.ops.some(([op, a]) => op === "eq" && a[0] === "sender" && a[1] === "fan")));
    check("unread messages only", calls.some((c) => c.table === "messages" && c.ops.some(([op, a]) => op === "is" && a[0] === "read_at" && a[1] === null)));
  }

  // A missing notify_* column (TEST drift) must not break the bell: prefs fall
  // back to all-on and the rest of the feed still renders.
  {
    const prev = canned.profiles;
    canned.profiles = [];
    const g = await get();
    check("no profile row → still 200 with all items unread", g.status === 200 && g.data.unread === 4);
    canned.profiles = prev;
    failTable = "messages";
    const g2 = await get();
    check("one failing source → 200, the others still listed", g2.status === 200 && (g2.data.items as unknown[]).length === 3);
    failTable = null;
  }

  // POST seen → the SECURITY DEFINER RPC, never a direct profiles UPDATE.
  {
    calls.length = 0;
    rpcs.length = 0;
    const p = await post();
    check("POST seen signed in → 200", p.status === 200 && p.data.ok === true);
    check("POST seen → set_notifications_seen RPC", rpcs.length === 1 && rpcs[0] === "set_notifications_seen");
    check("POST seen → no direct table write", !calls.some((c) => c.ops.some(([op]) => op === "update" || op === "upsert")));
  }

  // --- 3. Demo path (no Supabase): spin + fan message raise the count, seen clears it.
  configured = false;
  {
    const g0 = await get();
    check("demo GET → 200", g0.status === 200);
    const base = g0.data.unread as number;

    const created = mockLayer.mockCreatePass("Notify Fan", 3);
    mockLayer.mockAckFan(created.token);
    const spun = await mockLayer.mockSpin(created.token);
    check("demo spin ok", !("error" in spun));
    const g1 = await get();
    // >= because the win may also take a limited prize down to the low-stock line.
    check("a new win raises the unread count", (g1.data.unread as number) >= base + 1);
    const win = (g1.data.items as { kind: string; title: string; unread: boolean; target: { section: string } }[]).find(
      (i) => i.kind === "win" && i.title.includes("Notify Fan")
    );
    check("the new win is listed unread and opens Fulfilment", !!win && win.unread && win.target.section === "prizes");

    const p = await post();
    check("demo POST seen → 200", p.status === 200);
    const g2 = await get();
    check("after seen → unread 0", g2.data.unread === 0);
    check("after seen → items still listed", (g2.data.items as unknown[]).length >= 1);

    // A later fan message is new again.
    await new Promise((r) => setTimeout(r, 5));
    const sent = mockLayer.mockSendFanMessage(created.token, "are you there?");
    check("demo fan message sent", !("error" in sent));
    const g3 = await get();
    check("a fan message after seen → unread 1", g3.data.unread === 1);
    const msg = (g3.data.items as { kind: string; unread: boolean; target: { section: string; fanId?: string } }[]).find((i) => i.kind === "message")!;
    check("message item is unread and opens that fan's Inbox thread", msg.unread && msg.target.section === "inbox" && msg.target.fanId === created.fanId);
  }

  console.log(`notifications route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
