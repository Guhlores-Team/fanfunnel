import assert from "node:assert/strict";
import { mock } from "node:test";
import { importRequestHash, type ImportSlot } from "@/lib/imports/batch";
const OWNER = "a0000000-0000-4000-8000-000000000001", OTHER = "b0000000-0000-4000-8000-000000000002";
let signedIn = true, configured = true, limited = false, allowed = true, targetActive = true;
let rpcCalls = 0, serviceClients = 0, lost = 0, fault = false, malformed = false, defaultWheel = "original-wheel";
const calls: Record<string, unknown>[] = [];
const people = new Map<string, { name: string; token: string; creator: string; spins: number; wheel: string }>();
const batches = new Map<string, { creator: string; hash: string; items: { ordinal: number; id?: string; error?: string }[] }>();
const output = (id: string, replayed: boolean) => ({ status: "imported", batchId: id, replayed, items: batches.get(id)!.items.map(item => {
  const person = item.id ? people.get(item.id) : null;
  return item.error ? { ordinal: item.ordinal, error: item.error } : person ? { ordinal: item.ordinal, fanId: item.id, passId: `pass-${item.id}`, grantId: `grant-${item.id}`, token: person.token } : { ordinal: item.ordinal, error: "gone" };
}) });
async function transaction(args: Record<string, unknown>) {
  rpcCalls++; calls.push(args);
  const id = String(args.p_batch), creator = String(args.p_creator), hash = String(args.p_request_hash), rows = args.p_rows as ImportSlot[];
  assert.equal(await importRequestHash(rows), hash, "route independently binds all normalized slots");
  if (!targetActive) return { data: { status: "unavailable" }, error: null };
  const prior = batches.get(id);
  if (prior) {
    if (prior.creator !== creator || prior.hash !== hash) return { data: { status: "conflict" }, error: null };
    if (lost-- > 0) throw new Error("lost committed reply");
    const data = output(id, true);
    return { data: malformed ? { ...data, items: [] } : data, error: null };
  }
  const staged = rows.map((row, ordinal) => ({ ordinal, row, id: crypto.randomUUID() }));
  if (fault) return { data: null, error: { code: "P0001", message: "PRIVATE DATABASE ERROR" } };
  const items = staged.map(({ ordinal, row, id: fanId }) => {
    if (row.error) return { ordinal, error: row.error };
    if (row.wheelId === "foreign-wheel") return { ordinal, error: "no_wheel" };
    people.set(fanId, { name: row.name, token: crypto.randomUUID(), creator, spins: row.spins, wheel: defaultWheel });
    return { ordinal, id: fanId };
  });
  batches.set(id, { creator, hash, items });
  if (lost-- > 0) throw new Error("lost committed reply");
  return { data: output(id, false), error: null };
}
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => configured,
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedIn ? { id: OWNER, user_metadata: { role: "admin" } } : null }, error: null }) }, rpc: async (_name: string, args: Record<string, unknown>) => { assert.equal(args.perm, "grant"); return { data: allowed, error: null }; } }),
  createServiceClient: () => { serviceClients++; return { rpc: async (name: string, args: Record<string, unknown>) => { assert.equal(name, "import_fans_durable"); return transaction(args); } }; },
} });
mock.module("@/lib/data/mock", { namedExports: { mockImportFans: async (id: string, hash: string, rows: ImportSlot[]) => (await transaction({ p_batch: id, p_creator: OWNER, p_request_hash: hash, p_rows: rows })).data } });
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => limited ? Response.json({ error: "rate_limited" }, { status: 429 }) : null } });
let checks = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks++; };
const request = (body: unknown) => new Request("http://localhost/api/fans/import", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
async function main() {
  const { POST } = await import("./route");
  const rows = [{ name: "PRIVATE CSV A", spins: 3, amountCents: 100 }, { name: "", spins: 1 }, { name: "PRIVATE CSV B", spins: 2 }];
  signedIn = false;
  check("signed-out imports fail before privileged work", (await POST(request({ batchId: crypto.randomUUID(), rows }))).status === 401 && serviceClients === 0);
  signedIn = true; allowed = false;
  check("pending/rejected or ordinary unauthorized actors cannot promote through metadata", (await POST(request({ batchId: crypto.randomUUID(), rows }))).status === 403 && serviceClients === 0);
  check("an unauthorized foreign creator target is refused before service access", (await POST(request({ batchId: crypto.randomUUID(), rows, creatorId: OTHER }))).status === 403 && serviceClients === 0);
  allowed = true; limited = true;
  check("rate limits remain enforced before writes", (await POST(request({ batchId: crypto.randomUUID(), rows }))).status === 429 && serviceClients === 0);
  limited = false;
  for (const body of [null, [], { rows: [] }, { rows: [{}], batchId: "bad" }, { rows: [{}], creatorId: "bad" }, { rows: Array.from({ length: 501 }, () => ({ name: "No", spins: 1 })) }]) check("invalid request shape/keys/size create nothing", (await POST(request(body))).status === 400 && serviceClients === 0);
  const beforeMissing = serviceClients;
  const missing = await POST(request({ rows }));
  check("missing batchId cannot create an unrepeatable import", missing.status === 400 && (await missing.json()).error === "upgrade_required" && serviceClients === beforeMissing);
  const id = crypto.randomUUID();
  let response = await POST(request({ batchId: id, rows }));
  const first = await response.json();
  check("valid subset commits once and failed slots preserve input order", response.status === 200 && first.created === 2 && first.failed === 1 && first.results[1].error === "missing_name" && people.size === 2);
  check("actor and creator bindings come from authenticated session context", calls.at(-1)?.p_actor === OWNER && calls.at(-1)?.p_creator === OWNER);
  check("downloads of returned bearer links are never cacheable", /no-store/.test(response.headers.get("cache-control") ?? ""));
  response = await POST(request({ batchId: id, rows }));
  const replay = await response.json();
  check("identical HTTP replay returns original links without creating duplicates", replay.replayed && replay.results[0].token === first.results[0].token && people.size === 2);
  check("changed content under the same batch key is a conflict", (await POST(request({ batchId: id, rows: [{ name: "Changed", spins: 9 }] }))).status === 409 && people.size === 2);
  check("same batch key cannot leak a different creator's links", (await POST(request({ batchId: id, creatorId: OTHER, rows }))).status === 409 && people.size === 2);
  const agencyId = crypto.randomUUID();
  response = await POST(request({ batchId: agencyId, creatorId: OTHER, rows: [{ name: "Agency fan", spins: 1 }] }));
  check("a grant-authorized agency operator imports to the actual target", response.status === 200 && calls.at(-1)?.p_creator === OTHER && calls.at(-1)?.p_actor === OWNER && [...people.values()].some(person => person.creator === OTHER));
  targetActive = false;
  const beforeInactive = people.size;
  check("DB target inactivity/approval refusal creates no import rows", (await POST(request({ batchId: crypto.randomUUID(), rows }))).status === 403 && people.size === beforeInactive);
  targetActive = true;
  const beforeInvalid = people.size;
  const invalid = await (await POST(request({ batchId: crypto.randomUUID(), rows: [{ name: "Overflow", spins: 1_000_001 }, { name: "Decimal", spins: 1.5 }, { name: "Money overflow", spins: 1, amountCents: 100_000_001 }] }))).json();
  check("overflow/invalid slots never create fans or spendable credit", invalid.created === 0 && invalid.failed === 3 && people.size === beforeInvalid);
  const failureId = crypto.randomUUID(), beforeFault = people.size;
  fault = true;
  response = await POST(request({ batchId: failureId, rows }));
  check("unexpected transaction failure publishes no partial subset", response.status === 503 && people.size === beforeFault && !batches.has(failureId));
  check("database diagnostics never enter public responses", !JSON.stringify(await response.json()).includes("PRIVATE DATABASE ERROR"));
  fault = false;
  check("the same batch safely retries a wholly rolled-back attempt", (await POST(request({ batchId: failureId, rows }))).status === 200 && people.size === beforeFault + 2);
  const lostId = crypto.randomUUID(), beforeLost = people.size;
  lost = 1;
  const recovered = await (await POST(request({ batchId: lostId, rows }))).json();
  check("reply lost after commit is recovered with one unchanged batch key", recovered.replayed && people.size === beforeLost + 2 && calls.slice(-2).every(call => call.p_batch === lostId) && JSON.stringify(calls.at(-1)) === JSON.stringify(calls.at(-2)));
  const unknownId = crypto.randomUUID(); lost = 2;
  response = await POST(request({ batchId: unknownId, rows }));
  const afterUnknown = people.size;
  check("an unresolved committed outcome is marked pending rather than falsely failed", response.status === 503 && (await response.json()).error === "import_pending" && batches.has(unknownId));
  lost = 0; defaultWheel = "changed-default";
  const late = await (await POST(request({ batchId: unknownId, rows }))).json();
  check("later retry survives mutable defaults and never duplicates the committed batch", late.replayed && people.size === afterUnknown && batches.get(unknownId)!.items.filter(item => item.id).every(item => people.get(item.id!)?.wheel === "original-wheel"));
  malformed = true;
  check("a malformed/partial backend receipt cannot be called complete", (await POST(request({ batchId: unknownId, rows }))).status === 503);
  malformed = false;
  const deletedId = batches.get(id)!.items[0].id!; people.delete(deletedId);
  const beforeErased = people.size;
  const erased = await (await POST(request({ batchId: id, rows }))).json();
  check("replay after erasure returns gone without resurrecting private data", erased.results[0].error === "gone" && !erased.results[0].token && people.size === beforeErased);
  check("batch metadata stores no names or bearer tokens", !JSON.stringify([...batches]).includes("PRIVATE CSV") && !JSON.stringify([...batches]).includes(first.results[0].token));
  configured = false;
  const demo = await POST(request({ batchId: crypto.randomUUID(), rows }));
  check("demo transport uses the identical complete batch result contract", demo.status === 200 && (await demo.json()).failed === 1);
  check("all service calls use a validated normalized intent binding", rpcCalls > 10 && calls.every(call => typeof call.p_request_hash === "string" && /^[a-f0-9]{64}$/.test(String(call.p_request_hash))));
  console.log(`durable import route: ${checks} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
