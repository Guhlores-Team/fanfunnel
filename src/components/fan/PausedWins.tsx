"use client";

import type { PausedFanWins } from "@/lib/fan/pausedTypes";
import { RARITY_LABEL } from "@/lib/games/wheel/types";
import { deliveryLabel, winDate } from "@/lib/fan/delivery";
import LegalLinks from "@/components/LegalLinks";
import InstantReward from "./InstantReward";
import SafetyMenu from "./SafetyMenu";
import { LinkPauseProvider } from "./LinkPauseProvider";
import { LeaderboardWithdrawal } from "./FanLeaderboard";

/**
 * T3: what a paused link shows instead of a 404. Read-only: no SPIN, no chat,
 * no wishlist. The fan keeps their wins (prize, date, delivery state, verify
 * link), any instant reward they already revealed, and the Safety & privacy
 * menu (report, download, delete). Pausing is permanent, so nothing here
 * offers to resume.
 */
export default function PausedWins({ token, view }: { token: string; view: PausedFanWins }) {
  return (
    <main className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center overflow-x-clip px-4 pt-10 pb-16">
      <LinkPauseProvider>
        <div className="relative z-[1] w-full max-w-md">
          <div className="card rounded-2xl p-5 text-center">
            <span aria-hidden="true" className="text-3xl">⏸️</span>
            <h1 className="mt-2 text-lg font-bold text-ink">Your link is paused</h1>
            <p className="mt-2 text-sm text-muted text-pretty">
              You paused your link with {view.creatorTitle} on {winDate(view.pausedAt)}. Pausing is permanent, so this
              link can&rsquo;t play or chat any more. Your wins stay here for you to look back on.
            </p>
          </div>

          <section aria-labelledby="paused-wins-title" className="mt-5" data-testid="paused-wins">
            <h2 id="paused-wins-title" className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted">
              Your wins
            </h2>
            {view.wins.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No wins on this link.</p>
            ) : (
              <ul className="mt-2 space-y-2.5">
                {view.wins.map((win, i) => (
                  <li key={win.shareId ?? `${win.label}-${win.at}-${i}`} data-testid="paused-win" className="card min-w-0 rounded-2xl p-4">
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
                      <p className="min-w-0 break-words font-bold text-ink">{win.label}</p>
                      <span className="shrink-0 text-xs text-muted">{RARITY_LABEL[win.rarity] ?? win.rarity}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted">Won {winDate(win.at)}</p>
                    {win.delivery && (
                      <p className="mt-1 text-xs text-ink" data-testid="win-delivery-status" data-status={win.delivery.status}>
                        {deliveryLabel(win.delivery)}
                      </p>
                    )}
                    {win.reward && (
                      <details className="mt-2 text-sm">
                        <summary className="min-h-11 cursor-pointer py-3 font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]">
                          Show your saved reward<span className="sr-only"> for {win.label}</span>
                        </summary>
                        <InstantReward reward={win.reward} />
                      </details>
                    )}
                    {win.rewardHidden && (
                      <p className="mt-2 text-xs text-muted">This win had an instant reward that can&rsquo;t be shown on a paused link.</p>
                    )}
                    {win.shareId && (
                      <a
                        href={`/verify/${win.shareId}`}
                        className="mt-2 inline-flex min-h-11 items-center text-xs font-semibold text-ink underline underline-offset-4"
                      >
                        Check this win was fair<span className="sr-only"> ({win.label})</span>
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted text-pretty">
              Prizes come from the creator. If one you won never arrives, report it from Safety &amp; privacy below.
            </p>
          </section>

          {view.leaderboardOptIn && (
            <div className="mt-5">
              <LeaderboardWithdrawal token={token} onWithdrawn={() => {}} />
            </div>
          )}
        </div>
        <footer className="relative z-[1] mt-10 flex flex-col items-center gap-2 text-center text-[11px] tracking-wide text-muted">
          <span>Powered by FanFunnel</span>
          <SafetyMenu token={token} paused />
          <LegalLinks />
        </footer>
      </LinkPauseProvider>
    </main>
  );
}
