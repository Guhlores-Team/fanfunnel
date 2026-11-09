import { isSupabaseConfigured, createServiceClient } from "@/lib/supabase/server";
import type { Rarity } from "@/lib/games/wheel/types";
import { openReward } from "@/lib/rewards/crypto";
import { rewardReviewAllowed, type DeliveredReward, type RewardKind } from "@/lib/rewards/config";
import { firstEmbedded, toWinDelivery, type WinDelivery } from "@/lib/fan/delivery";
import { publicCreatorTitle } from "@/lib/publicCreator";
import { isPlausibleToken } from "./privacy";
import { mockGetPausedFanWins } from "./mock";

/**
 * T3: pausing a link is permanent, but the fan keeps a read-only record of what
 * they won on it: each prize, its date, its delivery state, the verify link,
 * and an instant reward's value only when the fan already revealed it (views
 * >= 1). Nothing here plays, chats or counts a new reward view: the database
 * refuses those for a paused link (record_fan_reward_view requires
 * self_excluded_at is null) and this read does not try them. A blocked fan
 * gets the list without values, like the live page's reveal refusal.
 */
export interface PausedWin {
  label: string;
  rarity: Rarity;
  at: string;
  shareId: string | null;
  delivery?: WinDelivery;
  /** The already-revealed instant reward, or null when there is none to show. */
  reward: DeliveredReward | null;
  /** The win delivered an instant reward the fan can no longer view here. */
  rewardHidden: boolean;
}

export interface PausedFanWins {
  creatorTitle: string;
  pausedAt: string;
  /** Whether the fan is still on the public board, so they can leave it here. */
  leaderboardOptIn: boolean;
  wins: PausedWin[];
}

/** How many wins the paused view lists (newest first), like the live page. */
export const PAUSED_WINS_LIMIT = 50;

type SpinRow = {
  id: string;
  prize_label: string;
  prize_rarity: Rarity;
  share_id: string | null;
  created_at: string;
  redemption?: { status: string; fulfilled_at: string | null } | { status: string; fulfilled_at: string | null }[] | null;
  reward?: RewardRow | RewardRow[] | null;
};
type RewardRow = { kind: RewardKind; cipher: string | null; iv: string | null; key_version: number; views: number; erased_at: string | null; created_at: string };

/** The paused link's wins, or null when the token is not a paused link. */
export async function getPausedFanWins(token: string): Promise<PausedFanWins | null> {
  if (!isPlausibleToken(token)) return null;
  if (!isSupabaseConfigured()) return mockGetPausedFanWins(token);
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("fan_passes")
    .select("fan_id, creator_id, self_excluded_at, fan:fans(blocked_at, leaderboard_opt_in), creator:profiles!fan_passes_creator_id_fkey(display_name)")
    .eq("token", token)
    .maybeSingle();
  if (error || !data) return null;
  const pass = data as unknown as {
    fan_id: string;
    creator_id: string;
    self_excluded_at: string | null;
    fan: { blocked_at: string | null; leaderboard_opt_in: boolean | null } | null;
    creator: { display_name: string | null } | null;
  };
  if (!pass.self_excluded_at || !pass.fan) return null;
  const blocked = !!pass.fan.blocked_at;
  const { data: rows, error: spinsError } = await sb
    .from("spins")
    .select("id, prize_label, prize_rarity, share_id, created_at, redemption:redemptions(status, fulfilled_at), reward:spin_rewards(kind, cipher, iv, key_version, views, erased_at, created_at)")
    .eq("fan_id", pass.fan_id)
    .eq("creator_id", pass.creator_id)
    .order("created_at", { ascending: false })
    .limit(PAUSED_WINS_LIMIT);
  if (spinsError) return null;
  const wins = ((rows ?? []) as unknown as SpinRow[]).map((row): PausedWin => {
    const redemption = firstEmbedded(row.redemption);
    const delivery = redemption ? toWinDelivery(redemption.status, redemption.fulfilled_at) : undefined;
    const rw = firstEmbedded(row.reward);
    const reward = rw && !blocked ? revealedValue(rw, pass.creator_id) : null;
    return {
      label: row.prize_label,
      rarity: row.prize_rarity,
      at: row.created_at,
      shareId: row.share_id,
      ...(delivery ? { delivery } : {}),
      reward,
      rewardHidden: !!rw && !reward,
    };
  });
  return { creatorTitle: publicCreatorTitle(pass.creator?.display_name), pausedAt: pass.self_excluded_at, leaderboardOptIn: pass.fan.leaderboard_opt_in === true, wins };
}

/** Only a value the fan already saw, still held, inside the review window. */
function revealedValue(row: RewardRow, creatorId: string): DeliveredReward | null {
  if (row.erased_at || !row.cipher || !row.iv || !(row.views >= 1)) return null;
  if (!rewardReviewAllowed(row.created_at)) return null;
  try {
    return { kind: row.kind, value: openReward({ cipher: row.cipher, iv: row.iv, keyVersion: row.key_version }, creatorId) };
  } catch {
    return null;
  }
}
