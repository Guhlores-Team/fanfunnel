import assert from "node:assert/strict";
import { mock } from "node:test";
let calls = 0;
let captured: Record<string, unknown> | null = null;
let failure: string | null = null;
mock.module("@/lib/data", { namedExports: { createPass: async (input: Record<string, unknown>) => {
  calls++; captured = input;
  return failure ? { error: failure } : { token: "created-token", fanId: "created-fan", requestId: input.requestId ?? "server-generated-key" };
} } });
let passed = 0;
const check = (label: string, value: unknown) => { assert.ok(value, label); passed++; };
const request = (body: unknown) => new Request("http://localhost/api/passes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function main() {
  const { POST } = await import("./route");
  for (const body of [null, [], "text", 42, { requestId: "not-a-uuid" }, { requestId: 5 }, { requestId: null }, { requestId: crypto.randomUUID(), packUnits: 0 }, { requestId: crypto.randomUUID(), packUnits: 1.5 }, { requestId: crypto.randomUUID(), packUnits: 1_000_001 }, { requestId: crypto.randomUUID(), packUnits: "3" }]) {
    const response = await POST(request(body));
    check("invalid bodies and operation keys fail before creating a pass", response.status === 400 && calls === 0);
  }
  const id = crypto.randomUUID();
  let response = await POST(request({ requestId: id, name: "Fan", spins: 3, amountDollars: 2.5, bonusSpins: 1, packId: "stored-pack", packUnits: 3 }));
  check("durable operation identity is forwarded and returned intact", response.status === 200 && (await response.json()).requestId === id && captured?.requestId === id);
  check("pricing conversion and existing grant fields remain intact", captured?.spins === 3 && captured?.amountCents === 250 && captured?.bonusSpins === 1 && captured?.packUnits === 3);
  response = await POST(request({ requestId: id, name: "Fan", spins: 3 }));
  check("HTTP retries pass the same key rather than replacing it", response.status === 200 && captured?.requestId === id);
  failure = "conflict";
  response = await POST(request({ requestId: id, name: "Changed", spins: 4 }));
  check("a changed intent is reported as conflict", response.status === 409 && (await response.json()).error === "conflict");
  failure = "on_break";
  response = await POST(request({ requestId: crypto.randomUUID(), spins: 1 }));
  check("F6 refusal remains a forbidden response", response.status === 403);
  failure = null;
  const emptyPassKey = crypto.randomUUID();
  response = await POST(request({ requestId: emptyPassKey, name: "Existing zero-spin flow", spins: 0 }));
  check("existing zero-spin creation stays available with its caller intent", response.status === 200 && (await response.json()).requestId === emptyPassKey);
  const beforeMissing = calls;
  response = await POST(request({ name: "Outdated producer", spins: 3 }));
  check("missing requestId is an explicit upgrade refusal with no data-layer write", response.status === 400 && (await response.json()).error === "upgrade_required" && calls === beforeMissing);
  const beforeMalformed = calls;
  response = await POST(new Request("http://localhost/api/passes", { method: "POST", body: "{" }));
  check("malformed JSON fails without invoking creation", response.status === 400 && calls === beforeMalformed);
  console.log(`pass creation route: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
