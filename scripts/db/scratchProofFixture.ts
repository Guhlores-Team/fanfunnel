// Local PostgreSQL fixture bridge only. Reads bounded synthetic contexts from
// stdin and calls the real pure game engine; no service client or network I/O.
import { createInterface } from "node:readline";
import { buildScratchPoolSnapshot, hashGamePoolSnapshot } from "../../src/lib/games/core/gameProof";
import { makeGameRngV3 } from "../../src/lib/games/core/fairness";
import { drawGame } from "../../src/lib/games/core/play";
import type { Prize, WheelConfig } from "../../src/lib/games/core/types";
interface Context {
  wheel: { title: string; show_stock: boolean }; wheelId: string; creatorId: string; passId: string; fanId: string; campaignId: string | null;
  serverSeed: string; serverSeedHash: string; nonce: number; pityCounter: number; happyHourMultiplier: number | null;
  prizes: { id: string; label: string; rarity: Prize["rarity"]; weight: number; emoji: string | null; delivery: Prize["delivery"]; stock: number | null; image_url: string | null }[];
  focus: { kind: string; prize_id: string; multiplier: number; spins_left: number; total_spins: number; chase_counter: number } | null;
  reservation: unknown;
}
let requests = 0;
async function fixture(raw: string) {
  if (++requests > 512 || Buffer.byteLength(raw) > 1048576) throw Error("Fixture request bound exceeded");
  const input = JSON.parse(raw) as { context: Context; excluded?: string[] };
  const c = input.context;
  if (!c || !Array.isArray(c.prizes) || c.prizes.length < 1 || c.prizes.length > 50 || !/^[a-f0-9]{64}$/.test(c.serverSeed) || !Number.isSafeInteger(c.nonce) || (input.excluded?.length ?? 0) > 50) throw Error("Invalid synthetic fixture context");
  const config: WheelConfig = { id: c.wheelId, title: c.wheel.title, prizes: c.prizes.map(p => ({ id: p.id, label: p.label, rarity: p.rarity, weight: p.weight, emoji: p.emoji ?? undefined, stock: p.stock, delivery: p.delivery, imageUrl: p.image_url })) };
  const f = c.focus;
  const options = { happyHourMultiplier: c.happyHourMultiplier, pityCounter: c.pityCounter,
    ...(f?.kind === "focus" ? { focus: { prizeId: f.prize_id, multiplier: f.multiplier, spinsLeft: f.spins_left, totalSpins: f.total_spins } } : {}),
    ...(f?.kind === "chase" ? { chase: { prizeId: f.prize_id, counter: f.chase_counter, within: f.total_spins, reserved: !!c.reservation } } : {}) };
  const snapshot = buildScratchPoolSnapshot(config, options);
  const poolHash = await hashGamePoolSnapshot(snapshot);
  const rng = await makeGameRngV3(c.serverSeed, "scratch-pg-fixture", c.nonce, poolHash);
  const played = drawGame(snapshot, { excluded: input.excluded ?? [] }, rng);
  return { snapshot, poolHash, ...played };
}
async function main() {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try { process.stdout.write(JSON.stringify({ ok: true, value: await fixture(line) }) + "\n"); }
    catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "fixture_error" }) + "\n"); }
  }
}
void main();
