import assert from "node:assert/strict";
import { mock } from "node:test";
const ACTOR = "a0000000-0000-4000-8000-000000000001";
const mutations: { kind: string; id: unknown }[] = [];
mock.module("@/lib/data", { namedExports: {
  createPass: async (input: Record<string, unknown>) => { mutations.push({ kind: "pass", id: input.requestId }); return { token: "synthetic-created-token", fanId: ACTOR, requestId: input.requestId ?? crypto.randomUUID() }; },
  editGrant: async (_id: string, _patch: unknown, requestId?: string) => { mutations.push({ kind: "edit", id: requestId }); return { ok: true, requestId }; },
} });
mock.module("@/lib/data/mock", { namedExports: { mockImportFans: () => { throw new Error("configured test"); } } });
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true,
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: ACTOR } }, error: null }) }, rpc: async () => ({ data: true, error: null }) }),
  createServiceClient: () => ({ rpc: async (_name: string, args: Record<string, unknown>) => {
    mutations.push({ kind: "import", id: args.p_batch });
    return { data: { status: "imported", batchId: args.p_batch, replayed: false, items: [{ ordinal: 0, fanId: ACTOR, passId: ACTOR, grantId: ACTOR, token: "synthetic-import-token" }] }, error: null };
  } }),
} });
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => null } });
let checks = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks++; };
const request = (path: string, method: string, body: unknown) => new Request(`http://localhost${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function main() {
  const passes = await import("./passes/route"), imports = await import("./fans/import/route"), edits = await import("./grants/[id]/route");
  const rows = [{ name: "HTTP intent", spins: 3 }];
  const context = { params: Promise.resolve({ id: ACTOR }) };
  const without = [await passes.POST(request("/api/passes", "POST", { name: "HTTP intent", spins: 3 })), await imports.POST(request("/api/fans/import", "POST", { rows })), await edits.PATCH(request(`/api/grants/${ACTOR}`, "PATCH", { spins: 6 }), context)];
  check("all creator financial HTTP entries refuse missing intent keys before ANY mutation", without.every(reply => reply.status === 400) && mutations.length === 0);
  for (const reply of without) check("old producers receive an explicit upgrade response", (await reply.json()).error === "upgrade_required");
  for (const invalid of [null, "invalid", "A0000000-0000-4000-8000-000000000001", 5]) {
    const before = mutations.length;
    const replies = [await passes.POST(request("/api/passes", "POST", { requestId: invalid, spins: 3 })), await imports.POST(request("/api/fans/import", "POST", { batchId: invalid, rows })), await edits.PATCH(request(`/api/grants/${ACTOR}`, "PATCH", { requestId: invalid, spins: 6 }), context)];
    check("malformed/noncanonical keys cannot reach any economic writer", replies.every(reply => reply.status === 400) && mutations.length === before);
  }
  const passId = crypto.randomUUID(), importId = crypto.randomUUID(), editId = crypto.randomUUID();
  check("valid existing pass flow still succeeds", (await passes.POST(request("/api/passes", "POST", { requestId: passId, spins: 3 }))).status === 200);
  check("valid existing import flow still succeeds", (await imports.POST(request("/api/fans/import", "POST", { batchId: importId, rows }))).status === 200);
  check("valid existing edit flow still succeeds", (await edits.PATCH(request(`/api/grants/${ACTOR}`, "PATCH", { requestId: editId, spins: 6 }), context)).status === 200);
  check("HTTP handlers forward exactly the caller's stable identities", mutations.map(entry => entry.id).join() === [passId, importId, editId].join());
  await passes.POST(request("/api/passes", "POST", { requestId: passId, spins: 3 }));
  check("an HTTP retry never replaces the supplied operation identity", mutations.at(-1)?.id === passId);
  console.log(`creator HTTP intent boundaries: ${checks} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
