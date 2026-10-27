import assert from "node:assert";
import { mock } from "node:test";

// AUTH-SENSITIVE (AGENTS.md rules 5/7): POST /api/crm/outreach logs a win-back
// contact or snooze (RM-5) into fan_outreach (migration 0051).
//
// Negative tests: a signed-out caller gets 401 and nothing is written; the row
// is always written as the SIGNED-IN creator, whatever creator/user id the body
// names; a fan the insert policy refuses (another creator's) reads as 404, never
// a raw database message; a bad action never reaches the database; the route
// never touches the service role; and the CRM read of the log is filtered to the
// signed-in creator. The runtime half (Postgres refuses creator A's insert for
// B's fan, under B's id or with B's template, and A reads none of B's rows) is
// in scripts/db/schema-drift-check.mjs and scripts/security/rls-runtime-test.mjs.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

type Call = { table: string; op: string; payload?: unknown; filters: [string, unknown][] };
const calls: Call[] = [];
let configured = true;
let user: { id: string } | null = null;
let insertError: { code: string; message: string } | null = null;

function builder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  calls.push(call);
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") {
          return (res: (v: unknown) => unknown) =>
            Promise.resolve(call.op === "insert" ? { data: null, error: insertError } : { data: [], error: null }).then(res);
        }
        if (prop === "insert") {
          return (payload: unknown) => {
            call.op = "insert";
            call.payload = payload;
            return proxy;
          };
        }
        if (prop === "eq") {
          return (col: string, val: unknown) => {
            call.filters.push([col, val]);
            return proxy;
          };
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

const client = {
  auth: { getUser: async () => ({ data: { user }, error: null }) },
  from: (table: string) => builder(table),
};

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createClient: async () => client,
    createServiceClient: () => {
      throw new Error("the outreach route must never use the service role");
    },
  },
});

const FAN_A = "11111111-1111-4111-8111-111111111111";
const FAN_B = "22222222-2222-4222-8222-222222222222";
const TPL = "33333333-3333-4333-8333-333333333333";

async function main() {
  const { POST } = await import("./route");
  const post = async (body: unknown) => {
    const res = await POST(
      new Request("http://localhost/api/crm/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const inserts = () => calls.filter((c) => c.op === "insert");

  // --- 1. Signed out → 401, nothing written ----------------------------------
  user = null;
  for (const action of ["contacted", "snoozed"]) {
    const r = await post({ fanId: FAN_A, action });
    check(`signed out ${action} → 401`, r.status === 401 && r.data.error === "unauthorized");
  }
  check("signed out → no insert", inserts().length === 0);

  // --- 2. Validation never reaches the database ------------------------------
  user = { id: "creator-a" };
  for (const bad of [{ fanId: FAN_A, action: "sent" }, { fanId: FAN_A }, { action: "contacted" }, { fanId: 7, action: "contacted" }, { fanId: FAN_A, action: "contacted", templateId: 5 }]) {
    const r = await post(bad);
    check(`${JSON.stringify(bad)} → 400`, r.status === 400);
  }
  check("malformed JSON → 400", (await post("{nope")).status === 400);
  check("invalid input → no insert", inserts().length === 0);
  check("a non-uuid fan id → 404 without a write", (await post({ fanId: "fan-x", action: "contacted" })).status === 404 && inserts().length === 0);

  // --- 3. Signed in: the row is the signed-in creator's ----------------------
  {
    const r = await post({ fanId: FAN_A, action: "contacted", templateId: TPL, creatorId: "creator-b", creator_id: "creator-b", userId: "creator-b" });
    check("contacted → 200", r.status === 200 && r.data.ok === true);
    const row = inserts().at(-1)!;
    const p = row.payload as Record<string, unknown>;
    check("writes fan_outreach", row.table === "fan_outreach");
    check("creator_id is the signed-in creator, never the body's", p.creator_id === "creator-a");
    check("contacted sets contacted_at, not snoozed_until", typeof p.contacted_at === "string" && p.snoozed_until === null);
    check("kind is winback", p.kind === "winback");
    check("a saved template id is kept", p.template_id === TPL);
    check("the response leaks nothing else", JSON.stringify(Object.keys(r.data)) === JSON.stringify(["ok"]));
  }
  {
    const r = await post({ fanId: FAN_A, action: "snoozed", templateId: "winback-default" });
    const p = inserts().at(-1)!.payload as Record<string, unknown>;
    check("snoozed → 200", r.status === 200);
    check("snoozed sets snoozed_until ~30 days out, not contacted_at", p.contacted_at === null && Date.parse(String(p.snoozed_until)) - Date.now() > 29 * 86_400_000);
    check("the built-in template (no uuid) is stored as null", p.template_id === null);
  }

  // --- 4. Another creator's fan: the insert policy refuses → 404 -------------
  insertError = { code: "42501", message: 'new row violates row-level security policy for table "fan_outreach"' };
  {
    const r = await post({ fanId: FAN_B, action: "contacted" });
    check("another creator's fan → 404 not_found", r.status === 404 && r.data.error === "not_found");
    check("no database text in the response", !JSON.stringify(r.data).includes("row-level"));
  }
  insertError = { code: "23503", message: "fk" };
  check("an unknown fan → 404", (await post({ fanId: FAN_B, action: "contacted" })).status === 404);
  insertError = null;

  // --- 5. The CRM's read of the log is scoped to the signed-in creator -------
  {
    const { getCreatorCrm } = await import("@/lib/data");
    calls.length = 0;
    await getCreatorCrm();
    const read = calls.find((c) => c.table === "fan_outreach");
    check("getCreatorCrm reads the outreach log", !!read && read.op === "select");
    check("…filtered to creator_id = the signed-in creator", !!read?.filters.some(([c, v]) => c === "creator_id" && v === "creator-a"));
  }

  // --- 6. Demo mode: same validation, in-memory log ---------------------------
  configured = false;
  user = null;
  calls.length = 0;
  check("demo: an unknown fan → 404", (await post({ fanId: "no-such-fan", action: "contacted" })).status === 404);
  check("demo: bad action → 400", (await post({ fanId: "demo-fan", action: "sent" })).status === 400);
  check("demo: the demo fan → 200", (await post({ fanId: "demo-fan", action: "snoozed" })).status === 200);
  check("demo: never touches Supabase", calls.length === 0);

  console.log(`crm/outreach route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
