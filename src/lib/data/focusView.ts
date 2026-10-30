import type { CampaignPack } from "./types";
import type { Rarity } from "@/lib/games/wheel/types";

export interface FanOddsView { rows: { prizeId: string; chance: number }[]; pityForced: boolean; chaseForced: boolean }

export type FocusKind = "focus" | "chase";
export type FocusPauseReason = "sold_out" | "other_wheel" | "no_increase" | "pity" | "unavailable" | "on_break";
/** Explicit public projection. Never add fan, grant, reservation or code identities. */
export interface FanFocusView {
  kind: FocusKind;
  prizeId: string;
  prizeLabel: string;
  prizeEmoji?: string;
  multiplier: number;
  totalSpins: number;
  spinsLeft: number;
  chaseWithin: number;
  chaseCounter: number;
  status: "active" | "paused" | "completed" | "cancelled";
  pauseReason: FocusPauseReason | null;
}
export interface CreatorFocusView {
  /** Creator-only compare-and-swap target for cancelling this exact promise. */
  focusId: string | null;
  focus: FanFocusView | null;
  targets: { id: string; label: string; wishlisted: boolean; emoji?: string; rarity: Rarity; weight: number; wheelId: string; wheelTitle: string; available: boolean; finite: boolean; delivery: string }[];
  passes: { id: string; spinsRemaining: number; wheelId: string; wheelTitle: string }[];
  canGrant: boolean;
  blockedReason?: "blocked" | "self_excluded" | "on_break" | "active_focus" | "no_active_pass" | "focus_disabled";
  packs: CampaignPack[];
  focusEnabled: boolean;
  chaseEnabled: boolean;
}
/** Internal service row; it must always pass through toFanFocusView before serialization. */
export interface FocusRow {
  id?: string;
  kind?: string;
  pack_kind?: string;
  prize_id: string;
  prize_label?: string;
  prize_emoji?: string | null;
  multiplier?: number;
  focus_multiplier?: number;
  total_spins?: number;
  focus_spins?: number;
  spins_left?: number;
  focus_spins_left?: number;
  chase_within?: number;
  chase_counter?: number;
  status?: string;
  pause_reason?: string | null;
  wheel_id?: string;
  fan_pass_id?: string;
  grant_id?: string;
  version?: number;
  created_at?: string;
  ended_at?: string | null;
}
export function toFanFocusView(row: FocusRow | null | undefined): FanFocusView | null {
  if (!row) return null;
  const status = row.status === "done" ? "completed" : row.status === "released" ? "cancelled" : row.status === "completed" || row.status === "cancelled" || row.status === "paused" ? row.status : "active";
  const reason = row.pause_reason;
  const pauseReason = reason === "sold_out" || reason === "other_wheel" || reason === "no_increase" || reason === "pity" || reason === "unavailable" || reason === "on_break" ? reason : null;
  return {
    kind: row.kind === "chase" || row.pack_kind === "chase" ? "chase" : "focus",
    prizeId: row.prize_id,
    prizeLabel: row.prize_label ?? "Selected prize",
    ...(row.prize_emoji ? { prizeEmoji: row.prize_emoji } : {}),
    multiplier: Number(row.multiplier ?? row.focus_multiplier ?? 3),
    totalSpins: row.total_spins ?? row.focus_spins ?? 10,
    spinsLeft: row.spins_left ?? row.focus_spins_left ?? 0,
    chaseWithin: row.chase_within ?? row.total_spins ?? 10,
    chaseCounter: row.chase_counter ?? 0,
    status, pauseReason,
  };
}
