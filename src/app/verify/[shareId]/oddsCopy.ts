// Plain-language copy for the fairness-v3 "Odds used for this spin" section.
import type { PoolSnapshot } from "@/lib/games/wheel/fairnessV3";

export const ODDS_LOCKED_LINE =
  "These odds were locked in before your spin was drawn. Their fingerprint is mixed into the random number itself, so changing even one ticket would have changed the result.";

export const ODDS_LIMIT_LINE =
  "These are the odds in force when your spin ran. A creator can edit a wheel between when you open your page and when you spin, so they may differ from what your page showed earlier.";

export const V3_FORMULA = "SHA-256(serverSeed:clientSeed:nonce:poolHash:block)";

/** A chance in [0, 1] as a short percentage ("12.5%", "<0.01%"). */
export function formatChance(chance: number): string {
  if (chance <= 0) return "0%";
  const pct = chance * 100;
  if (pct < 0.01) return "<0.01%";
  const rounded = pct >= 10 ? pct.toFixed(1) : pct.toFixed(2);
  return `${rounded.replace(/\.?0+$/, "")}%`;
}

/** One line per modifier in force, neutral ones included so nothing is implied. */
export function modifierLines(s: PoolSnapshot, pityForced: boolean): string[] {
  const lines: string[] = [];
  const hh = s.modifiers.happyHour;
  lines.push(
    hh
      ? `Happy hour: rare, epic and legendary prizes had ×${hh.multiplier} tickets.`
      : "Happy hour: not active.",
  );
  const { counter, threshold } = s.modifiers.pity;
  lines.push(
    pityForced
      ? `Pity guarantee: ${counter} spins in a row without a rare, so this spin could only land rare or better.`
      : `Pity guarantee: ${counter} of ${threshold} spins toward a guaranteed rare-or-better.`,
  );
  return lines;
}
