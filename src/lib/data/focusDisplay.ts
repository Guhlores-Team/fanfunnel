import { isOnBreak } from "@/lib/play/playGuard";
import { buildFocusPoolSnapshot, snapshotOdds } from "@/lib/games/wheel/fairnessV3";
import { hasLimitedPrize, showsStock, toPublicStockMap } from "@/lib/games/wheel/publicView";
import type { PublicStock, WheelConfig } from "@/lib/games/wheel/types";
import { toFanFocusView, type FanFocusView, type FanOddsView, type FocusRow } from "./focusView";
/** All probability math comes from the same builder and odds function as a committed draw. */
export function focusDisplay(row: FocusRow | null | undefined, wheel: WheelConfig, options: { pityCounter: number; happyHourMultiplier: number | null; reserved: boolean; breakUntil?: string | null }): { focus: FanFocusView | null; odds?: FanOddsView; stock?: Record<string, PublicStock> } {
  const focus = toFanFocusView(row);
  const active = focus && (focus.status === "active" || focus.status === "paused");
  try {
    const snapshot = buildFocusPoolSnapshot(wheel, {
      pityCounter: options.pityCounter, happyHourMultiplier: options.happyHourMultiplier,
      ...(active && focus.kind === "focus" ? { focus: { prizeId: focus.prizeId, multiplier: focus.multiplier, spinsLeft: focus.spinsLeft, totalSpins: focus.totalSpins } } : {}),
      ...(active && focus.kind === "chase" ? { chase: { prizeId: focus.prizeId, counter: focus.chaseCounter, within: focus.chaseWithin, reserved: options.reserved } } : {}),
    });
    const proof = snapshot.modifiers.focus ?? snapshot.modifiers.chase;
    const reason = isOnBreak(options.breakUntil) ? "on_break" as const : proof?.pauseReason ?? null;
    const projected = active ? { ...focus, status: reason ? "paused" as const : "active" as const, pauseReason: reason } : null;
    const odds = snapshotOdds(snapshot);
    return { focus: projected, ...(hasLimitedPrize(wheel.prizes) ? { stock: toPublicStockMap(wheel.prizes, showsStock(wheel)) } : {}), odds: { pityForced: odds.pityForced, chaseForced: odds.chaseForced,
      rows: wheel.prizes.map(prize => ({ prizeId: prize.id, chance: odds.rows.find(row => row.prize.id === prize.id)?.chance ?? 0 })) } };
  } catch {
    return { focus: active ? { ...focus, status: "paused", pauseReason: "unavailable" } : null };
  }
}

/** A held chase unit is personally available even when the shared free pool is empty. */
export function applyFocusStock(wheel: import("@/lib/games/wheel/types").PublicWheelConfig, stock: Record<string, PublicStock> | undefined): import("@/lib/games/wheel/types").PublicWheelConfig {
  if (!stock) return wheel;
  return { ...wheel, prizes: wheel.prizes.map(prize => {
    const { stock: _stock, soldOut: _soldOut, ...display } = prize;
    return { ...display, ...(stock[prize.id] ?? {}) };
  }) };
}
