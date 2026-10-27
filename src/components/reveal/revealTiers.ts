// RM-1 · Reveal theater. Pure config + the reveal state machine (no React, no
// DOM) so the tier→effect mapping and the skip rules are unit-testable and each
// owner decision is one constant to flip.
//
// Presentation only: everything here reads the rarity the server ALREADY
// returned from the spin endpoint. Nothing feeds back into the request or the outcome.

import {
  RARITY_COLORS,
  RARITY_LABEL,
  RARITY_ORDER,
  type Rarity,
} from "@/lib/games/wheel/types";

/** The wheel's base spin length (unchanged by RM-1). */
export const SPIN_MS = 4400;
/** Reduced motion: the wheel jumps to the result after this long, no theater. */
export const REDUCED_SPIN_MS = 400;
/** Hard cap on what the theater may add to any spin (slower stop + stop beat). */
export const MAX_THEATER_EXTRA_MS = 1500;
/** Slack on top of the longest theater before the stuck-spin watchdog fires. */
export const WATCHDOG_MARGIN_MS = 4000;
/** Stuck-spin watchdog (SpinClient). Must outlast the longest theater. */
export const SPIN_WATCHDOG_MS = SPIN_MS + MAX_THEATER_EXTRA_MS + WATCHDOG_MARGIN_MS;

/**
 * Owner decision D1 ("when does the rarity show?"). Default: option (b), a
 * build-up in the last ~1s of the spin for epic and legendary.
 *   []                          → option (a): rarity only shows after the stop
 *   ["epic", "legendary"]       → option (b) (recommended, default)
 *   ["rare", "epic", "legendary"] → closest to option (c)
 */
export const BUILD_UP_RARITIES: readonly Rarity[] = ["epic", "legendary"];

/**
 * Tap-to-skip. Skip is offered once the fan has finished this many spins in
 * the current browser session (the first spin always plays in full). 0 offers
 * it from the very first spin.
 */
export const SKIP_AFTER_SPINS = 1;
/** Tapping the dimmed backdrop also skips (not only the Skip button). */
export const SKIP_ON_BACKDROP_TAP = true;
/** Escape skips too, so keyboard users get the same shortcut. */
export const SKIP_ON_ESCAPE = true;
/**
 * What a skip lands on: the final revealed card, shown at once with no entrance
 * animation and no confetti. The win sound and haptic still play (when unmuted)
 * because they carry the rarity in one short beat.
 */
export const SKIP_LANDING = { entrance: "static", confetti: false, sound: true } as const;

export type StopEffect = "lift" | "spotlight" | "burst";
export type BuildUpSound = "none" | "swell" | "rumble";

export interface RevealTierConfig {
  rarity: Rarity;
  label: string;
  /** The rarity colour (not the prize's custom colour): glows, frame, pill. */
  color: string;
  /** 1 (common) … 5 (legendary): drawn as pips so the card shows rarity at rest. */
  rank: number;
  /** Whether this spin gets the pre-stop build-up (dim + glow). */
  buildUp: boolean;
  /** Extra deceleration added to the spin (0 without a build-up). */
  extraMs: number;
  /** The build-up starts this long before the wheel stops. */
  buildUpLeadMs: number;
  /** Page dim during the build-up, 0–1. */
  dim: number;
  /** Gold light rays behind the wheel during the build-up. */
  rays: boolean;
  buildUpSound: BuildUpSound;
  /** What the wheel does on the winning slice once it stops. */
  stopEffect: StopEffect;
  /** Canvas dim on the non-winning slices after the stop, 0–1. */
  spotlightDim: number;
  /** Hold on the landed slice before the card opens. */
  stopBeatMs: number;
  /** Confetti pieces on the card (0 = none). */
  confetti: number;
  /** navigator.vibrate pattern at the stop (only when sound is on). */
  haptic: number | number[];
  /** Medallion diameter on the card, px. */
  medallionPx: number;
  /** Share is the primary (first, filled) button on the card. */
  sharePrimary: boolean;
  /** Whether any of this tier's effects animate (false under reduced motion). */
  animate: boolean;
}

type TierBase = Omit<RevealTierConfig, "rarity" | "label" | "color" | "rank" | "buildUp" | "animate">;

/**
 * The tier→effect table (proposal RM-1, "What the fan sees"). Build-up fields
 * only apply when the rarity is in BUILD_UP_RARITIES and motion is allowed.
 */
