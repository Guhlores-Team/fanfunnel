import assert from "node:assert/strict";
import { mock } from "node:test";
import { sha256Hex } from "@/lib/games/wheel/fairness";
import { replayV3 } from "@/lib/games/wheel/fairnessV3";
import type { createServiceClient } from "@/lib/supabase/server";
let notifications = 0, webhooks = 0;
mock.module("@/lib/push/notify", { namedExports: { notifyCreator: async () => { notifications++; } } });
mock.module("@/lib/data/webhooks", { namedExports: { fireWebhooks: async () => { webhooks++; } } });
mock.module("@/lib/afterResponse", { namedExports: { runAfterResponse: (work: () => Promise<unknown>) => { void work(); } } });
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => true, createServiceClient: () => { throw new Error("must use supplied service client"); }, createClient: async () => { throw new Error("no session writer"); } } });
type Reply = { data: unknown; error: { code: string } | null };
type Receipt = Record<string, unknown> & { spin: Record<string, unknown> };
const receipts = new Map<string, Receipt>();
let balance = 5, nonce = 0, seed = "a".repeat(64), seedHash = "", spinCount = 0, loseResponse = true, stockRace = false;
let capturedSpin: Record<string, unknown> | null = null;
const calls: { name: string; args: Record<string, unknown> }[] = [];
const prizes = [
  { id: "target", label: "Target", rarity: "common", weight: 1, stock: null, delivery: "manual", sort_order: 0 },
  { id: "fallback", label: "Fallback", rarity: "common", weight: 0, stock: null, delivery: "manual", sort_order: 1 },
];
const wheel = { id: "wheel", title: "Wheel", show_stock: false };
const context = () => ({ contextHash: `${nonce}`, creatorId: "creator", fanId: "fan", passId: "pass", wheelId: "wheel", campaignId: null,
  serverSeed: seed, serverSeedHash: seedHash, nonce, pityCounter: spinCount, happyHourMultiplier: null, commitment: "stored", focus: null, reservation: null, wheel, prizes });
