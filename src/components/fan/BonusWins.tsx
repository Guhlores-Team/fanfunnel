"use client";

import { useState } from "react";
import type { PublicPrize } from "@/lib/games/wheel/types";
import type { DeliveredReward } from "@/lib/rewards/config";
import InstantReward, { RewardUnavailable } from "./InstantReward";
import { parseDeliveredReward } from "./instantReward";
import { bingoLineLabel } from "./BingoCard";

/** Display projection only; data/SQL own the linked bonus and its authorization. */
export interface BonusWinView {
  line: number;
  prize: PublicPrize;
  shareId: string;
  instant?: boolean;
  reward?: DeliveredReward;
  awardedAt?: string;
}
function BonusWin({ win, token }: { win: BonusWinView; token: string }) {
  const [reward, setReward] = useState(() => parseDeliveredReward(win.reward));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const instant = win.instant === true || win.reward !== undefined;
  const view = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/fan/reward", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ token, shareId: win.shareId }) });
      const body = await response.json();
      const value = parseDeliveredReward(body.reward);
      if (!response.ok || !value) { setError("We could not open this bonus reward. Your win is saved; try Your wins or contact your creator."); return; }
      setReward(value);
    } catch { setError("We could not open this bonus reward. Your win is saved; check your connection and try again."); }
    finally { setBusy(false); }
  };
  return <li className="min-w-0 rounded-xl border border-line bg-base p-3" data-testid="bingo-bonus" data-bonus-line={win.line}>
    <h4 className="text-sm font-bold text-ink">{bingoLineLabel(win.line)} bonus</h4>
    <p className="mt-2 break-words text-sm text-ink [overflow-wrap:anywhere]"><span aria-hidden="true">{win.prize.emoji ?? "🎁"} </span>{win.prize.label}</p>
    {reward ? <InstantReward reward={reward} /> : instant ? <>
      <RewardUnavailable />
      <button type="button" disabled={busy} onClick={view} data-testid="bonus-view-reward" aria-label={`View bonus reward for ${bingoLineLabel(win.line)}`}
        className="mt-3 min-h-11 rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]">{busy ? "Opening reward…" : "View bonus reward"}</button>
    </> : <p className="mt-2 text-xs text-muted">Send this bonus win to your creator to claim it.</p>}
    {error && <p role="alert" className="mt-2 text-sm text-amber-200">{error}</p>}
    {/^[A-Za-z0-9_-]{1,64}$/.test(win.shareId) && <a href={`/verify/${encodeURIComponent(win.shareId)}`} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
      className="mt-3 inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-semibold text-[var(--brand-text)] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]">Verify this line bonus<span className="sr-only"> in a new tab</span></a>}
  </li>;
}
/** Shares the primary RewardReveal focus trap. No nested reward dialogs. */
export default function BonusWins({ wins, token }: { wins: readonly BonusWinView[]; token: string }) {
  if (!wins.length) return null;
  return <section className="mt-5 min-w-0 text-left" aria-label="Bingo line bonus rewards" data-testid="bingo-bonus-rewards">
    <h3 className="text-base font-bold text-ink">{wins.length === 1 ? "Line complete!" : `${wins.length} lines complete!`}</h3>
    <p className="mt-1 text-xs text-muted">These bonus wins use no extra spin credit. You can reopen private rewards from Your wins.</p>
    <ol className="mt-3 space-y-3">{wins.map(win => <BonusWin key={win.shareId} win={win} token={token} />)}</ol>
  </section>;
}
