import assert from "node:assert";
import { mock } from "node:test";

// AUTH-SENSITIVE (AGENTS.md rules 5/7): the web push routes.
//   /api/push/subscribe  GET list · POST subscribe · PATCH lock-screen switch · DELETE remove
//   /api/push/test       POST send a test to my devices
//
// Negative tests: anon gets 401 from every route with no table access and no
// send; creator A can't list, change, remove or send to creator B's devices
// (every query is filtered to A's auth id, and the fake applies RLS the way
// push_subscriptions' policies do); a user_id in the body is ignored; keys
// unset → not_configured with no write; an endpoint that isn't a real push
// service (SSRF) is refused; subscribe and test are rate-limited. The database
// half (RLS itself, column grants, anon refused) is probed for real by
// scripts/db/schema-drift-check.mjs (probePush) and
// scripts/security/rls-runtime-test.mjs.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEYS = { VAPID_PUBLIC_KEY: "B" + "a".repeat(86), VAPID_PRIVATE_KEY: "c".repeat(43), VAPID_SUBJECT: "mailto:ops@example.test" };
const setKeys = (on: boolean) => {
  for (const [k, v] of Object.entries(KEYS)) {
    if (on) process.env[k] = v;
    else delete process.env[k];
  }
};

type Row = Record<string, unknown>;
let rows: Row[] = [];
let user: { id: string } | null = null;
const ops: { op: string; filters: [string, unknown][]; payload: Row | null }[] = [];
let tableTouches = 0;

const dev = (id: string, owner: string, extra: Row = {}): Row => ({
  id,
  user_id: owner,
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  p256dh: "BKey",
  auth: "auth",
  show_details: false,
  user_agent: "Mac · Chrome",
  created_at: new Date().toISOString(),
  last_success_at: null,
  failures: 0,
  ...extra,
});

// Session client: RLS modelled as "only the caller's own rows exist".
function session(table: string) {
  tableTouches++;
  assert.strictEqual(table, "push_subscriptions");
  let op = "select";
  let payload: Row | null = null;
  const filters: [string, unknown][] = [];
  const visible = () => rows.filter((r) => user && r.user_id === user.id);
  const run = () => {
    ops.push({ op, filters: [...filters], payload });
    const hit = visible().filter((r) => filters.every(([c, v]) => r[c] === v));
    if (op === "insert") {
      if (payload!.user_id !== user?.id) return { data: null, error: { message: "new row violates row-level security policy", code: "42501" } };
      if (rows.some((r) => r.endpoint === payload!.endpoint)) return { data: null, error: { message: "duplicate", code: "23505" } };
      const row = dev(String(rows.length + 100).padStart(8, "0") + "-0000-4000-8000-000000000000", user!.id, payload!);
      rows.push(row);
      return { data: row, error: null };
    }
    if (op === "update") hit.forEach((r) => Object.assign(r, payload));
    if (op === "delete") rows = rows.filter((r) => !hit.includes(r));
    return { data: hit, error: null };
  };
  const b: Record<string, unknown> = {
    select: () => b,
    insert: (p: Row) => ((op = "insert"), (payload = p), b),
    update: (p: Row) => ((op = "update"), (payload = p), b),
    delete: () => ((op = "delete"), b),
    eq: (c: string, v: unknown) => (filters.push([c, v]), b),
    order: () => b,
    single: async () => run(),
    then: (resolve: (v: unknown) => void) => resolve(run()),
  };
  return b;
}
const serviceWrites: [string, unknown][][] = [];
function service(table: string) {
  const filters: [string, unknown][] = [];
  const b: Record<string, unknown> = {
    select: () => b,
    update: () => b,
    delete: () => b,
    eq: (c: string, v: unknown) => (filters.push([c, v]), b),
    maybeSingle: async () => ({ data: { failures: 0 }, error: null }),
    then: (resolve: (v: unknown) => void) => {
      assert.strictEqual(table, "push_subscriptions");
      serviceWrites.push([...filters]);
      resolve({ data: null, error: null });
    },
  };
  return b;
}

let configured = true;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) }, from: session }),
    createServiceClient: () => ({ from: service }),
  },
});

const sentTo: string[] = [];
mock.module("web-push", {
  defaultExport: {
    sendNotification: async (sub: { endpoint: string }) => {
      sentTo.push(sub.endpoint);
      return { statusCode: 201, body: "", headers: {} };
    },
  },
});

