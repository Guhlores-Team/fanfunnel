import assert from "node:assert";
import { mock } from "node:test";
import { createHmac } from "node:crypto";

// A16: webhooks honour the subscribed event, are capped per creator, carry a
// verifiable X-FanFunnel-Signature made with the creator's own server-only
// secret, and the secret route is creator-only (can_act_for 'manage').

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// fetch spy: every hook here is an IP-literal URL (pinned trivially).
const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
  return new Response(null, { status: 204 });
}) as typeof fetch;

type Op = { name: string; args: unknown[] };
const queries: { table: string; ops: Op[] }[] = [];
const SECRET = "a".repeat(64);
let signedIn = true;
let canManage = true;
let insertError: { code: string } | null = null;
let hookCount = 0;
const serviceUses: string[] = [];
function client(kind: "session" | "service") {
  return {
    from(table: string) {
      if (kind === "service") serviceUses.push(table);
      const q = { table, ops: [] as Op[] };
      queries.push(q);
      const result = () => {
        if (table === "webhooks" && q.ops.some((o) => o.name === "select" && (o.args[1] as { head?: boolean })?.head)) return { data: null, error: null, count: hookCount };
        if (table === "webhooks" && q.ops.some((o) => o.name === "insert")) {
          return insertError ? { data: null, error: insertError } : { data: { id: "w1", url: "https://93.184.216.34/x", event: "all", created_at: "now" }, error: null };
        }
        if (table === "webhooks") return { data: [{ url: "https://93.184.216.34/a" }, { url: "http://10.0.0.8/internal" }], error: null };
        if (table === "webhook_secrets") return { data: { secret: SECRET }, error: null };
        return { data: null, error: null };
      };
      const proxy: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") return (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok);
            if (prop === "single" || prop === "maybeSingle") return () => Promise.resolve(result());
            return (...args: unknown[]) => {
              q.ops.push({ name: prop, args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== "can_act_for") throw new Error(`unexpected rpc ${name}`);
      check("the secret check is on the caller's own account with 'manage'", args.target_creator === "creator-1" && args.perm === "manage");
      return { data: canManage, error: null };
    },
    auth: { getUser: async () => ({ data: { user: signedIn ? { id: "creator-1" } : null }, error: null }) },
  };
}
let useSupabase = true;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createClient: async () => client("session"),
    createServiceClient: () => client("service"),
  },
});