export const REVEAL_TIERS: Record<Rarity, TierBase> = {
  common: {
    extraMs: 0,
    buildUpLeadMs: 0,
    dim: 0,
    rays: false,
    buildUpSound: "none",
    stopEffect: "lift",
    spotlightDim: 0,
    stopBeatMs: 0,
    confetti: 0,
    haptic: 16,
    medallionPx: 112,
    sharePrimary: false,
  },
  uncommon: {
    extraMs: 0,
    buildUpLeadMs: 0,
    dim: 0,
    rays: false,
    buildUpSound: "none",
    stopEffect: "lift",
    spotlightDim: 0,
    stopBeatMs: 0,
    confetti: 0,
    haptic: 16,
    medallionPx: 112,
    sharePrimary: false,
  },
  rare: {
    extraMs: 300,
    buildUpLeadMs: 900,
    dim: 0.55,
    rays: false,
    buildUpSound: "swell",
    stopEffect: "spotlight",
    spotlightDim: 0.4,
    stopBeatMs: 300,
    confetti: 0,
    haptic: [14, 30, 14],
    medallionPx: 120,
    sharePrimary: false,
  },
  epic: {
    extraMs: 500,
    buildUpLeadMs: 1000,
    dim: 0.7,
    rays: false,
    buildUpSound: "swell",
    stopEffect: "burst",
    spotlightDim: 0.5,
    stopBeatMs: 400,
    confetti: 70,
    haptic: [18, 40, 18],
    medallionPx: 132,
    sharePrimary: false,
  },
  legendary: {
    extraMs: 1000,
    buildUpLeadMs: 1200,
    dim: 0.7,
    rays: true,
    buildUpSound: "rumble",
    stopEffect: "burst",
    spotlightDim: 0.55,
    stopBeatMs: 500,
    confetti: 110,
    haptic: [30, 40, 30, 40, 80],
    medallionPx: 144,
    sharePrimary: true,
  },
};

function isRarity(r: unknown): r is Rarity {
  return typeof r === "string" && (RARITY_ORDER as string[]).includes(r);
}

/**
 * The effective reveal for one win. Reduced motion collapses it to a calm,
 * static reveal: no added time, no build-up, no stop beat, no confetti. An
 * unknown rarity (bad data) falls back to common rather than throwing.
 */
export function resolveRevealTier(
  rarity: Rarity | string | null | undefined,
  opts: { reducedMotion?: boolean; buildUpRarities?: readonly Rarity[] } = {}
): RevealTierConfig {
  const r: Rarity = isRarity(rarity) ? rarity : "common";
  const reduced = opts.reducedMotion === true;
  const base = REVEAL_TIERS[r];
  const buildUp = !reduced && (opts.buildUpRarities ?? BUILD_UP_RARITIES).includes(r);
  const cfg: RevealTierConfig = {
    ...base,
    rarity: r,
    label: RARITY_LABEL[r],
    color: RARITY_COLORS[r],
    rank: RARITY_ORDER.indexOf(r) + 1,
    buildUp,
    animate: !reduced,
  };
  if (!buildUp) {
    cfg.extraMs = 0;
    cfg.buildUpLeadMs = 0;
    cfg.dim = 0;
    cfg.rays = false;
    cfg.buildUpSound = "none";
  }
  if (reduced) {
    cfg.stopBeatMs = 0;
    cfg.confetti = 0;
  }
  return cfg;
}

/** Total spin animation length for a tier (the wheel's own clock). */
export function spinDurationMs(tier: RevealTierConfig): number {
  return tier.animate ? SPIN_MS + tier.extraMs : REDUCED_SPIN_MS;
}

/** Time the theater adds over a plain spin: slower stop + the stop beat. */
export function theaterExtraMs(tier: RevealTierConfig): number {
  return tier.extraMs + tier.stopBeatMs;
}

/** Ms after the spin starts at which the build-up begins (null = no build-up). */
export function nearStopAtMs(tier: RevealTierConfig): number | null {
  if (!tier.buildUp || tier.buildUpLeadMs <= 0) return null;
  return Math.max(0, spinDurationMs(tier) - tier.buildUpLeadMs);
}

