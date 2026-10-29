"use client";

import { useEffect } from "react";
import type { GamePresentation } from "@/lib/games/core/play";
import type { BingoState } from "@/lib/games/bingo/engine";
import type { FanGameKind } from "./gameOutcome";
import BingoCard from "./BingoCard";
import ScratchTicket from "./ScratchTicket";

/** Only the wheel has a rotating animation. Other games complete one primary presentation. */
export default function FanGameStage({ kind, presentation, card, receiptKey, prizeLabel, recovered, reducedMotion, onComplete }: {
  kind: Exclude<FanGameKind, "wheel">;
  presentation: GamePresentation | null;
  card: BingoState | null;
  receiptKey: string | null;
  prizeLabel?: string;
  recovered: boolean;
  reducedMotion: boolean;
  onComplete: () => void;
}) {
  useEffect(() => {
    if (presentation?.kind !== "bingo" || !receiptKey) return;
    const timer = setTimeout(onComplete, 120);
    return () => clearTimeout(timer);
  }, [presentation, receiptKey, onComplete]);
  if (kind === "bingo") return <BingoCard card={card} presentation={presentation?.kind === "bingo" ? presentation : null} prizeLabel={prizeLabel} savedPlay={recovered} />;
  if (presentation?.kind === "scratch" && receiptKey) return <ScratchTicket key={receiptKey} presentation={presentation} reducedMotion={reducedMotion || recovered} onReveal={onComplete} />;
  return <section aria-label="Scratch ticket" className="w-full rounded-2xl border border-line bg-surface p-5 text-center" data-testid="scratch-ready">
    <h2 className="text-lg font-bold text-ink">Scratch ticket</h2>
    <p className="mt-2 text-sm text-muted">One play uses one spin credit and gives you a winning ticket. Reveal all is always available after your ticket arrives.</p>
    <div aria-hidden="true" className="mt-4 grid grid-cols-3 gap-2">{Array.from({ length: 9 }, (_, index) => <span key={index} className="grid h-16 place-items-center rounded-lg border border-line bg-base text-lg text-muted">◇</span>)}</div>
  </section>;
}
