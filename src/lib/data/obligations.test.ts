import assert from "node:assert/strict";
import { mock } from "node:test";

// What fans are still owed, before a wipe: one creator_obligations call with
// 0073, otherwise computed from the overview and the complete fan list.
let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };
let answer: { data: unknown; error: unknown } = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
let useSupabase = true;
const rpcCalls: string[] = [];
const client = {
  rpc: async (name: string) => { rpcCalls.push(name); return answer; },
  auth: { getUser: async () => ({ data: { user: { id: "creator-1" } }, error: null }) },
  from: () => { throw new Error("obligations must not read tables once the RPC answers"); },
};
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => useSupabase, createClient: async () => client, createServiceClient: () => client } });
mock.module("./analytics", { namedExports: { getOverview: async () => ({ metrics: { pending: 2 }, redemptions: [{ status: "pending", fanId: "f1", fanName: "A" }, { status: "cancelled", fanId: "f2", fanName: "B" }] }) } });
mock.module("./fans", { namedExports: { listFans: async () => [{ fanId: "f1", spinsRemaining: 3, totalSpent: 500 }, { fanId: "f2", spinsRemaining: 4, totalSpent: 0 }] } });

async function main() {
  const { getCreatorObligations, obligationsFrom } = await import("./obligations");
  const fallback = await getCreatorObligations();
  check("without the RPC the shape comes from the overview and fan list", fallback?.prizes === 2 && fallback.fans === 1 && fallback.fansAtLeast === true && fallback.paidSpins === 3 && fallback.payingFans === 1 && fallback.unplayedSpins === 7 && fallback.activeLinks === null);
  answer = { data: { openPrizes: 5, fansOwed: 4, unplayedPaidSpins: "12", unplayedSpins: 20, fansWithCredit: 3, liveFocus: 0, heldChase: 0, activeLinks: 9 }, error: null };
  const viaRpc = await getCreatorObligations();
  check("with 0073 the RPC answers alone", viaRpc?.prizes === 5 && viaRpc.fans === 4 && viaRpc.paidSpins === 12 && viaRpc.payingFans === 3 && viaRpc.unplayedSpins === 20 && viaRpc.activeLinks === 9 && rpcCalls.filter((n) => n === "creator_obligations").length === 2);
  answer = { data: null, error: { code: "42501", message: "permission denied" } };
  await assert.rejects(getCreatorObligations(), "a real database error is not swallowed into zeros");
  const shape = obligationsFrom({ metrics: { pending: 0 } as never, redemptions: [] }, []);
  check("nothing owed reads as zeros", shape.prizes === 0 && shape.fans === 0 && shape.paidSpins === 0 && shape.unplayedSpins === 0);
  useSupabase = false;
  const demo = await getCreatorObligations();
  check("demo mode answers from the store", demo !== null && typeof demo.prizes === "number");
  console.log(`obligations: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
