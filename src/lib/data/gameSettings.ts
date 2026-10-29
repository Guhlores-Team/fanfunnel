import "server-only";
import { parseGameSettings, type GameSettings, type BingoDraftSettings } from "@/lib/games/core/gameProof";
import type { AnyClient } from "./shared";
/** Server profile capabilities; the base wheel is always available. */
export function creatorGameFeatures(raw: unknown): Record<string, boolean> & { wheel: true; scratch: boolean; bingo: boolean } {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { ...Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === "boolean")) as Record<string, boolean>, wheel: true, scratch: value.scratch === true, bingo: value.bingo === true };
}
export type CreatorGameSettings = GameSettings | { gameKind:"bingo";gameConfig:BingoDraftSettings };
export function gameSettings(kind: unknown = "wheel", config?: unknown, allowDraft = false): CreatorGameSettings {
  if(kind === "bingo" && allowDraft && (config === undefined || (config && typeof config === "object" && !Array.isArray(config) && Object.keys(config).sort().join() === "linePrizeId,size" && (config as BingoDraftSettings).size === 3 && (config as BingoDraftSettings).linePrizeId === null))) return {gameKind:"bingo",gameConfig:{size:3,linePrizeId:null}};
  const parsed = parseGameSettings(kind, config ?? (kind === "scratch" ? { style: "classic" } : {}));
  if (!parsed) throw new Error("invalid_game_config");
  return parsed;
}
export async function requireGameFeature(sb: AnyClient, creatorId: string, kind: GameSettings["gameKind"]): Promise<void> {
  if (kind === "wheel") return;
  const { data, error } = await sb.from("profiles").select("features").eq("id", creatorId).maybeSingle();
  if (error || !creatorGameFeatures(data?.features)[kind]) throw new Error("feature_disabled");
}

/** Database errors cross the HTTP boundary only through this fixed allowlist. */
export function gameWriteError(error: { message?: string } | null | undefined): string {
  const message = error?.message ?? "";
  if(message === "creator_unavailable")return "forbidden";
  return ["feature_disabled", "game_kind_locked", "invalid_game_config", "game_unavailable", "game_not_ready", "game_in_use", "bingo_active_card", "bingo_needs_cells", "bingo_needs_fallback"].find(code => message === code || message.startsWith(code + ":")) ?? "db_error";
}
