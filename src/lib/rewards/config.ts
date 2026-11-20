// #26 instant-delivery prizes: the shared, isomorphic rules (no secrets here).
// The editor, the routes, the mock store and the Supabase path all read these,
// so a decision flips in one place.

/** How a prize reaches the winner. `manual` is today's fulfil-it-yourself. */
export type PrizeDelivery = "manual" | "link" | "text" | "codes";
export const PRIZE_DELIVERIES: readonly PrizeDelivery[] = ["manual", "link", "text", "codes"];

/** What one winning spin received (only ever sent to that winner). */
export type RewardKind = "link" | "text" | "code";
export interface DeliveredReward {
  kind: RewardKind;
  value: string;
}

/**
 * Owner decision D7: can a fan reopen a revealed reward later?
 *   "always" (default, recommended): any time from their own link, every view logged;
 *   "once": only in the win card itself (re-opening is refused);
 *   { days: n }: from their own link for n days after the win.
 */
export type RewardReviewPolicy = "always" | "once" | { days: number };
export const REWARD_REVIEW: RewardReviewPolicy = "always";

/** True when the fan may see the reward again under `policy`. */
export function rewardReviewAllowed(
  deliveredAt: string,
  policy: RewardReviewPolicy = REWARD_REVIEW,
  now: number = Date.now(),
): boolean {
  if (policy === "always") return true;
  if (policy === "once") return false;
  const at = Date.parse(deliveredAt);
  return Number.isFinite(at) && now - at <= policy.days * 86_400_000;
}

/** Re-view endpoint rate limit, per IP + link token. */
export const REWARD_VIEW_LIMIT = 10;
export const REWARD_VIEW_WINDOW_MS = 60_000;

export const MAX_REWARD_TEXT = 500;
export const MAX_REWARD_LINK = 2048;
export const MAX_CODE_LENGTH = 200;
/** Unused codes one prize may hold (mirrored in add_reward_codes, migration 0057). */
export const MAX_CODES_PER_PRIZE = 5000;
/** Codes one paste may add. */
export const MAX_CODES_PER_PASTE = 1000;
/** How many masked codes the editor lists. */
export const CODE_PREVIEW_COUNT = 5;

/** An https link a fan can open, or null. */
export function normalizeRewardLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > MAX_REWARD_LINK) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Reward text (1..MAX_REWARD_TEXT characters after trimming), or null. */
export function normalizeRewardText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v && v.length <= MAX_REWARD_TEXT ? v : null;
}

export interface ParsedCodes {
  codes: string[];
  /** Lines dropped because they repeat an earlier line of the same paste. */
  duplicates: number;
  /** Lines longer than MAX_CODE_LENGTH (the paste is refused when > 0). */
  tooLong: number;
}

/** One code per line; blank lines ignored, repeats within the paste dropped. */
export function parseCodeList(raw: unknown): ParsedCodes {
  const out: ParsedCodes = { codes: [], duplicates: 0, tooLong: 0 };
  if (typeof raw !== "string") return out;
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const code = line.trim();
    if (!code) continue;
    if (code.length > MAX_CODE_LENGTH) {
      out.tooLong++;
      continue;
    }
    if (seen.has(code)) {
      out.duplicates++;
      continue;
    }
    seen.add(code);
    out.codes.push(code);
  }
  return out;
}

/**
 * The few characters the editor may show of a code: the last 4, and only for
 * a code of 8+ characters (a short code would be half given away).
 */
export function codeHint(code: string): string | null {
  return code.length >= 8 ? code.slice(-4) : null;
}

/** "••••7F2K", or "••••••" when there is no hint. */
export function maskCode(hint: string | null | undefined): string {
  return hint ? `••••${hint}` : "••••••";
}

/** The creator's view of a prize's delivery (never a code in full). */
export interface PrizeDeliveryView {
  prizeId: string;
  delivery: PrizeDelivery;
  /** Instant delivery can be configured (the server holds a reward key). */
  ready: boolean;
  /** The link or text the creator set (they wrote it; it is shown back to them). */
  value: string | null;
  /** Code list: unused codes left (= the prize's stock). */
  codesLeft: number;
  /** Code list: codes already delivered. */
  codesUsed: number;
  /** Code list: a few unused codes, masked. */
  preview: string[];
}

/** References only: reward values are loaded separately for an owned win. */
export interface InstantWinReference {
  shareId: string;
  label: string;
  rarity: import("@/lib/games/wheel/types").Rarity;
  at: string;
}
export interface InstantRewardHistory {
  wins: InstantWinReference[];
  nextCursor: string | null;
}
export const REWARD_HISTORY_PAGE_SIZE = 20;