async function main() {
  const sub = await import("./route");
  const test = await import("../test/route");
  const cfg = await import("../config/route");
  let ip = 0;
  const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/push/subscribe", {
      method,
      headers: { "Content-Type": "application/json", "x-real-ip": `10.0.0.${++ip % 250}`, "user-agent": "Mozilla/5.0 (Macintosh) Chrome/130.0", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  const call = async (p: Promise<Response>) => {
    const res = await p;
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const browserSub = (name: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: "BNcRdreALRFX", auth: "tBHItJI5svbpez7KI4CCXg" } });
  setKeys(true);

  // --- 1. Anon: 401 everywhere, no table touched, nothing sent ---------------------
  user = null;
  rows = [dev("bbbbbbbb-0000-4000-8000-000000000001", B)];
  {
    tableTouches = 0;
    const g = await call(sub.GET());
    check("anon GET → 401", g.status === 401 && g.data.error === "unauthorized" && !("devices" in g.data));
    const p = await call(sub.POST(req("POST", { subscription: browserSub("anon") })));
    check("anon subscribe → 401", p.status === 401);
    const pa = await call(sub.PATCH(req("PATCH", { id: rows[0].id, showDetails: true })));
    check("anon PATCH → 401", pa.status === 401);
    const d = await call(sub.DELETE(req("DELETE", { id: rows[0].id })));
    check("anon DELETE → 401", d.status === 401);
    const t = await call(test.POST(req("POST", {})));
    check("anon test-send → 401", t.status === 401);
    check("anon → no table read or write", tableTouches === 0);
    check("anon → nothing sent", sentTo.length === 0);
    check("B's device untouched", rows.length === 1 && rows[0].show_details === false);
  }

  // --- 2. Creator A vs creator B's device -------------------------------------------
  user = { id: A };
  const bId = rows[0].id as string;
  {
    const g = await call(sub.GET());
    check("A lists 0 devices (not B's)", g.status === 200 && (g.data.devices as unknown[]).length === 0);
    check("list never returns endpoints or keys", !JSON.stringify(g.data).includes("fcm.googleapis.com"));
    const d = await call(sub.DELETE(req("DELETE", { id: bId })));
    check("A removing B's device → 404", d.status === 404);
    const pa = await call(sub.PATCH(req("PATCH", { id: bId, showDetails: true })));
    check("A flipping B's lock-screen switch → 404", pa.status === 404);
    const t = await call(test.POST(req("POST", { id: bId })));
    check("A test-sending to B's device → 404, nothing sent", t.status === 404 && sentTo.length === 0);
    const tAll = await call(test.POST(req("POST", {})));
    check("A test-sending with no devices → 404, B's device not targeted", tAll.status === 404 && sentTo.length === 0);
    check("B's device still there, unchanged", rows.some((r) => r.id === bId && r.show_details === false));
    for (const o of ops) check(`${o.op} is filtered to A's auth id`, o.filters.some(([c, v]) => c === "user_id" && v === A) || o.op === "insert");
  }

  // --- 3. A subscribes; a user_id in the body is ignored ------------------------------
  {
    ops.length = 0;
    const p = await call(sub.POST(req("POST", { subscription: browserSub("a1"), user_id: B, userId: B })));
    check("A subscribes → 201", p.status === 201);
    const ins = ops.find((o) => o.op === "insert")!;
    check("the row is A's, whatever the body said", ins.payload?.user_id === A);
    check("lock-screen starts generic (D9)", ins.payload?.show_details === false);
    check("device label derived server-side from the User-Agent", ins.payload?.user_agent === "Mac · Chrome");
    check("only the allowed columns are written", Object.keys(ins.payload!).sort().join() === "auth,endpoint,p256dh,show_details,user_agent,user_id");
    const device = p.data.device as Record<string, unknown>;
    check("the response has no endpoint/keys", !JSON.stringify(p.data).includes("fcm.googleapis.com") && !("p256dh" in device));

    const again = await call(sub.POST(req("POST", { subscription: browserSub("a1") })));
    check("re-subscribing the same browser refreshes it (still one row)", again.status === 201 && rows.filter((r) => r.user_id === A).length === 1);

    const taken = await call(sub.POST(req("POST", { subscription: { ...browserSub("x"), endpoint: rows.find((r) => r.id === bId)!.endpoint } })));
    check("B's browser endpoint → 409 conflict, never taken over", taken.status === 409 && rows.find((r) => r.id === bId)!.user_id === B);

    const g = await call(sub.GET());
    const mine = g.data.devices as { id: string; showDetails: boolean }[];
    check("A now lists exactly its own device", mine.length === 1);
    const pa = await call(sub.PATCH(req("PATCH", { id: mine[0].id, showDetails: true })));
    check("A flips its own lock-screen switch", pa.status === 200 && (pa.data.device as { showDetails: boolean }).showDetails === true);
    const bad = await call(sub.PATCH(req("PATCH", { id: mine[0].id, showDetails: "yes" })));
    check("non-boolean showDetails → 400", bad.status === 400);

    const t = await call(test.POST(req("POST", { id: mine[0].id })));
    check("A test-sends to its own device", t.status === 200 && t.data.sent === 1 && sentTo.length === 1 && sentTo[0].endsWith("/a1"));
    check("test bookkeeping scoped by id AND A's user_id", serviceWrites.length > 0 && serviceWrites.every((f) => f.some(([c, v]) => c === "user_id" && v === A)));

    const d = await call(sub.DELETE(req("DELETE", { id: mine[0].id })));
    check("A removes its own device", d.status === 200 && !rows.some((r) => r.user_id === A));
  }

  // --- 4. Validation: SSRF endpoints, malformed bodies ------------------------------------
  {
    for (const endpoint of ["http://fcm.googleapis.com/fcm/send/x", "https://169.254.169.254/latest", "https://fcm.googleapis.com.evil.example/x"]) {
      const p = await call(sub.POST(req("POST", { subscription: { endpoint, keys: { p256dh: "BKey", auth: "auth" } } })));
      check(`endpoint refused: ${endpoint}`, p.status === 400 && p.data.error === "invalid_subscription");
    }
    const noKeys = await call(sub.POST(req("POST", { subscription: { endpoint: browserSub("k").endpoint } })));
    check("subscription without keys → 400", noKeys.status === 400);
    const notJson = await call(sub.POST(req("POST", "{nope")));
    check("non-JSON body → 400", notJson.status === 400);
    const badId = await call(sub.DELETE(req("DELETE", { id: "../../etc" })));
    check("non-uuid id → 400", badId.status === 400);
  }

  // --- 5. Keys unset: push is OFF, cleanly -------------------------------------------------
  {
    setKeys(false);
    const c = await call(cfg.GET());
    check("config says unavailable, no key", c.data.available === false && c.data.publicKey === null);
    const before = rows.length;
    const p = await call(sub.POST(req("POST", { subscription: browserSub("off") })));
    check("subscribe with keys unset → 403 not_configured, nothing stored", p.status === 403 && p.data.error === "not_configured" && rows.length === before);
    const t = await call(test.POST(req("POST", {})));
    check("test with keys unset → 403 not_configured", t.status === 403 && t.data.error === "not_configured");
    setKeys(true);
    const c2 = await call(cfg.GET());
    check("config with keys → public key only", c2.data.available === true && c2.data.publicKey === KEYS.VAPID_PUBLIC_KEY && !JSON.stringify(c2.data).includes(KEYS.VAPID_PRIVATE_KEY));
  }

  // --- 6. Rate limits ------------------------------------------------------------------------
  {
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const p = await call(sub.POST(req("POST", { subscription: browserSub(`rl${i}`) })));
      if (p.status === 429) limited++;
    }
    check("subscribe is rate-limited per account", limited > 0);
    let tl = 0;
    for (let i = 0; i < 5; i++) {
      const t = await call(test.POST(req("POST", {})));
      if (t.status === 429) tl++;
    }
    check("test-send is rate-limited per account", tl > 0);
  }

  // --- 7. The demo-only outbox does not exist on a real deployment ------------------------
  {
    const outbox = await import("../outbox/route");
    const real = await call(outbox.GET());
    check("outbox with Supabase configured → 404, nothing returned", real.status === 404 && !("deliveries" in real.data));
    configured = false;
    const demo = await call(outbox.GET());
    check("outbox in demo mode → the simulated deliveries", demo.status === 200 && Array.isArray(demo.data.deliveries));
    configured = true;
  }

  console.log(`push routes: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
