import assert from "node:assert";
import { mock } from "node:test";

// Regression: the spin path fired the creator's webhooks as a dangling promise
// (`void fireWebhooks(...)`). On a serverless host the invocation can be frozen
// as soon as the response is sent, cutting the delivery off. The fan-out must
// be handed to Next's `after()` (which keeps the invocation alive until it
// settles) instead of starting in the background. Also checks that the work,
// once run, still delivers to a public endpoint and still refuses a private one
// (the SSRF guard), and that the spin itself doesn't wait on it.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- `after` spy: record scheduled callbacks instead of running them ---------
const scheduled: unknown[] = [];
async function mockAfter() {
  const realNextServer = await import("next/server");
  mock.module("next/server", {
    namedExports: {
      ...realNextServer,
      after: (task: unknown) => {
        scheduled.push(task);
      },
    },
  });
}

// --- fetch spy ----------------------------------------------------------------
const fetched: string[] = [];
globalThis.fetch = (async (url: string | URL) => {
  fetched.push(String(url));
  return new Response(null, { status: 204 });
}) as typeof fetch;

// --- A scriptable Supabase client (same shape as spinStock.test.ts) -----------
type Op = { name: string; args: unknown[] };
type Resp = { data: unknown; error: { message: string } | null };
const ok = (data: unknown): Resp => ({ data, error: null });
const has = (ops: Op[], name: string, arg?: string) =>
  ops.some((o) => o.name === name && (arg === undefined || String(o.args[0]).includes(arg)));
let webhookReads = 0;
const TABLES: Record<string, (ops: Op[]) => Resp> = {
  fan_passes: () =>
    ok({
      id: "pass-1", creator_id: "creator-1", campaign_id: null, wheel_id: "wheel-1", fan_id: "fan-1",
      next_server_seed: "f".repeat(64), next_server_seed_hash: "0".repeat(64),
    }),
  wheels: (ops) =>
    has(ops, "select", "prizes(")
      ? ok({
          id: "wheel-1", title: "W", subtitle: null, brand_color: null, label_color: null, label_size: null,
          prizes: [
            { id: "a", label: "A", description: null, rarity: "common", weight: 1, color: null, emoji: null, image_url: null, cost_cents: null, stock: null, sort_order: 0 },
            { id: "b", label: "B", description: null, rarity: "rare", weight: 1, color: null, emoji: null, image_url: null, cost_cents: null, stock: null, sort_order: 1 },
          ],
        })
      : ok([{ id: "wheel-1", is_active: true, active_from: null, active_until: null, created_at: "2026-01-01T00:00:00Z" }]),
  fans: () => ok({ pity_counter: 0 }),
  happy_hours: () => ok([]),
  spins: () => ok({ id: "spin-1", share_id: "share-1" }),
  redemptions: () => ok(null),
  webhooks: () => {
    webhookReads++;
    return ok([{ url: "https://93.184.216.34/hook" }, { url: "http://127.0.0.1/internal" }]);
  },
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

async function main() {
  await mockAfter();
  const { completeClaimedSpin } = await import("./index");

  const result = await completeClaimedSpin(
    fakeClient() as unknown as Parameters<typeof completeClaimedSpin>[0],
    "tok-1",
    "seed",
    2,
  );
  check("the spin succeeds", !("error" in result));

  // Let any dangling promise make progress before looking.
  await new Promise((r) => setTimeout(r, 20));
  // Two side effects ride on after(): the webhook fan-out and the web push to
  // the creator's devices (push is OFF here: no VAPID keys, so it no-ops).
  check("the webhook fan-out and the push are each handed to after() once", scheduled.length === 2);
  check("after() receives callbacks", scheduled.every((t) => typeof t === "function"));
  check("nothing is delivered before the response (no dangling promise)", webhookReads === 0 && fetched.length === 0);

  // Next runs the callbacks once the response is sent and waits on their promises.
  const ran = (scheduled as (() => unknown)[]).map((t) => t());
  check("the scheduled callbacks return promises for Next to wait on", ran.every((r) => r instanceof Promise));
  await Promise.all(ran);
  check("running the scheduled work reads the creator's webhooks exactly once", webhookReads === 1);
  check("it delivers to the public endpoint", fetched.includes("https://93.184.216.34/hook"));
  check("the SSRF guard still refuses a private target", !fetched.some((u) => u.includes("127.0.0.1")));

  console.log(`webhookAfter.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