// ---------------------------------------------------------------------------
// Reveal state machine. SpinClient drives it; the wheel and overlays read it.
//
//   idle ─start→ spinning ─nearStop→ buildup ─stop→ landed ─beatDone→ revealed ─close→ idle
//                    └──────────────stop──────────────┘ (no beat) ──→ revealed
//   skip: spinning/buildup → flags `skipped` (the wheel snaps, then fires stop
//         → revealed at once); landed → revealed. Ignored anywhere else.

export type RevealPhase = "idle" | "spinning" | "buildup" | "landed" | "revealed";

export interface RevealState {
  phase: RevealPhase;
  tier: RevealTierConfig | null;
  skipped: boolean;
  /** Spins the fan had finished this session when this one started. */
  spinsBefore: number;
}

export type RevealEvent =
  | { type: "start"; rarity: Rarity | string; reducedMotion: boolean; spinsBefore?: number }
  | { type: "nearStop" }
  | { type: "stop" }
  | { type: "beatDone" }
  | { type: "skip" }
  | { type: "close" };

export const REVEAL_IDLE: RevealState = { phase: "idle", tier: null, skipped: false, spinsBefore: 0 };

export function revealReducer(state: RevealState, event: RevealEvent): RevealState {
  switch (event.type) {
    case "start":
      return {
        phase: "spinning",
        tier: resolveRevealTier(event.rarity, { reducedMotion: event.reducedMotion }),
        skipped: false,
        spinsBefore: Math.max(0, event.spinsBefore ?? 0),
      };
    case "nearStop":
      if (state.phase !== "spinning" || !state.tier?.buildUp || state.skipped) return state;
      return { ...state, phase: "buildup" };
    case "stop":
      if (state.phase !== "spinning" && state.phase !== "buildup") return state;
      if (state.skipped || !state.tier || state.tier.stopBeatMs <= 0) {
        return { ...state, phase: "revealed" };
      }
      return { ...state, phase: "landed" };
    case "beatDone":
      return state.phase === "landed" ? { ...state, phase: "revealed" } : state;
    case "skip":
      if (state.phase === "spinning" || state.phase === "buildup") {
        return state.skipped ? state : { ...state, skipped: true };
      }
      if (state.phase === "landed") return { ...state, phase: "revealed", skipped: true };
      return state;
    case "close":
      return state.phase === "revealed" ? { ...REVEAL_IDLE, spinsBefore: state.spinsBefore } : state;
  }
}

/** A spin is on screen (button stays busy) from start until the card opens. */
export function revealInFlight(phase: RevealPhase): boolean {
  return phase === "spinning" || phase === "buildup" || phase === "landed";
}

/**
 * Whether the Skip control is offered right now. Counted from the spins
 * finished BEFORE this one started, so the session's first spin plays in full
 * (including its landed hold) even though it counts as finished at the stop.
 */
export function canSkip(args: {
  phase: RevealPhase;
  skipped: boolean;
  spinsBefore: number;
  reducedMotion: boolean;
}): boolean {
  if (args.reducedMotion || args.skipped) return false;
  if (!revealInFlight(args.phase)) return false;
  return args.spinsBefore >= SKIP_AFTER_SPINS;
}

/** The dim overlay shows from the build-up until the card opens. */
export function theaterVisible(state: RevealState): boolean {
  return !!state.tier?.buildUp && !state.skipped && (state.phase === "buildup" || state.phase === "landed");
}

/** How the card enters: skipped or reduced-motion reveals land static. */
export function revealEntrance(state: RevealState): "animated" | "static" {
  if (state.skipped) return SKIP_LANDING.entrance;
  return state.tier?.animate === false ? "static" : "animated";
}

/** Confetti for the card, after skip/reduced-motion rules. */
export function revealConfetti(state: RevealState): number {
  if (!state.tier) return 0;
  if (state.skipped && !SKIP_LANDING.confetti) return 0;
  return state.tier.confetti;
}

// Session counter for "skip shows after the first spin of a session". Stored
// in sessionStorage so it survives a reload in the same tab; every access is
// guarded because storage can be blocked (private mode, sandboxed previews).
const SESSION_KEY = "ff:reveal:spins";

export function readSessionSpins(): number {
  try {
    const n = Number(window.sessionStorage.getItem(SESSION_KEY) ?? "0");
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

export function bumpSessionSpins(current: number): number {
  const next = current + 1;
  try {
    window.sessionStorage.setItem(SESSION_KEY, String(next));
  } catch {
    /* storage unavailable: the in-memory count still works for this page */
  }
  return next;
}
