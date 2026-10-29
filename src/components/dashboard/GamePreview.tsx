"use client";

import Wheel from "@/components/Wheel";
import { bingoEligible } from "@/lib/games/bingo/engine";
import { creatorGameKind, type CreatorGameWheel } from "./gameEditor";

export default function GamePreview({ wheel }: { wheel: CreatorGameWheel }) {
  const kind = creatorGameKind(wheel);
  if (kind === "wheel") return <Wheel prizes={wheel.prizes} brandColor={wheel.brandColor ?? "#ec4899"} labelColor={wheel.labelColor} labelSize={wheel.labelSize} result={null} size={280} />;
  if (kind === "scratch") return <div className="w-full max-w-[280px] space-y-3" data-testid="scratch-creator-preview"><div aria-hidden="true" className="grid grid-cols-3 gap-2 rounded-2xl border border-line p-3">{Array.from({ length: 9 }, (_, index) => <span key={index} className="flex aspect-square items-center justify-center rounded-lg bg-[var(--brand)]/20 text-xl font-bold text-ink">?</span>)}</div><p className="text-center text-xs text-muted">Classic ticket layout. Fans can scratch or choose Reveal all after playing. No result is shown in this preview.</p></div>;
  const eligible = wheel.prizes.filter(bingoEligible).slice(0, 9);
  return <div className="w-full max-w-[280px] space-y-3" data-testid="bingo-creator-preview"><table className="w-full table-fixed border-separate border-spacing-1.5"><caption className="sr-only">Example 3 by 3 bingo layout, without marks</caption><tbody>{[0, 1, 2].map((row) => <tr key={row}>{[0, 1, 2].map((column) => { const prize = eligible[row * 3 + column]; return <td key={column} className="h-20 rounded-lg border border-line px-1 py-2 text-center"><span aria-hidden="true" className="block text-xl">{prize?.emoji ?? "◇"}</span><span className="mt-1 block truncate text-[10px] text-ink">{prize?.label ?? "Add a prize"}</span></td>; })}</tr>)}</tbody></table><p className="text-center text-xs text-muted">Example layout. Each fan gets a random card on their first play. Saved marks stay on that card until it is complete.</p></div>;
}
