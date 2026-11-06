import assert from "node:assert";
import { mock } from "node:test";
import { FakeSpinLedger, intentFor, ok } from "./fakeSpinLedger";

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

// --- the ledger, plus the creator's webhooks the fan-out reads ----------------
let webhookReads = 0;
const ledger = new FakeSpinLedger(
  [
    { id: "a", label: "A", rarity: "common", weight: 1, stock: null },
    { id: "b", label: "B", rarity: "rare", weight: 1, stock: null },
  ],
  {
    tables: {
      webhooks: () => {
        webhookReads++;
        return ok([{ url: "https://93.184.216.34/hook" }, { url: "http://127.0.0.1/internal" }]);
      },
    },
  },
);

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => ledger.client(),
    createServiceClient: () => ledger.client(),
  },
});

async function main() {
  await mockAfter();
  await ledger.init();
  const { commitSpinAttempt } = await import("./spinAttempts");

  const result = await commitSpinAttempt("tok-1", intentFor(ledger, "seed"), ledger.client());
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

  // A replayed receipt (same request id after a lost response) is served from
  // the stored receipt: the TS side schedules no fan-out for it, so a retry
  // can never deliver the same win's webhook twice.
  scheduled.length = 0;
  ledger.loseNextCommitResponse = true;
  const replayed = await commitSpinAttempt("tok-1", intentFor(ledger, "again"), ledger.client());
  check("a recovered (replayed) commit is a win", !("error" in replayed) && replayed.replayed === true);
  check("a replayed receipt schedules no webhook delivery", scheduled.length === 0);

  console.log(`webhookAfter.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
