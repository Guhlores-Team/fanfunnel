import assert from "node:assert/strict";
import { mock } from "node:test";
let remoteClients = 0;
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => false,
  createClient: async () => { remoteClients++; throw new Error("remote forbidden in demo test"); },
  createServiceClient: () => { remoteClients++; throw new Error("remote forbidden in demo test"); },
} });
let checks = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks++; };
async function main() {
  const { PATCH } = await import("./route");
  const { mockCreatePass, mockGetFanDetail, mockGetFanPass, mockEditGrant } = await import("@/lib/data/mock");
  const fan = mockCreatePass("Demo edit parity", 10), detail = mockGetFanDetail(fan.fanId);
  assert.ok(detail);
  const id = detail.grants[0].id;
  const send = (body: unknown) => PATCH(new Request("http://localhost/api/grants/test", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  const original = { requestId: crypto.randomUUID(), spins: 20, amountCents: 200 };
  let response = await send(original), result = await response.json();
  check("actual demo PATCH emits exactly the configured safe receipt keys", response.status === 200 && Object.keys(result).sort().join() === "grantId,ok,replayed,requestId");
  check("demo receipt preserves identity and no-store", result.requestId === original.requestId && result.grantId === id && result.replayed === false && response.headers.get("cache-control") === "no-store");
  check("demo edit applies the intended accounting change", (await mockGetFanPass(fan.token))?.spinsRemaining === 20);
  await send({ requestId: crypto.randomUUID(), spins: 12, amountCents: 120 });
  response = await send(original); result = await response.json();
  check("demo late replay retains the safe shape and does not reapply old terms", response.status === 200 && result.replayed === true && Object.keys(result).sort().join() === "grantId,ok,replayed,requestId" && (await mockGetFanPass(fan.token))?.spinsRemaining === 12);
  const trusted = mockEditGrant(id, { amountCents: 130 }, crypto.randomUUID());
  check("trusted direct mock helper retains current accounting detail", "ok" in trusted && trusted.grant.spins === 12 && trusted.grant.amountCents === 130 && trusted.spinsRemaining === 12);
  check("mock route parity requires no privileged remote client", remoteClients === 0);
  console.log(`demo grant edit HTTP parity: ${checks} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
