import type { Prize, WheelConfig } from "./types";

// Pure wheel validation shared by the editor (inline errors) and PUT /api/wheel
// (the authoritative check). No React, no server imports: safe in both bundles.

/** A wheel needs at least this many prizes before the editor will save it. */
export const MIN_WHEEL_PRIZES = 2;
/** Same ceiling the route has always enforced on a prize's tickets. */
export const MAX_PRIZE_WEIGHT = 1e6;
/** prizeRow stores labels up to this length. */
export const MAX_PRIZE_LABEL = 80;
const MAX_STOCK = 2147483647;

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#rgb` / `#rrggbb` (any case, surrounding whitespace ignored) → lowercase
 *  `#rrggbb`. Anything else → null. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!HEX_RE.test(v)) return null;
  let h = v.slice(1).toLowerCase();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return "#" + h;
}

/** Editor onChange for an optional color field: a cleared (or blank) field
 *  means "unset" (rarity default / auto), not an invalid "" value. */
export function colorFromInput(value: string): string | undefined {
  return value.trim() === "" ? undefined : value;
}

export function colorError(value: unknown, opts: { optional?: boolean } = {}): string | null {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    return opts.optional ? null : "Enter a hex color, like #ec4899.";
  }
  return normalizeHex(value) ? null : "Use a hex color: # plus 3 or 6 digits (0–9, a–f).";
}

/** 0 is allowed (the prize drops out of normal spins), matching the server;
 *  the editor notes it and requires one prize above 0. The spin engine can
 *  still award a 0-ticket rare-or-better prize via pity or happy hour. */
export function weightError(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Enter a number of tickets.";
  if (value < 0) return "Tickets can't be negative.";
  // Weights are stored as int4; a fraction would be rounded on save and could
  // change the odds a lot (0.05 → 1 is 20×), so ask for whole tickets.
  if (!Number.isInteger(value)) return "Tickets must be a whole number.";
  if (value > MAX_PRIZE_WEIGHT) return "Tickets can be at most 1,000,000.";
  return null;
}

/** Stock is unlimited (null/undefined) or a whole number ≥ 0. */
export function stockError(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_STOCK) {
    return "Stock must be a whole number, 0 or more. Leave it empty for unlimited.";
  }
  return null;
}

export function labelError(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return "Give this prize a name.";
  if (value.length > MAX_PRIZE_LABEL) return `Keep the name to ${MAX_PRIZE_LABEL} characters or fewer.`;
  return null;
}

export const NO_WINNABLE_PRIZE = "At least one prize needs more than 0 tickets.";
export const ZERO_TICKETS_NOTE =
  "0 tickets: this prize won't come up in normal spins. Rare or better prizes can still land through the pity guarantee or happy hour.";

export function prizeCountError(count: number): string | null {
  if (count >= MIN_WHEEL_PRIZES) return null;
  const more = MIN_WHEEL_PRIZES - count;
  return `A wheel needs at least ${MIN_WHEEL_PRIZES} prizes. Add ${more} more to save.`;
}

export type PrizeField = "label" | "weight" | "stock" | "color";
export type PrizeFieldErrors = Partial<Record<PrizeField, string>>;

/** One problem, keyed so the editor can map it to a field. Keys are
 *  "brandColor", "labelColor", "prizeCount" or "prize:<id>:<field>". */
export interface ValidationIssue {
  key: string;
  message: string;
}

export interface WheelDraftErrors {
  brandColor?: string;
  labelColor?: string;
  prizeCount?: string;
  prizes: Record<string, PrizeFieldErrors>;
  /** Every issue in on-screen order (first = the field to focus). */
  issues: ValidationIssue[];
}

