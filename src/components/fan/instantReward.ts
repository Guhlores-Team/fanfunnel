import type { WonPrize } from "@/lib/data/types";
import { RARITY_ORDER } from "@/lib/games/wheel/types";
import {
  MAX_CODE_LENGTH,
  normalizeRewardLink,
  normalizeRewardText,
  type DeliveredReward,
} from "@/lib/rewards/config";

export interface InstantWinRef {
  shareId: string;
  at: string;
}

export interface InstantRewardHistoryWin extends InstantWinRef {
  label: string;
  rarity: WonPrize["rarity"];
}

export interface InstantRewardHistoryPage {
  wins: InstantRewardHistoryWin[];
  nextCursor: string | null;
}

/** Pick only public win references from the token-authorized history result. */
export function parseRewardHistoryPage(raw: unknown): InstantRewardHistoryPage | null {
  if (!raw || typeof raw !== "object") return null;
  const page = raw as { wins?: unknown; nextCursor?: unknown };
  if (!Array.isArray(page.wins)) return null;
  if (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor.length > 512)) return null;
  const wins: InstantRewardHistoryWin[] = [];
  for (const item of page.wins) {
    if (!item || typeof item !== "object") return null;
    const win = item as Record<string, unknown>;
    if (
      typeof win.shareId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(win.shareId) ||
      typeof win.label !== "string" || !win.label.trim() ||
      typeof win.at !== "string" || !Number.isFinite(Date.parse(win.at)) ||
      !RARITY_ORDER.includes(win.rarity as WonPrize["rarity"])
    ) return null;
    wins.push({ shareId: win.shareId, label: win.label, rarity: win.rarity as WonPrize["rarity"], at: win.at });
  }
  return { wins, nextCursor: page.nextCursor };
}

export interface GroupedWin {
  label: string;
  rarity: WonPrize["rarity"];
  emoji?: string;
  color?: string;
  count: number;
  latest: string;
  /** References only: reward values are fetched for an explicit view. */
  instantWins: InstantWinRef[];
}

/** Preserve the collection cards and each individual instant win behind one. */
export function groupWonPrizes(history: readonly WonPrize[]): GroupedWin[] {
  const map = new Map<string, GroupedWin>();
  for (const win of history) {
    const key = JSON.stringify([win.label, win.rarity]);
    let group = map.get(key);
    if (group) {
      group.count++;
      if (Date.parse(win.at) > Date.parse(group.latest)) group.latest = win.at;
    } else {
      group = {
        label: win.label,
        rarity: win.rarity,
        emoji: win.emoji,
        color: win.color,
        count: 1,
        latest: win.at,
        instantWins: [],
      };
      map.set(key, group);
    }
    if (
      win.instant &&
      typeof win.shareId === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(win.shareId) &&
      !group.instantWins.some((entry) => entry.shareId === win.shareId)
    ) {
      group.instantWins.push({ shareId: win.shareId, at: win.at });
    }
  }
  return [...map.values()]
    .map((group) => ({
      ...group,
      instantWins: group.instantWins.sort(
        (a, b) => Date.parse(b.at) - Date.parse(a.at) || a.shareId.localeCompare(b.shareId),
      ),
    }))
    .sort(
      (a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || b.count - a.count,
    );
}

/** Treat network JSON as untrusted, especially values used as link targets. */
export function parseDeliveredReward(raw: unknown): DeliveredReward | null {
  if (!raw || typeof raw !== "object") return null;
  const reward = raw as { kind?: unknown; value?: unknown };
  if (reward.kind === "link") {
    const value = normalizeRewardLink(reward.value);
    return value ? { kind: "link", value } : null;
  }
  if (reward.kind === "text") {
    const value = normalizeRewardText(reward.value);
    return value ? { kind: "text", value } : null;
  }
  if (
    reward.kind === "code" &&
    typeof reward.value === "string" &&
    reward.value.trim().length > 0 &&
    reward.value.length <= MAX_CODE_LENGTH
  ) {
    return { kind: "code", value: reward.value };
  }
  return null;
}

/** Never display a raw server error, which may contain sensitive details. */
export function rewardViewError(status: number): string {
  if (status === 429) return "Too many requests. Wait a moment, then try again.";
  if (status === 403) return "This link cannot open the reward right now. Contact your creator for help.";
  if (status === 404) return "This reward is no longer available through this link. Contact your creator for help.";
  if (status === 503) return "Your reward is temporarily unavailable. Please try again later or contact your creator.";
  return "We couldn't open your reward. Check your connection and try again.";
}
