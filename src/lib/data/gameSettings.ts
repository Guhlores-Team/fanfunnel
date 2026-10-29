import "server-only";
import { parseGameSettings, type GameSettings } from "@/lib/games/core/gameProof";
import type { AnyClient } from "./shared";
/** 0060 activates scratch only. Bingo remains unavailable until its atomic ledger ships. */
export function creatorGameFeatures(raw: unknown): Record<string, boolean> & { wheel: true; scratch: boolean; bingo: false } {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { ...Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === "boolean")) as Record<string, boolean>, wheel: true, scratch: value.scratch === true, bingo: false };
}
export function gameSettings(kind: unknown = "wheel", config?: unknown): GameSettings {
  if (kind === "bingo") throw new Error("game_unavailable");
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
  return ["feature_disabled", "game_kind_locked", "invalid_game_config", "game_unavailable", "game_not_ready", "bingo_active_card", "bingo_needs_cells", "bingo_needs_fallback"].find(code => message === code || message.startsWith(code + ":")) ?? "db_error";
}
