import assert from "node:assert";
import { mock } from "node:test";
import { FakeSpinLedger, intentFor, ok, has, type Op } from "@/lib/data/fakeSpinLedger";

// Integration (Supabase path, `web-push` mocked): a committed spin win pushes
// to the creator's devices exactly once per active device, and only AFTER the
// response (handed to Next's after(), F7), so a slow push service can't delay
// or break the spin. The creator id is the committed context's, never input.

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

const deviceQueries: Op[][] = [];
const ledger = new FakeSpinLedger([{ id: "a", label: "A", rarity: "common", weight: 1, stock: null }], {
  tables: {
    // The push engagement gate reads the fan's passes (none paused) and fans row (not blocked).
    fan_passes: () => ok([{ self_excluded_at: null }]),
    fans: () => ok({ blocked_at: null }),
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
  },
});

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => ledger.client(),
    createServiceClient: () => ledger.client(),
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
    setVapidDetails: () => {},
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
  await ledger.init();
  const { commitSpinAttempt } = await import("@/lib/data/spinAttempts");
  const result = await commitSpinAttempt("tok-1", intentFor(ledger, "seed"), ledger.client());
  check("the spin succeeds", !("error" in result));
  await new Promise((r) => setTimeout(r, 20));
  check("webhooks + push are both scheduled with after()", scheduled.length === 2);
  check("nothing pushed before the response", sends.length === 0 && deviceQueries.length === 0);

  await Promise.all(scheduled.map((t) => t()));
  check("exactly one push per active device", sends.length === 2 && new Set(sends.map((s) => s.endpoint)).size === 2);
  check("the feed was built for the committed context's creator", loadedFor.join() === "creator-1");
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
