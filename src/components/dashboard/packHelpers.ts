// Pure (no React) helpers for spin-pack stacking. Kept framework-agnostic and
// deterministic so they can be unit-tested in isolation. Lives separately from
// editorHelpers.ts (wheel/prize math) since packs are a distinct concern.

/** The accumulable quantities of a spin pack — i.e. what scales when stacked. */
export interface PackQuantities {
  spins: number;
  amountCents: number;
  bonusSpins: number;
}

/**
 * Stack a base pack `count` times: every accumulable quantity scales linearly.
 * Clicking "10 spins / $5 / +1 bonus" five times yields 50 spins / $25 / +5.
 *
 * `count` is floored to a whole, non-negative number of picks (a fractional or
 * negative count is meaningless for a "click N times" interaction). The base's
 * own quantities are treated as a single unit, so count=1 is the identity.
 */
export function stackPack<T extends PackQuantities>(base: T, count: number): T {
  const n = Math.max(0, Math.floor(count));
  return {
    ...base,
    spins: base.spins * n,
    amountCents: base.amountCents * n,
    bonusSpins: base.bonusSpins * n,
  };
}

/**
 * Identity of a pack *bundle* for stacking purposes in the editor: two adds are
 * "the same pack" when they share a label (case-insensitive, trimmed) and the
 * same per-unit economics (spins, price, bonus). Adding the same bundle again
 * should bump its quantity rather than create a duplicate row.
 */
export function packKey(p: { label: string; spins: number; amountCents: number; bonusSpins: number }): string {
  return [p.label.trim().toLowerCase(), p.spins, p.amountCents, p.bonusSpins].join("|");
}

/** A pack the editor can merge into a list. `quantity` defaults to 1 unit. */
export interface DraftPack {
  label: string;
  spins: number;
  amountCents: number;
  bonusSpins: number;
}

export interface MergedPack extends DraftPack {
  /** How many base units have been stacked into this entry (>= 1). */
  quantity: number;
}

export interface MergeResult {
  list: MergedPack[];
  /** Index of the entry that was created or accumulated into. */
  index: number;
  /** True when an existing matching entry was bumped (vs. a new row appended). */
  merged: boolean;
}

/**
 * Merge a freshly-added draft pack into an existing list. If a matching bundle
 * (see {@link packKey}) is already present, its quantity and all accumulable
 * totals are bumped by one base unit; otherwise the draft is appended as a new
 * single-unit entry. Pure: never mutates `list` or its entries.
 *
 * The draft is interpreted as ONE base unit. Its `spins`/`amountCents`/
 * `bonusSpins` are the per-unit figures; on a merge we add those per-unit
 * figures (derived from the existing entry's own per-unit values) so totals stay
 * exact even if the caller passed already-multiplied numbers.
 */
export function mergeDraftPack(list: readonly MergedPack[], draft: DraftPack): MergeResult {
  const key = packKey(draft);
  const index = list.findIndex((p) => packKey(unitOf(p)) === key);

  if (index === -1) {
    const entry: MergedPack = { ...draft, quantity: 1 };
    return { list: [...list, entry], index: list.length, merged: false };
  }

  const existing = list[index];
  const unit = unitOf(existing);
  const quantity = existing.quantity + 1;
  const bumped: MergedPack = {
    ...existing,
    quantity,
    spins: unit.spins * quantity,
    amountCents: unit.amountCents * quantity,
    bonusSpins: unit.bonusSpins * quantity,
  };
  const next = list.slice();
  next[index] = bumped;
  return { list: next, index, merged: true };
}

/** Recover the per-unit quantities of a (possibly already-stacked) entry. */
function unitOf(p: MergedPack): DraftPack {
  const q = Math.max(1, p.quantity);
  return {
    label: p.label,
    spins: p.spins / q,
    amountCents: p.amountCents / q,
    bonusSpins: p.bonusSpins / q,
  };
}

// --- Persisted-list stacking (no quantity column) ------------------------
// The editor works against packs saved server-side, which carry no `quantity`
// field — re-adding the same bundle just grows the stored totals by one unit.

/**
 * Find the index of an existing pack matching `draft`'s bundle identity
 * ({@link packKey}), or -1 if none. Used by the editor to decide between
 * accumulating into a saved pack vs. creating a new one.
 */
export function findMatchingPack(
  list: readonly { label: string; spins: number; amountCents: number; bonusSpins: number }[],
  draft: DraftPack,
): number {
  const label = draft.label.trim().toLowerCase();
  // A saved pack matches `draft` when it shares the label AND its stored totals
  // are a positive INTEGER multiple of the draft's per-unit economics — i.e. the
  // saved pack is "k units of this bundle". This keeps stacking working after the
  // saved totals have ALREADY grown (a 20-spin saved pack still matches a re-added
  // 10-spin unit, so a 3rd/4th add keeps accumulating) while still treating a
  // genuinely different per-unit price as a different pack. (Comparing the raw
  // accumulated totals — the old behavior — broke on the 3rd add.)
  return list.findIndex(
    (p) => p.label.trim().toLowerCase() === label && stackMultiple(p, draft) !== null,
  );
}

/**
 * If `saved` equals a positive whole-number multiple `k` (k ≥ 1) of `draft`
 * across every accumulable field, return `k`; otherwise null. A zero draft field
 * requires the saved field to also be zero; all non-zero fields must agree on the
 * same `k` (so 20 spins / $7 is NOT a multiple of 10 spins / $5).
 */
function stackMultiple(
  saved: { spins: number; amountCents: number; bonusSpins: number },
  draft: { spins: number; amountCents: number; bonusSpins: number },
): number | null {
  const pairs: Array<[number, number]> = [
    [saved.spins, draft.spins],
    [saved.amountCents, draft.amountCents],
    [saved.bonusSpins, draft.bonusSpins],
  ];
  let k: number | null = null;
  for (const [s, d] of pairs) {
    if (d === 0) {
      if (s !== 0) return null;
      continue;
    }
    if (s % d !== 0) return null;
    const ki = s / d;
    if (ki < 1) return null;
    if (k === null) k = ki;
    else if (k !== ki) return null;
  }
  return k; // null only when every draft field is 0 (degenerate)
}

/**
 * Accumulate one base unit (`draft`) onto an existing pack's totals. Returns the
 * bumped quantity patch (spins/amountCents/bonusSpins) — exactly what a PATCH to
 * persist the stacked pack needs. Pure: does not mutate `existing`.
 */
export function addPackUnit(existing: PackQuantities, draft: PackQuantities): PackQuantities {
  return {
    spins: existing.spins + draft.spins,
    amountCents: existing.amountCents + draft.amountCents,
    bonusSpins: existing.bonusSpins + draft.bonusSpins,
  };
}
