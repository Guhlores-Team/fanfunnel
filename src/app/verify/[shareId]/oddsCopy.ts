// Plain-language copy for the fairness-v3 "Odds used for this spin" section.
import type { PoolSnapshot } from "@/lib/games/wheel/fairnessV3";
import { FOCUS_WEIGHT_RULE, MAX_COMBINED_BOOST } from "@/lib/focus/config";

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
      ? s.rules === FOCUS_WEIGHT_RULE
        ? `Happy hour: rare, epic and legendary base tickets were scaled by ×${hh.multiplier} before rounding.`
        : `Happy hour: rare, epic and legendary prizes had ×${hh.multiplier} tickets.`
      : "Happy hour: not active.",
  );
  const { counter, threshold } = s.modifiers.pity;
  const chase = s.modifiers.chase;
  const chaseForced = chase?.eligible === true && chase.counter + 1 >= chase.within;
  lines.push(
    chaseForced
      ? `Pity state: ${counter} of ${threshold}; the target-specific chase guarantee took precedence on this spin.`
      : pityForced
      ? `Pity guarantee: ${counter} spins in a row without a rare, so this spin could only land rare or better.`
      : `Pity guarantee: ${counter} of ${threshold} spins toward a guaranteed rare-or-better.`,
  );
  const label = (id: string) => s.prizes.find((p) => p.id === id)?.label ?? "the selected prize";
  const focus = s.modifiers.focus;
  if (focus) {
    const paused = {
      sold_out: "the target was sold out",
      other_wheel: "the target was not on this wheel",
      no_increase: "the boost would not increase the target's odds",
      pity: "the rare-or-better guarantee excluded the target",
    };
    lines.push(focus.applied
      ? `Focus ×${focus.multiplier} on ${label(focus.prizeId)} applied; the combined multiplier was ×${focus.effectiveMultiplier} before rounding once. ${focus.spinsLeft} of ${focus.totalSpins} focused spins remained before this spin.`
      : `Focus paused because ${paused[focus.pauseReason!]}. No focused spin was used.`);
  }
  if (chase) {
    lines.push(chase.eligible
      ? chaseForced
        ? `Chase guarantee: this spin had to win ${label(chase.prizeId)} before the global pity rule was considered.`
        : `Chase: ${chase.within - chase.counter} eligible spins remained to guarantee ${label(chase.prizeId)}; an earlier natural win also completes it.`
      : "Chase paused: the target was not available on this wheel. The guarantee counter did not advance.");
    if (chase.reserved && chase.eligible) lines.push("One unit of the target was reserved for this chase and unavailable to other fans.");
  }
  if (s.rules === FOCUS_WEIGHT_RULE) lines.push(`Boosts on one prize were capped at ×${MAX_COMBINED_BOOST}, composed from its base tickets and rounded once.`);
  return lines;
}
