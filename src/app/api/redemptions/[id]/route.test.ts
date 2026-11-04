import assert from "node:assert";
import { mock } from "node:test";

// A14: a refused fulfilment change must reach the queue as a reason it can
// show, not a generic 400. The instant-reward trigger raises 23514 "already
// delivered" when a creator reopens or re-dates an Auto win; the route answers
// 409 { error: "already_delivered" } so PrizesPanel can roll back and say why.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

let useSupabase = true;
let signedIn = true;
let nextResult: { data: unknown; error: { code: string; message: string } | null } = { data: { id: "r1" }, error: null };
const updates: Record<string, unknown>[] = [];

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: signedIn ? { id: "creator-1" } : null }, error: null }) },
      from: () => {
        const chain = {
          update: (u: Record<string, unknown>) => {
            updates.push(u);
            return chain;
          },
          eq: () => chain,
          select: () => chain,
          maybeSingle: async () => nextResult,
        };
        return chain;
      },
    }),
    createServiceClient: () => {
      throw new Error("the fulfilment route must not use the service role");
    },
  },
});

async function main() {
  const { PATCH } = await import("./route");
  const call = (body: unknown, id = "r1") =>
    PATCH(new Request("http://x/api/redemptions/" + id, { method: "PATCH", body: JSON.stringify(body) }), {
      params: Promise.resolve({ id }),
    });

  nextResult = { data: null, error: { code: "23514", message: "reward already delivered: status is fixed" } };
  let res = await call({ status: "pending" });
  check("already delivered (status) is 409", res.status === 409);
  check("already delivered body names the reason", (await res.json()).error === "already_delivered");

  res = await call({ dueAt: "2026-12-01" });
  check("already delivered (due date) is 409 already_delivered", res.status === 409 && (await res.json()).error === "already_delivered");

  nextResult = { data: null, error: { code: "23514", message: "some other check constraint" } };
  res = await call({ status: "pending" });
  check("an unrelated constraint stays a generic db_error", res.status === 400 && (await res.json()).error === "db_error");

  nextResult = { data: null, error: null };
  res = await call({ status: "fulfilled" });
  check("another creator's / missing row is 404", res.status === 404 && (await res.json()).error === "not_found");

  signedIn = false;
  res = await call({ status: "fulfilled" });
  check("signed out is 401", res.status === 401);
  signedIn = true;

  nextResult = { data: { id: "r1" }, error: null };
  const before = updates.length;
  res = await call({ status: "bogus" });
  check("an invalid status is 400 before any write", res.status === 400 && updates.length === before);
  res = await call({ status: "fulfilled", notes: "shipped" });
  check("a valid patch is 200", res.status === 200);
  const last = updates[updates.length - 1];
  check("status + notes go in one atomic update", last.status === "fulfilled" && last.notes === "shipped" && typeof last.fulfilled_at === "string");

  // Demo path: data-layer errors use the shared status mapping.
  useSupabase = false;
  res = await call({ status: "fulfilled" }, "no-such-redemption");
  check("demo: unknown redemption is 404 not_found", res.status === 404 && (await res.json()).error === "not_found");

  console.log(`redemption PATCH route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
