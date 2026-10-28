import assert from "node:assert";
import { mock } from "node:test";

// Integration (Supabase path, `web-push` mocked): a recorded spin win pushes
// to the creator's devices exactly once per active device, and only AFTER the
// response (handed to Next's after(), F7), so a slow push service can't delay
// or break the spin. The creator id is the server-side pass row's.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

process.env.VAPID_PUBLIC_KEY = "B" + "a".repeat(86);
process.env.VAPID_PRIVATE_KEY = "c".repeat(43);
process.env.VAPID_SUBJECT = "mailto:ops@example.test";

const scheduled: (() => unknown)[] = [];
globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

type Op = { name: string; args: unknown[] };
type Resp = { data: unknown; error: { message: string; code?: string } | null };
const ok = (data: unknown): Resp => ({ data, error: null });
const has = (ops: Op[], name: string, arg?: string) =>
  ops.some((o) => o.name === name && (arg === undefined || String(o.args[0]).includes(arg)));
const deviceQueries: Op[][] = [];
const TABLES: Record<string, (ops: Op[]) => Resp> = {
  // The push engagement gate reads the fan's passes (none paused) and fans row (not blocked).
  fan_passes: (ops) =>
    has(ops, "select", "self_excluded_at")
      ? ok([{ self_excluded_at: null }])
      : ok({
      id: "pass-1", creator_id: "creator-1", campaign_id: null, wheel_id: "wheel-1", fan_id: "fan-1",
      next_server_seed: "f".repeat(64), next_server_seed_hash: "0".repeat(64),
    }),
  wheels: (ops) =>
    has(ops, "select", "prizes(")
      ? ok({
          id: "wheel-1", title: "W", subtitle: null, brand_color: null, label_color: null, label_size: null,
          prizes: [
            { id: "a", label: "A", description: null, rarity: "common", weight: 1, color: null, emoji: null, image_url: null, cost_cents: null, stock: null, sort_order: 0 },
          ],
        })
      : ok([{ id: "wheel-1", is_active: true, active_from: null, active_until: null, created_at: "2026-01-01T00:00:00Z" }]),
  fans: (ops) => (has(ops, "select", "blocked_at") ? ok({ blocked_at: null }) : ok({ pity_counter: 0 })),
  happy_hours: () => ok([]),
  spins: () => ok({ id: "spin-1", share_id: "share-1" }),
  redemptions: (ops) => (has(ops, "insert") ? ok(null) : ok({ id: "red-1" })),
  webhooks: () => ok([]),
  push_subscriptions: (ops) => {
    if (has(ops, "select")) deviceQueries.push(ops);
    return has(ops, "select")
      ? ok([
          { id: "d1", endpoint: "https://fcm.googleapis.com/fcm/send/d1", p256dh: "k", auth: "a", show_details: false },
          { id: "d2", endpoint: "https://web.push.apple.com/d2", p256dh: "k", auth: "a", show_details: true },
        ])
      : ok(null);
  },
  push_log: (ops) => (has(ops, "insert") ? ok(null) : ok([])),
};
function fakeClient() {
  const builder = (table: string) => {
    const ops: Op[] = [];
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (res: (v: Resp) => unknown, rej: (e: unknown) => unknown) => {
              const h = TABLES[table];
              if (!h) return Promise.reject(new Error(`fake client: no handler for ${table}`)).then(res, rej);
              return Promise.resolve(h(ops)).then(res, rej);
            };
          }
          return (...args: unknown[]) => {
            ops.push({ name: String(prop), args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  return { from: (table: string) => builder(table), rpc: async () => ok(null) };
}

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => fakeClient(),
    createServiceClient: () => fakeClient(),
  },
});

const loadedFor: string[] = [];
mock.module("@/lib/data/notifications", {
  namedExports: {
    loadNotificationSources: async (_sb: unknown, uid: string) => {
      loadedFor.push(uid);
      return {
        seenAt: null,
        prefs: { newSpin: true, lowBalance: true, messages: true },
        sources: {
          pendingWins: [{ id: "red-1", fanName: "Nova", prizeLabel: "A", at: new Date().toISOString() }],
          unreadMessages: [],
          lowStock: [],
          outOfSpins: [],
        },
      };
    },
    getNotifications: async () => null,
    markNotificationsSeen: async () => ({ ok: true }),
  },
});

const sends: { endpoint: string; title: string }[] = [];
mock.module("web-push", {
  defaultExport: {
    sendNotification: async (sub: { endpoint: string }, body: string) => {
      sends.push({ endpoint: sub.endpoint, title: JSON.parse(body).title });
      return { statusCode: 201, body: "", headers: {} };
    },
  },
});

async function main() {
  const realNextServer = await import("next/server");
  mock.module("next/server", {
    namedExports: { ...realNextServer, after: (task: () => unknown) => void scheduled.push(task) },
  });
  const { completeClaimedSpin } = await import("@/lib/data/spins");
  const result = await completeClaimedSpin(
    fakeClient() as unknown as Parameters<typeof completeClaimedSpin>[0],
    "tok-1",
    "seed",
    2,
  );
  check("the spin succeeds", !("error" in result));
  await new Promise((r) => setTimeout(r, 20));
  check("webhooks + push are both scheduled with after()", scheduled.length === 2);
  check("nothing pushed before the response", sends.length === 0 && deviceQueries.length === 0);

  await Promise.all(scheduled.map((t) => t()));
  check("exactly one push per active device", sends.length === 2 && new Set(sends.map((s) => s.endpoint)).size === 2);
  check("the feed was built for the pass row's creator", loadedFor.join() === "creator-1");
  check("devices read for that creator only, active ones only", deviceQueries.length === 1 &&
    has(deviceQueries[0], "eq", "user_id") && deviceQueries[0].some((o) => o.name === "eq" && o.args[1] === "creator-1") &&
    deviceQueries[0].some((o) => o.name === "lt" && o.args[0] === "failures"));
  check("generic device: generic title", sends.find((s) => s.endpoint.includes("/d1"))?.title === "New activity on FanFunnel");
  check("detailed device: the bell's title", sends.find((s) => s.endpoint.includes("/d2"))?.title === "Nova won A");

  console.log(`spin push (after response): ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