function readQuery(table: string) {
  const q: Record<string, unknown> = {};
  for (const key of ["select", "eq", "gte", "lte", "is", "order", "limit"]) q[key] = () => q;
  q.maybeSingle = async () => ({ data: table === "fan_play_reminders" ? { daily: 50 } : null, error: null });
  q.then = (resolve: (reply: unknown) => unknown) => Promise.resolve({ data: null, count: spinCount, error: null }).then(resolve);
  q.update = () => { throw new Error("split economic mutation is forbidden"); };
  q.insert = q.update;
  return q;
}
const client = { from: readQuery, rpc: async (name: string, args: Record<string, unknown>): Promise<Reply> => {
  calls.push({ name, args: structuredClone(args) });
  const id = String(args.p_attempt);
  const original = receipts.get(id);
  const currentReceipt = () => ({ ...original, status: "committed", replayed: true, balance, nextServerSeedHash: seedHash, focus: null });
  if (name === "get_fan_focus_state") return { data: { status: "ok", focus: null, context: { ...context(), reserved: false } }, error: null };
  if (name === "get_spin_attempt_status") return { data: original ? currentReceipt() : { status: "absent" }, error: null };
  if (original) return { data: currentReceipt(), error: null };
  if (name === "prepare_spin_attempt") return { data: { status: "ready", context: context(), balance }, error: null };
  if (name !== "commit_spin_attempt") throw new Error(`unexpected writer ${name}`);
  const spin = args.p_spin as Record<string, unknown>;
  if (stockRace && spin.prize_id === "target") { stockRace = false; return { data: { status: "sold_out" }, error: null }; }
  capturedSpin = spin;
  assert.equal((args.p_context as { contextHash: string }).contextHash, `${nonce}`);
  assert.equal(spin.nonce, nonce);
  assert.equal(spin.seed_commitment, (args.p_context as { publishedSeedHash: string }).publishedSeedHash === seedHash ? "published" : "stored");
  balance--; nonce++; spinCount++;
  seed = String((args.p_next_seed as { seed: string }).seed); seedHash = String((args.p_next_seed as { hash: string }).hash);
  const receipt: Receipt = { status: "committed", replayed: false, id, shareId: `share-${id}`, spin: { ...spin, created_at: "2026-10-28T00:00:00Z" },
    prize: spin.response_prize, prizeIndex: spin.response_prize_index, showStock: false, stockAfter: null, balance, nextServerSeedHash: seedHash,
    focus: null, pityAwarded: spin.pity_awarded, focusConsumed: spin.focus_consumed, chaseConsumed: spin.chase_consumed, chaseCompleted: spin.chase_completed, chaseAwarded: spin.chase_awarded };
  receipts.set(id, structuredClone(receipt));
  if (loseResponse) { loseResponse = false; return { data: null, error: { code: "PGRST_CONNECTION" } }; }
  return { data: receipt, error: null };
} } as unknown as ReturnType<typeof createServiceClient>;
let passed = 0;
function check(label: string, condition: unknown) { assert.ok(condition, label); passed++; }
async function main() {
  const { commitSpinAttempt, readSpinAttempt } = await import("./spinAttempts");
  seedHash = await sha256Hex(seed);
  const intent = { requestId: crypto.randomUUID(), clientSeed: "client", publishedSeedHash: seedHash };
  const recovered = await commitSpinAttempt("token", intent, client); assert.ok(!("error" in recovered));
  check("lost commit response retries same UUID and spends exactly once", balance === 4 && nonce === 1 && spinCount === 1 && calls.filter(c => c.name === "commit_spin_attempt").length === 2 && recovered.replayed);
  check("replay does not repeat F7 delivery", notifications === 0 && webhooks === 0);
  const stored = receipts.get(intent.requestId)!;
  check("immutable receipt preserves published hash and v3 proof", stored.spin.seed_commitment === "published" && !!stored.spin.pool_hash);
  const next = await commitSpinAttempt("token", { requestId: crypto.randomUUID(), clientSeed: "next", publishedSeedHash: seedHash }, client); assert.ok(!("error" in next));
  check("new committed intent emits side effects once", notifications === 1 && webhooks === 1 && spinCount === 2);
  balance += 10; prizes[0].label = "Changed later";
  const late = await commitSpinAttempt("token", intent, client); assert.ok(!("error" in late));
  check("late replay keeps original label/share/proof with current balance/hash/play", late.prize.label === "Target" && late.shareId === recovered.shareId && late.poolHash === recovered.poolHash && late.spinsRemaining === 13 && late.nextSpinHash === seedHash && late.play?.today === 2);
  check("late retry cannot repeat dispatch", notifications === 1 && webhooks === 1 && spinCount === 2);
  const status = await readSpinAttempt("token", intent, client);
  check("authoritative status returns current state beside original winner", status.status === "committed" && status.result.spinsRemaining === 13 && status.result.prize.label === "Target");
  stockRace = true;
  const race = await commitSpinAttempt("token", { requestId: crypto.randomUUID(), clientSeed: "race" }, client); assert.ok(!("error" in race));
  check("stock loss redraws from the original pool with explicit exclusion", race.prize.id === "fallback" && capturedSpin && JSON.stringify(capturedSpin.fair_trace) === JSON.stringify({ excluded: ["target"], won: "fallback" }));
  const proof = capturedSpin! as Record<string, unknown>;
  check("the complete exclusion trace publicly replays", (await replayV3({ serverSeed: String(proof.server_seed), clientSeed: String(proof.client_seed), nonce: Number(proof.nonce), snapshot: proof.pool_snapshot, poolHash: String(proof.pool_hash), trace: proof.fair_trace, prizeId: String(proof.prize_id), prizeLabel: String(proof.prize_label) })).ok);
  check("no split claim/refund/stock/pity writer is called", calls.every(c => ["prepare_spin_attempt", "commit_spin_attempt", "get_spin_attempt_status", "get_fan_focus_state"].includes(c.name)));
  console.log(`focus orchestration: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