/** Everything the editor checks before it lets a save through. */
export function validateWheelDraft(wheel: WheelConfig): WheelDraftErrors {
  const out: WheelDraftErrors = { prizes: {}, issues: [] };

  const brand = colorError(wheel.brandColor);
  if (brand) {
    out.brandColor = brand;
    out.issues.push({ key: "brandColor", message: `Brand color: ${brand}` });
  }
  const label = colorError(wheel.labelColor, { optional: true });
  if (label) {
    out.labelColor = label;
    out.issues.push({ key: "labelColor", message: `Label text color: ${label}` });
  }

  // Editor-only: a wheel where every prize has 0 tickets has nothing to win.
  // Reported on the first prize's tickets so it has a field to focus.
  const allZero = wheel.prizes.length > 0 && wheel.prizes.every((p) => p.weight === 0);

  wheel.prizes.forEach((p, i) => {
    const errs: PrizeFieldErrors = {};
    const checks: [PrizeField, string | null][] = [
      ["label", labelError(p.label)],
      ["weight", weightError(p.weight) ?? (allZero && i === 0 ? NO_WINNABLE_PRIZE : null)],
      ["stock", stockError(p.stock)],
      ["color", colorError(p.color, { optional: true })],
    ];
    for (const [field, msg] of checks) {
      if (!msg) continue;
      errs[field] = msg;
      out.issues.push({ key: `prize:${p.id}:${field}`, message: `Prize ${i + 1}: ${msg}` });
    }
    if (Object.keys(errs).length > 0) out.prizes[p.id] = errs;
  });

  const count = prizeCountError(wheel.prizes.length);
  if (count) {
    out.prizeCount = count;
    out.issues.push({ key: "prizeCount", message: count });
  }
  return out;
}

/** Stable codes saveWheel returns when a wheel breaks the save rules. */
export type WheelRuleError = "too_few_prizes" | "prize_name_required" | "no_winnable_prize";

/**
 * The save rules the server enforces (saveWheel, both data paths). They are
 * the editor's own rules from validateWheelDraft — prizeCountError, labelError
 * and NO_WINNABLE_PRIZE — so anything rejected here is already blocked in the
 * editor (validate.test.ts locks that in). Checked in on-screen order: count,
 * names, tickets. Only applied on save; wheels already stored stay as they are.
 */
export function wheelRulesError(
  prizes: readonly Pick<Prize, "label" | "weight">[],
): WheelRuleError | null {
  if (prizeCountError(prizes.length)) return "too_few_prizes";
  if (prizes.some((p) => typeof p.label !== "string" || p.label.trim() === "")) {
    return "prize_name_required";
  }
  if (!prizes.some((p) => typeof p.weight === "number" && p.weight > 0)) return "no_winnable_prize";
  return null;
}

/**
 * Server-side check for PUT /api/wheel: reject invalid colors, stock and
 * fractional tickets (range is checked by the route), and
 * return a copy with every color normalized to lowercase `#rrggbb`. Unset colors
 * (missing, null, or "" from a cleared field) stay unset (the data layer
 * applies its defaults). Weight/label/rarity limits
 * stay where the route already enforces them.
 */
export function normalizeWheelPayload(
  config: WheelConfig,
): { config: WheelConfig } | { error: "bad_color" | "bad_stock" | "bad_weight" } {
  // undefined = unset (null, missing, or "" from a cleared field); false = invalid.
  const color = (v: unknown): string | undefined | false => {
    if (v == null || (typeof v === "string" && v.trim() === "")) return undefined;
    return normalizeHex(v) ?? false;
  };

  const brandColor = color(config.brandColor);
  const labelColor = color(config.labelColor);
  if (brandColor === false || labelColor === false) return { error: "bad_color" };

  const prizes: Prize[] = [];
  for (const p of config.prizes) {
    const c = color(p.color);
    if (c === false) return { error: "bad_color" };
    if (stockError(p.stock)) return { error: "bad_stock" };
    if (typeof p.weight === "number" && !Number.isInteger(p.weight)) return { error: "bad_weight" };
    prizes.push({ ...p, color: c });
  }

  const next: WheelConfig = { ...config, brandColor, labelColor, prizes };
  return { config: next };
}
