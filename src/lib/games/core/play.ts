import { drawFromSnapshot, type SnapshotDraw, type FairTrace } from "../wheel/fairnessV3";
import { scratchFace, type ScratchPresentation } from "../scratch/engine";
import { advanceBingo, pickLineBonus, type BingoPresentation, type BonusPrize, type BonusTrace } from "../bingo/engine";
import { primarySnapshot, type GamePoolSnapshot } from "./gameProof";

export type GamePresentation = ScratchPresentation | BingoPresentation;
export interface GameTrace extends FairTrace { bonuses: BonusTrace[] }
export interface GameDraw {
  primary: SnapshotDraw;
  presentation: GamePresentation;
  bonuses: { line: number; prize: BonusPrize }[];
  trace: GameTrace;
}

/**
 * Continues AFTER the final primary RNG draw. Stock retry must replay from the
 * same committed hash with ordered traces, preserving earlier successful picks.
 */
export function finishGame(
  snapshot: GamePoolSnapshot,
  primary: SnapshotDraw,
  primaryTrace: FairTrace,
  rng: () => number,
  bonusTrace?: readonly BonusTrace[],
): GameDraw {
  if (primary.prize.id !== primaryTrace.won) throw new Error("Primary result differs from game trace");
  if (snapshot.game === "scratch") {
    if (bonusTrace?.length) throw new Error("Scratch has no line bonuses");
    return {
      primary, presentation: scratchFace(primary.prize, snapshot.prizes, rng), bonuses: [],
      trace: { excluded: [...primaryTrace.excluded], won: primaryTrace.won, bonuses: [] },
    };
  }
  const presentation = advanceBingo(snapshot.bingo.catalog, snapshot.bingo.before, primary.prize.id, rng);
  if (bonusTrace && bonusTrace.length !== presentation.newLines.length) throw new Error("Missing or extra bingo bonus");
  const excluded = new Set(primaryTrace.excluded);
  const bonuses: GameDraw["bonuses"] = [];
  const traces: BonusTrace[] = [];
  for (let n = 0; n < presentation.newLines.length; n++) {
    const line = presentation.newLines[n];
    const trace = bonusTrace?.[n];
    if (trace && trace.line !== line) throw new Error("Bingo bonus order differs");
    const failed: string[] = [];
    for (const id of trace?.excluded ?? []) {
      if (excluded.has(id)) throw new Error("Duplicate game stock exclusion");
      const candidate = pickLineBonus(snapshot.bingo.bonus, excluded, rng);
      if (candidate.id !== id || candidate.unlimited) throw new Error("Bingo bonus exclusion does not match a finite candidate");
      failed.push(id);
      excluded.add(id);
    }
    const prize = pickLineBonus(snapshot.bingo.bonus, excluded, rng);
    if (trace && trace.won !== prize.id) throw new Error("Bingo bonus result differs");
    bonuses.push({ line, prize: { ...prize } });
    traces.push({ line, excluded: failed, won: prize.id });
  }
  return { primary, presentation, bonuses, trace: { excluded: [...primaryTrace.excluded], won: primaryTrace.won, bonuses: traces } };
}

/** Replays primary stock exclusions, then continues that exact RNG stream. */
export function drawGame(
  snapshot: GamePoolSnapshot,
  trace: { excluded: readonly string[]; won?: string },
  rng: () => number,
  bonusTrace?: readonly BonusTrace[],
): GameDraw {
  const primaryPool = primarySnapshot(snapshot);
  const excluded = new Set<string>();
  for (const id of trace.excluded) {
    if (excluded.has(id) || !snapshot.prizes.some((p) => p.id === id)) throw new Error("Duplicate or unknown primary exclusion");
    if (snapshot.game === "bingo" && snapshot.bingo.catalog.some((p) => p.id === id)) throw new Error("Unlimited card prize cannot sell out");
    const pick = drawFromSnapshot(primaryPool, excluded, rng);
    if (pick.prize.id !== id) throw new Error("Primary stock exclusion does not replay");
    excluded.add(id);
  }
  const primary = drawFromSnapshot(primaryPool, excluded, rng);
  if (trace.won !== undefined && primary.prize.id !== trace.won) throw new Error("Primary outcome does not replay");
  return finishGame(snapshot, primary, { excluded: [...trace.excluded], won: primary.prize.id }, rng, bonusTrace);
}
