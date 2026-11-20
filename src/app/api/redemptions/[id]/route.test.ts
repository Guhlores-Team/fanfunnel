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
const R1 = "11111111-2222-4333-8444-555555555555";
let nextResult: { data: unknown; error: { code: string; message: string } | null } = { data: { status: "ok", stock: "none" }, error: null };
// 0067: every connected write is ONE set_redemption_state call on the caller's session.
const writes: { name: string; args: Record<string, unknown> }[] = [];

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: signedIn ? { id: "creator-1" } : null }, error: null }) },
      rpc: async (name: string, args: Record<string, unknown>) => {
        writes.push({ name, args });
        return nextResult;
      },
      from: () => {
        throw new Error("the fulfilment route must not write the redemptions table directly (0067)");
      },
    }),
    createServiceClient: () => {
      throw new Error("the fulfilment route must not use the service role");
    },
  },
});

async function main() {
  const { PATCH } = await import("./route");
  const call = (body: unknown, id = R1) =>
    PATCH(new Request("http://x/api/redemptions/" + id, { method: "PATCH", body: JSON.stringify(body) }), {
      params: Promise.resolve({ id }),
    });

  nextResult = { data: null, error: { code: "23514", message: "reward already delivered: status is fixed" } };
  let res = await call({ status: "pending" });
  check("already delivered (status) is 409", res.status === 409);
  check("already delivered body names the reason", (await res.json()).error === "already_delivered");

  const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  res = await call({ dueAt: soon });
  check("already delivered (due date) is 409 already_delivered", res.status === 409 && (await res.json()).error === "already_delivered");

  // RD-06: a half-typed year or a date outside today − 1 y … + 10 y is refused before any write.
  for (const bad of ["0026-12-25", "0002-12-25", "1999-01-01", "2099-01-01", "2026-13-01", "next week"]) {
    res = await call({ dueAt: bad });
    check(`due date ${bad} is 400 bad_due_date`, res.status === 400 && (await res.json()).error === "bad_due_date");
  }

  nextResult = { data: null, error: { code: "23514", message: "some other check constraint" } };
  res = await call({ status: "pending" });
  check("an unrelated constraint stays a generic db_error", res.status === 400 && (await res.json()).error === "db_error");

  nextResult = { data: { status: "not_found" }, error: null };
  res = await call({ status: "fulfilled" });
  check("another creator's / missing row is 404", res.status === 404 && (await res.json()).error === "not_found");

  nextResult = { data: { status: "forbidden" }, error: null };
  res = await call({ status: "cancelled" });
  check("a caller the RPC refuses is 403 forbidden", res.status === 403 && (await res.json()).error === "forbidden");

  nextResult = { data: { status: "sold_out" }, error: null };
  res = await call({ status: "pending" });
  check("reopening a prize with no unit left is 409 sold_out", res.status === 409 && (await res.json()).error === "sold_out");

  nextResult = { data: { status: "ok", stock: "returned" }, error: null };
  res = await call({ status: "cancelled" });
  check("a cancel that returned a limited unit says so", res.status === 200 && (await res.json()).stock === "returned");

  const beforeBad = writes.length;
  res = await call({ status: "cancelled" }, "not-a-uuid");
  check("a malformed id is 404 before any write", res.status === 404 && writes.length === beforeBad);

  signedIn = false;
  res = await call({ status: "fulfilled" });
  check("signed out is 401", res.status === 401);
  signedIn = true;

  nextResult = { data: { status: "ok", stock: "none" }, error: null };
  const before = writes.length;
  res = await call({ status: "bogus" });
  check("an invalid status is 400 before any write", res.status === 400 && writes.length === before);
  res = await call({ status: "fulfilled", notes: "shipped" });
  check("a valid patch is 200", res.status === 200);
  const last = writes[writes.length - 1];
  const sent = last.args.p_patch as Record<string, unknown>;
  check("status + notes go in one atomic write", writes.length === before + 1 && last.name === "set_redemption_state" && sent.status === "fulfilled" && sent.notes === "shipped" && Object.keys(sent).length === 2);
  check("the write names the redemption and the acting creator", last.args.p_redemption === R1 && last.args.p_creator === "creator-1");
  res = await call({ dueAt: null });
  check("a due-date clear is sent as due_at null", res.status === 200 && (writes.at(-1)!.args.p_patch as Record<string, unknown>).due_at === null);

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
