import type { WheelConfig } from "@/lib/games/wheel/types";

/**
 * C16 (app side): what the editor would overwrite on save. Two tabs (or a team
 * member) editing one game must not silently replace each other's prizes, so a
 * save first re-reads the game and compares it with what this editor loaded.
 *
 * Left out on purpose: stock (fans' plays lower it; the save already sends the
 * loaded stock and SQL applies only the creator's delta), and lifecycle fields
 * (active / schedule / archive), which other controls change on their own.
 */
export function gameFingerprint(wheel: WheelConfig): string {
  return JSON.stringify({
    id: wheel.id,
    title: wheel.title,
    subtitle: wheel.subtitle ?? null,
    brandColor: wheel.brandColor ?? null,
    labelColor: wheel.labelColor ?? null,
    labelSize: wheel.labelSize ?? null,
    showStock: wheel.showStock ?? null,
    gameKind: wheel.gameKind ?? "wheel",
    gameConfig: wheel.gameConfig ?? {},
    prizes: wheel.prizes.map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description ?? null,
      rarity: p.rarity,
      weight: p.weight,
      color: p.color ?? null,
      emoji: p.emoji ?? null,
      imageUrl: p.imageUrl ?? null,
      cost: p.cost ?? null,
      limited: p.stock != null,
      delivery: p.delivery ?? "manual",
      boostable: p.boostable === true,
    })),
  });
}

export type StaleCheck = "same" | "changed" | "new";

/** `loadedJson`: the editor's saved snapshot. "new": nothing saved to compare. */
export function staleGameCheck(loadedJson: string, current: WheelConfig): StaleCheck {
  let loaded: WheelConfig;
  try { loaded = JSON.parse(loadedJson) as WheelConfig; } catch { return "new"; }
  if (!loaded?.id || loaded.id !== current.id) return "new";
  return gameFingerprint(loaded) === gameFingerprint(current) ? "same" : "changed";
}

export const STALE_GAME_MESSAGE = "This game was changed in another tab or by a team member. Reload to see the latest.";
