/**
 * Pure helpers for the fan drawer's grant editor: parse the form the same way
 * the save does, and describe what an edit will do to the fan's balance before
 * it is saved. Kept free of React so the rule is unit-testable.
 *
 * The rule mirrors editGrant (COR-2): spins the fan has already spun can't be
 * un-granted, so a cut deeper than the unspent balance is refused by the
 * server. editGrant moves the change on ONE pass (grantPass.ts), and
 * getFanDetail reports that pass's balance per grant, so the preview judges
 * exactly the balance the server will (owner decision h).
 */

/** The spin count the save sends: a whole, non-negative number. */
export function parseSpins(raw: string): number {
  return Math.max(0, Math.floor(Number(raw) || 0));
}

/** The grant's recorded revenue the save sends for a $/spin price. */
export function grantAmountCents(perSpin: string, spins: number): number {
  return perSpin ? Math.round(Number(perSpin) * spins * 100) : 0;
}

/** The "$ / spin" field's starting text for a grant. */
export function perSpinText(spins: number, amountCents: number): string {
  return spins > 0 && amountCents > 0 ? (amountCents / 100 / spins).toFixed(2) : "";
}

/**
 * The recorded amount a save should store. The "$ / spin" field shows a price
 * rounded to cents, so recomputing from it would drift ($10.00 over 3 spins
 * reads 3.33 and saved as $9.99). Rule:
 * - price field untouched (same value as it started) and spins unchanged:
 *   the original amount, exactly;
 * - price untouched, spins changed: the field promises a per-spin price, so the
 *   total scales at the grant's exact original rate (no rate when the grant had
 *   0 spins: the amount stays as is);
 * - price edited: the typed price x the new spin count (empty = free).
 */
export function grantSaveAmount({
  grant,
  spinsInput,
  perSpinInput,
}: {
  grant: { spins: number; amountCents: number };
  spinsInput: string;
  perSpinInput: string;
}): number {
  const spins = parseSpins(spinsInput);
  const initial = perSpinText(grant.spins, grant.amountCents);
  const priceTouched = perSpinInput.trim() === "" ? initial !== "" : Number(perSpinInput) !== Number(initial || NaN);
  if (priceTouched) return grantAmountCents(perSpinInput, spins);
  if (spins === grant.spins || grant.spins <= 0) return grant.amountCents;
  return Math.round((grant.amountCents * spins) / grant.spins);
}

/** The grant API's cap on a grant's recorded amount (api/grants/[id] PATCH). */
export const MAX_GRANT_AMOUNT_CENTS = 100_000_000;

/** Why the "$ / spin" field can't be saved, or null when it can. */
export function grantPriceError(form: {
  grant: { spins: number; amountCents: number };
  spinsInput: string;
  perSpinInput: string;
}): string | null {
  const raw = form.perSpinInput.trim();
  if (raw !== "") {
    const price = Number(raw);
    if (!Number.isFinite(price)) return "Enter a valid price.";
    if (price < 0) return "Price can't be negative.";
  }
  if (grantSaveAmount(form) > MAX_GRANT_AMOUNT_CENTS) return "That's over the $1,000,000 limit for one grant.";
  return null;
}

const dollars = (c: number) => "$" + (c / 100).toFixed(2);

/** The preview's revenue sentence, or null when the save leaves the amount as is. */
export function revenueChangeText(fromCents: number, toCents: number): string | null {
  return fromCents === toCents ? null : `Recorded revenue goes from ${dollars(fromCents)} to ${dollars(toCents)}.`;
}

const spinsText = (n: number) => `${n} spin${n === 1 ? "" : "s"}`;

export interface GrantImpact {
  newSpins: number;
  /** newSpins - the grant's current spins. */
  delta: number;
  /** The balance of the pass the edit moves, after it (negative when refused). */
  remainingAfter: number;
  /** Spins of this grant already used: the lowest value the server accepts. */
  used: number;
  allowed: boolean;
  /** Plain-language preview, e.g. "This fan has used 3 of these 5 spins. Setting it to 4 leaves 1 spin." */
  message: string;
}

/**
 * What saving a grant's spin count does, judged on the pass editGrant moves.
 * `passSpinsRemaining` is that pass's balance (Grant.editPass); omitted, the
 * fan-level balance stands in for it (a single-wheel fan); null means the fan
 * has no active pass, so only an unchanged spin count can save. The wheel is
 * named only when the pass isn't the fan's whole balance.
 */
export function grantImpact({
  grantSpins,
  spinsInput,
  fanSpinsRemaining,
  passSpinsRemaining,
  wheelTitle,
}: {
  grantSpins: number;
  spinsInput: string;
  fanSpinsRemaining: number;
  passSpinsRemaining?: number | null;
  wheelTitle?: string | null;
}): GrantImpact {
  const newSpins = parseSpins(spinsInput);
  const delta = newSpins - grantSpins;

  if (passSpinsRemaining === null) {
    // editGrant refuses any spin change here (no_active_pass).
    const allowed = delta === 0;
    const lead = "This fan has no active link to move spins on.";
    const effect = allowed
      ? "Spins unchanged."
      : `Setting it to ${newSpins} isn't allowed: only the price and campaign can change.`;
    return { newSpins, delta, remainingAfter: allowed ? 0 : -1, used: grantSpins, allowed, message: `${lead} ${effect}` };
  }

  const fanRemaining = Math.max(0, fanSpinsRemaining);
  const remaining = passSpinsRemaining === undefined ? fanRemaining : Math.max(0, passSpinsRemaining);
  const where = remaining === fanRemaining ? "" : ` on ${wheelTitle || "this wheel"}`;
  const remainingAfter = remaining + delta;
  const used = Math.max(0, Math.min(grantSpins, grantSpins - remaining));
  const allowed = remainingAfter >= 0;

  const lead =
    used > 0
      ? `This fan has used ${used} of these ${spinsText(grantSpins)}.`
      : `This fan has ${spinsText(remaining)} left${where}.`;

  let effect: string;
  if (!allowed) {
    effect = `Setting it to ${newSpins} isn't allowed: it can't go below the ${spinsText(used)} already used.`;
  } else if (delta === 0) {
    effect = `Spins unchanged, so they keep ${spinsText(remainingAfter)}${where}.`;
  } else if (delta > 0) {
    effect = `Setting it to ${newSpins} adds ${spinsText(delta)} and leaves ${spinsText(remainingAfter)}${where}.`;
  } else {
    effect = `Setting it to ${newSpins} takes back ${spinsText(-delta)} and leaves ${spinsText(remainingAfter)}${where}.`;
  }

  return { newSpins, delta, remainingAfter, used, allowed, message: `${lead} ${effect}` };
}
