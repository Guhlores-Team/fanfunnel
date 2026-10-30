import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { requireTestProject, requireLocalTestServer, createFixturePass, commitSinglePrizeFixture } from "../../../e2e/economic-fixtures.mjs";

async function main() {
  let passed = 0;
  const check = (label: string, condition: unknown) => { assert.ok(condition, label); passed++; };
  for (const url of ["https://ttlogfmogcccwiraaoae.supabase.co", "https://elsewhere.supabase.co", "http://snmcrmhgevfqggxdiomu.supabase.co", "https://snmcrmhgevfqggxdiomu.supabase.co.evil.test", "https://key@snmcrmhgevfqggxdiomu.supabase.co", "https://snmcrmhgevfqggxdiomu.supabase.co:8443"]) {
    assert.throws(() => requireTestProject(url), /Refusing fixture/); passed++;
  }
  requireTestProject("https://snmcrmhgevfqggxdiomu.supabase.co"); passed++;
  for (const origin of [undefined, "https://fanfunnel.vercel.app", "http://127.0.0.1.evil.test:3202", "http://localhost:3202/unsafe", "http://key@localhost:3202", "http://localhost:3202/?project=prod"]) {
    assert.throws(() => requireLocalTestServer(origin)); passed++;
  }
  check("configured local origin is preserved", requireLocalTestServer("http://127.0.0.1:3202") === "http://127.0.0.1:3202");
  let rpcCalls = 0;
  let approved = true;
  const actorId = randomUUID();
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const admin = {
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { is_active: true, approval_status: approved ? "approved" : "pending", role: "creator" }, error: null }) }) }) }),
    rpc: async (name: string, args: Record<string, unknown>) => { rpcCalls++; calls.push({ name, args }); return { data: { status: "granted" }, error: null }; },
  };
  const impostor = { id: actorId, client: { auth: { getUser: async () => ({ data: { user: { id: randomUUID() } }, error: null }) } } };
  await assert.rejects(() => createFixturePass(admin, impostor, { wheelId: randomUUID(), spins: 5 }), /authenticated creator/); passed++;
  check("mismatched authenticated actor never reaches economic RPC", rpcCalls === 0);
  const actor = { id: actorId, client: { auth: { getUser: async () => ({ data: { user: { id: actorId } }, error: null }) } } };
  approved = false;
  await assert.rejects(() => createFixturePass(admin, actor, { wheelId: randomUUID(), spins: 5 }), /approved, active/); passed++;
  check("pending fixture creator never reaches economic RPC", rpcCalls === 0);
  approved = true;
  const requestId = randomUUID();
  await createFixturePass(admin, actor, { wheelId: randomUUID(), spins: 5, requestId });
  check("service grant binds the actual actor explicitly", calls[0].args.p_actor === actorId && calls[0].args.p_creator === actorId);
  check("provided durable identity is preserved", calls[0].args.p_request === requestId);

  const prize = { id: randomUUID(), label: "Only fixture prize", emoji: null, rarity: "common", weight: 10, stock: null, delivery: "manual", image_url: null };
  const ctx = { contextHash: "context1", fanId: randomUUID(), passId: randomUUID(), creatorId: actorId, wheelId: randomUUID(), campaignId: null,
    serverSeed: "1".repeat(64), serverSeedHash: "2".repeat(64), nonce: 0, pityCounter: 0, happyHourMultiplier: 1, focus: null, prizes: [prize], wheel: { show_stock: false } };
  const economicCalls: { name: string; args: Record<string, unknown> }[] = [];
  let contextTry = 0;
  const economic = { rpc: async (name: string, args: Record<string, unknown>) => {
    economicCalls.push({ name, args });
    if (name === "prepare_spin_attempt") return { data: { status: "ready", context: { ...ctx, contextHash: `context${contextTry}` } }, error: null };
    contextTry++;
    return { data: contextTry === 1 ? { status: "retry_context" } : { status: "committed", id: requestId, balance: 4 }, error: null };
  } };
  const result = await commitSinglePrizeFixture(economic, "opaque-fixture-token", { requestId });
  check("context contention is retried without assuming a win", result.status === "committed" && economicCalls.length === 4);
  check("every prepare/commit retains the same UUID and request hash", economicCalls.every(call => call.args.p_attempt === requestId && call.args.p_request_hash === economicCalls[0].args.p_request_hash));
  check("same attempt retains one next-seed value through contention", JSON.stringify(economicCalls[1].args.p_next_seed) === JSON.stringify(economicCalls[3].args.p_next_seed));
  const refused = { rpc: async () => ({ data: { status: "unavailable" }, error: null }) };
  check("blocked preparation is never counted as a success", (await commitSinglePrizeFixture(refused, "blocked")).status === "unavailable");
  const uncertain = { rpc: async (name: string) => ({ data: name === "prepare_spin_attempt" ? { status: "ready", context: ctx } : { status: "pending" }, error: null }) };
  await assert.rejects(() => commitSinglePrizeFixture(uncertain, "uncertain"), /outcome unresolved/); passed++;
  const wrongPool = { rpc: async () => ({ data: { status: "ready", context: { ...ctx, prizes: [prize, { ...prize, id: randomUUID() }] } }, error: null }) };
  await assert.rejects(() => commitSinglePrizeFixture(wrongPool, "multi-prize"), /exactly one/); passed++;
  console.log(`economicFixtures.test: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