async function main() {
  const wh = await import("./webhooks");
  const { GET: getSecret, POST: rotateSecret } = await import("@/app/api/webhooks/secret/route");
  const { POST: createRoute } = await import("@/app/api/webhooks/route");

  // --- delivery: event filter, cap, signature -----------------------------------
  await wh.fireWebhooks("creator-1", { event: "prize_delivered", prize: "Code", rarity: "rare", at: "t" });
  const hookQuery = queries.find((q) => q.table === "webhooks" && q.ops.some((o) => o.name === "in"));
  const inOp = hookQuery?.ops.find((o) => o.name === "in");
  check("only hooks for this event (or 'all') are read", inOp?.args[0] === "event" && JSON.stringify(inOp?.args[1]) === '["prize_delivered","all"]');
  check("at most WEBHOOK_LIMIT hooks per delivery", hookQuery?.ops.some((o) => o.name === "limit" && o.args[0] === wh.WEBHOOK_LIMIT) === true);
  check("the public hook received it", sent.length === 1 && sent[0].url === "https://93.184.216.34/a");
  check("the private hook was refused at fire time", !sent.some((s) => s.url.includes("10.0.0.8")));
  const h = sent[0].headers;
  const body = sent[0].body;
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(h["X-FanFunnel-Signature"] ?? "");
  check("signed with t=…,v1=…", !!m);
  check("the signature verifies with the creator's secret", !!m && createHmac("sha256", SECRET).update(`${m[1]}.${body}`).digest("hex") === m[2]);
  const parsed = JSON.parse(body) as { id?: string; event?: string };
  check("the body carries a delivery id to dedupe on", typeof parsed.id === "string" && parsed.id === h["X-FanFunnel-Delivery"]);
  check("the event is in a header and the body", h["X-FanFunnel-Event"] === "prize_delivered" && parsed.event === "prize_delivered");
  check("the body never carries fan data", !/fan|token/i.test(body));

  // --- create: event, cap -----------------------------------------------------------
  check("an unknown event is refused", JSON.stringify(await wh.createWebhook("https://93.184.216.34/x", "everything")) === '{"error":"invalid_event"}');
  check("a private URL is refused", JSON.stringify(await wh.createWebhook("http://169.254.169.254/latest", "all")) === '{"error":"blocked_url"}');
  hookCount = wh.WEBHOOK_LIMIT;
  check("the sixth hook is refused", JSON.stringify(await wh.createWebhook("https://93.184.216.34/x", "all")) === '{"error":"webhook_limit"}');
  hookCount = 0;
  insertError = { code: "23514" };
  check("a racing insert stopped by the cap trigger reads as the limit", JSON.stringify(await wh.createWebhook("https://93.184.216.34/x", "all")) === '{"error":"webhook_limit"}');
  insertError = null;
  check("a valid hook is created", "id" in (await wh.createWebhook("https://93.184.216.34/x", "prize_pending")));
  const post = async (b: unknown) => (await createRoute(new Request("http://localhost/api/webhooks", { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.7" }, body: JSON.stringify(b) }))).status;
  check("route: unknown event → 400", (await post({ url: "https://93.184.216.34/x", event: "nope" })) === 400);
  check("route: valid → 200", (await post({ url: "https://93.184.216.34/x", event: "all" })) === 200);

  // --- secret route: negative first ---------------------------------------------------
  serviceUses.length = 0;
  signedIn = false;
  check("signed out: secret → 401", (await getSecret(new Request("http://localhost/"))).status === 401);
  check("signed out: rotate → 401", (await rotateSecret(new Request("http://localhost/"))).status === 401);
  signedIn = true;
  canManage = false;
  check("no 'manage' (e.g. suspended): secret → 403", (await getSecret(new Request("http://localhost/"))).status === 403);
  check("no 'manage': rotate → 403", (await rotateSecret(new Request("http://localhost/"))).status === 403);
  check("refused callers never reached the service role", serviceUses.length === 0);
  canManage = true;
  const res = await getSecret(new Request("http://localhost/"));
  const json = (await res.json()) as { secret?: string };
  check("the creator reads their secret", res.status === 200 && json.secret === SECRET && res.headers.get("cache-control")?.includes("no-store") === true);
  queries.length = 0;
  check("rotate → 200", (await rotateSecret(new Request("http://localhost/"))).status === 200);
  const upsert = queries.find((q) => q.table === "webhook_secrets" && q.ops.some((o) => o.name === "upsert"))?.ops.find((o) => o.name === "upsert");
  const row = upsert?.args[0] as { creator_id?: string; secret?: string } | undefined;
  check("rotation writes a fresh 64-hex secret for the caller only", row?.creator_id === "creator-1" && /^[0-9a-f]{64}$/.test(row?.secret ?? "") && row?.secret !== SECRET);

  // --- demo path cap ---------------------------------------------------------------------
  useSupabase = false;
  for (let i = 0; i < wh.WEBHOOK_LIMIT; i++) await wh.createWebhook(`https://93.184.216.34/demo${i}`, "all");
  check("demo: the cap holds", JSON.stringify(await wh.createWebhook("https://93.184.216.34/demo-extra", "all")) === '{"error":"webhook_limit"}');
  const demoSecret = (await wh.getWebhookSecret()) as { secret: string };
  check("demo: a secret exists and rotates", /^[0-9a-f]{64}$/.test(demoSecret.secret) && ((await wh.getWebhookSecret({ rotate: true })) as { secret: string }).secret !== demoSecret.secret);

  console.log(`webhookDelivery.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
