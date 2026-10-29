import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { parseBingoState } from "@/lib/games/bingo/state";
import { bingoEligible, type BingoState } from "@/lib/games/bingo/engine";
import { parseGameSettings } from "@/lib/games/core/gameProof";
import type { WheelConfig } from "@/lib/games/core/types";
/** Ready games promise nine markable cells and an always-available line fallback. */
export function bingoReadyError(config: WheelConfig): string | null {
  const settings = parseGameSettings("bingo",config.gameConfig);
  if (!settings || settings.gameKind !== "bingo") return "invalid_game_config";
  const eligible = config.prizes.filter(bingoEligible);
  if (new Set(eligible.map(prize => prize.id)).size < 9) return "bingo_needs_cells";
  if (!eligible.some(prize => ["rare","epic","legendary"].includes(prize.rarity))) return "bingo_needs_fallback";
  if (!config.prizes.some(prize => prize.id === settings.gameConfig.linePrizeId)) return "invalid_game_config";
  return null;
}
/** `unavailable` is a paused or deactivated link (never a blocked fan: the read
 *  is not gated on blocking or creator approval, so the blocked page keeps its
 *  card). A failed read throws: the failure is unknown, never a fake empty first
 *  card, and callers keep recovery pending. */
export type BingoCardRead = { status: "ok"; card: BingoState | null } | { status: "unavailable" };
export async function readBingoCardState(token: string, sb: ReturnType<typeof createServiceClient> = createServiceClient()): Promise<BingoCardRead> {
  const { data,error } = await sb.rpc("get_bingo_card_state",{p_token:token});
  const result = data as unknown as {status?:string;card?:unknown}|null;
  if (error || !result || (result.status !== "ok" && result.status !== "unavailable")) throw new Error("bingo_card_unavailable");
  if (result.status === "unavailable") return { status: "unavailable" };
  if (result.card === null) return { status: "ok", card: null };
  const card = parseBingoState(result.card);
  if (!card) throw new Error("bingo_card_unavailable");
  return { status: "ok", card };
}
export async function readBingoCard(token: string, sb: ReturnType<typeof createServiceClient> = createServiceClient()): Promise<BingoState | null> {
  const read = await readBingoCardState(token, sb);
  if (read.status !== "ok") throw new Error("bingo_card_unavailable");
  return read.card;
}
