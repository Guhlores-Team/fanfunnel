// Local PostgreSQL stress fixture bridge only (D9). Reads bounded synthetic
// spin contexts from stdin and runs the service's own wheel proof path
// (buildFocusPoolSnapshot -> hashPoolSnapshot -> makeFairRngV3 ->
// drawFromSnapshot, as in commitSpinAttempt), so Focus/Chase boosts, the pity
// guarantee and the Chase guarantee come from the real engine. No service
// client or network I/O.
import { createInterface } from "node:readline";
import { buildFocusPoolSnapshot, drawFromSnapshot, hashPoolSnapshot, snapshotOdds } from "../../src/lib/games/wheel/fairnessV3";
import { makeFairRngV3, normalizeClientSeed } from "../../src/lib/games/wheel/fairness";
import type { Prize, WheelConfig } from "../../src/lib/games/wheel/types";
interface Context {
  wheel: { title: string }; wheelId: string; serverSeed: string; nonce: number; pityCounter: number; happyHourMultiplier: number | null;
  prizes: { id: string; label: string; rarity: Prize["rarity"]; weight: number; emoji: string | null; delivery: Prize["delivery"]; stock: number | null; image_url: string | null; sort_order?: number }[];
  focus: { kind: string; prize_id: string; multiplier: number; spins_left: number; total_spins: number; chase_counter: number } | null;
  reservation: unknown;
}
const MAX_REQUESTS = 20_000;
let requests = 0;
async function fixture(raw: string) {
  if (++requests > MAX_REQUESTS || Buffer.byteLength(raw) > 1048576) throw Error("Fixture request bound exceeded");
  const input = JSON.parse(raw) as { context: Context; excluded?: string[]; clientSeed?: string };
  const c = input.context;
  if (!c || !Array.isArray(c.prizes) || c.prizes.length < 1 || c.prizes.length > 50 || !/^[a-f0-9]{64}$/.test(c.serverSeed) || !Number.isSafeInteger(c.nonce) || (input.excluded?.length ?? 0) > 50) throw Error("Invalid synthetic fixture context");
  const prizes = c.prizes.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id));
  const config: WheelConfig = { id: c.wheelId, title: c.wheel.title, prizes: prizes.map(p => ({ id: p.id, label: p.label, rarity: p.rarity, weight: p.weight, emoji: p.emoji ?? undefined, stock: p.stock, delivery: p.delivery, imageUrl: p.image_url })) };
  const f = c.focus;
  const options = { happyHourMultiplier: c.happyHourMultiplier, pityCounter: c.pityCounter,
    ...(f?.kind === "focus" ? { focus: { prizeId: f.prize_id, multiplier: Number(f.multiplier), spinsLeft: f.spins_left, totalSpins: f.total_spins } } : {}),
    ...(f?.kind === "chase" ? { chase: { prizeId: f.prize_id, counter: f.chase_counter, within: f.total_spins, reserved: !!c.reservation } } : {}) };
  const snapshot = buildFocusPoolSnapshot(config, options);
  const poolHash = await hashPoolSnapshot(snapshot);
  const clientSeed = normalizeClientSeed(input.clientSeed ?? "stress-d9");
  const rng = await makeFairRngV3(c.serverSeed, clientSeed, c.nonce, poolHash);
  const excluded = input.excluded ?? [];
  const draw = drawFromSnapshot(snapshot, new Set(excluded), rng);
  const odds = snapshotOdds(snapshot);
  return { snapshot, poolHash, clientSeed, trace: { excluded, won: draw.prize.id }, draw, pityForced: odds.pityForced, chaseForced: odds.chaseForced, prizeIndex: config.prizes.findIndex(p => p.id === draw.prize.id) };
}
async function main() {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try { process.stdout.write(JSON.stringify({ ok: true, value: await fixture(line) }) + "\n"); }
    catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "fixture_error" }) + "\n"); }
  }
}
void main();
