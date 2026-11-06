import { makeGameRngV3 } from "./fairness";
import { canonicalJson, parseFairTrace, type V3ReplayInput } from "../wheel/fairnessV3";
import { BINGO_LINE_MASKS, type BonusTrace } from "../bingo/engine";
import { hashGamePoolSnapshot, parseGamePoolSnapshot, type GamePoolSnapshot } from "./gameProof";
import { drawGame, type GameDraw, type GameTrace } from "./play";

const obj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export function parseGameTrace(raw: unknown): GameTrace | null {
  if (!obj(raw) || Object.keys(raw).length !== 3 || !["excluded", "won", "bonuses"].every((key) => Object.hasOwn(raw, key))) return null;
  const primary = parseFairTrace({ excluded: raw.excluded, won: raw.won });
  if (!primary || primary.excluded.length > 50 || new Set(primary.excluded).size !== primary.excluded.length || !Array.isArray(raw.bonuses) || raw.bonuses.length > 4) return null;
  const bonuses: BonusTrace[] = [];
  for (const b of raw.bonuses) {
    if (!obj(b) || Object.keys(b).length !== 3 || !["line", "excluded", "won"].every((key) => Object.hasOwn(b, key)) ||
      !Number.isInteger(b.line) || (b.line as number) < 0 || (b.line as number) >= BINGO_LINE_MASKS.length) return null;
    const trace = parseFairTrace({ excluded: b.excluded, won: b.won });
    if (!trace || trace.excluded.length > 50 || new Set(trace.excluded).size !== trace.excluded.length) return null;
    bonuses.push({ line: b.line as number, ...trace });
  }
  return { ...primary, bonuses };
}
export interface GameReplayInput extends V3ReplayInput { presentation: unknown }
export interface GameReplay {
  ok: boolean; poolHashOk: boolean; computedHash: string | null;
  snapshot: GamePoolSnapshot | null; draw: GameDraw | null; problem: string | null;
}
export async function replayGameV3(input: GameReplayInput): Promise<GameReplay> {
  const out: GameReplay = { ok: false, poolHashOk: false, computedHash: null, snapshot: null, draw: null, problem: null };
  const parsed = parseGamePoolSnapshot(input.snapshot);
  if (!parsed.ok) return { ...out, problem: `The recorded game cannot be read (${parsed.reason}).` };
  out.snapshot = parsed.snapshot;
  out.computedHash = await hashGamePoolSnapshot(parsed.snapshot);
  out.poolHashOk = out.computedHash === input.poolHash;
  if (!out.poolHashOk) return { ...out, problem: "The recorded game differs from its committed fingerprint." };
  const trace = parseGameTrace(input.trace);
  if (!trace) return { ...out, problem: "The game's draw record cannot be read." };
  try {
    const rng = await makeGameRngV3(input.serverSeed, input.clientSeed ?? "", input.nonce, out.computedHash);
    out.draw = drawGame(parsed.snapshot, trace, rng, trace.bonuses);
    if (canonicalJson(out.draw.presentation) !== canonicalJson(input.presentation)) return { ...out, problem: "The recorded ticket or card does not replay." };
    if (out.draw.primary.prize.label !== input.prizeLabel || (input.prizeId !== null && out.draw.primary.prize.id !== input.prizeId)) return { ...out, problem: "The replay lands on a different primary prize." };
  } catch {
    return { ...out, problem: "The game's ordered draws do not replay." };
  }
  return { ...out, ok: true };
}
