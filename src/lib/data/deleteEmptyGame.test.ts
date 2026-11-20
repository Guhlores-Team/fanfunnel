import assert from "node:assert/strict";
import { mock } from "node:test";

// WC-09: "Remove it" on an abandoned empty game must never take a game that
// gained a prize since the offer. The decision is the database's
// (delete_wheel with p_only_if_empty → not_empty); the demo answers the same.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

let configured = false;
let answer: unknown = "ok";
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
const session = {
  auth: { getUser: async () => ({ data: { user: { id: "me" } }, error: null }) },
  from: () => {
    const q: Record<string, unknown> = {};
    const chain = () => q;
    Object.assign(q, { select: chain, eq: chain, is: chain, order: chain, limit: chain, update: chain, maybeSingle: async () => ({ data: { id: "w1", is_active: false }, error: null }) });
    return q;
  },
  rpc: async (name: string, args: Record<string, unknown>) => { rpcCalls.push({ name, args }); return { data: answer, error: null }; },
};
mock.module("@/lib/supabase/server", {
  namedExports: { isSupabaseConfigured: () => configured, createClient: async () => session, createServiceClient: () => { throw new Error("no service role here"); } },
});

async function main() {
  const { deleteWheel } = await import("./wheels");
  const m = await import("./mock");

  // Demo.
  const empty = m.mockCreateWheel({ name: "Empty one" }).wheel;
  const filled = m.mockCreateWheel({ name: "Filled one" }).wheel;
  m.mockSaveWheel({ ...filled, prizes: [1, 2].map((n) => ({ id: `p${n}`, label: `Prize ${n}`, rarity: "common" as const, weight: 1, emoji: "⭐", stock: null })) }, {});
  check("demo: a game with prizes is kept (not_empty)", JSON.stringify(await deleteWheel(filled.id!, { onlyIfEmpty: true })) === '{"error":"not_empty"}' && !!m.mockGetWheelById(filled.id!));
  check("demo: an empty game is removed", "ok" in (await deleteWheel(empty.id!, { onlyIfEmpty: true })) && m.mockGetWheelById(empty.id!) === null);
  check("demo: a game already gone is not_found", JSON.stringify(await deleteWheel(empty.id!, { onlyIfEmpty: true })) === '{"error":"not_found"}');
  check("demo: without the flag a filled game with no history can still be deleted on purpose", "ok" in (await deleteWheel(filled.id!)));

  // Database.
  configured = true;
  check("database: the flag is passed to delete_wheel", "ok" in (await deleteWheel("w1", { onlyIfEmpty: true })) && JSON.stringify(rpcCalls.at(-1)) === '{"name":"delete_wheel","args":{"p_wheel":"w1","p_only_if_empty":true}}');
  await deleteWheel("w1");
  check("database: a plain delete sends no flag", JSON.stringify(rpcCalls.at(-1)!.args) === '{"p_wheel":"w1"}');
  answer = "not_empty";
  check("database: not_empty is passed on", JSON.stringify(await deleteWheel("w1", { onlyIfEmpty: true })) === '{"error":"not_empty"}');
  answer = "has_history";
  check("database: has_history is passed on", JSON.stringify(await deleteWheel("w1", { onlyIfEmpty: true })) === '{"error":"has_history"}');
  answer = "not_found";
  check("database: anything else is not_found", JSON.stringify(await deleteWheel("w1", { onlyIfEmpty: true })) === '{"error":"not_found"}');
  console.log(`deleteEmptyGame: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
