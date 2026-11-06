import { primarySnapshot } from "@/lib/games/core/gameProof";
import type { GameReplay } from "@/lib/games/core/replay";
import type { V3Replay } from "@/lib/games/wheel/fairnessV3";

/** The existing primary-odds table remains shared across all games. */
export function gameOddsReplay(replay: GameReplay): V3Replay {
  const primary = replay.draw?.primary;
  return {
    ok: replay.ok, snapshot: replay.snapshot ? primarySnapshot(replay.snapshot) : null,
    computedHash: replay.computedHash, poolHashOk: replay.poolHashOk, replayed: primary?.prize ?? null,
    excluded: replay.draw?.trace.excluded.flatMap((id) => replay.snapshot?.prizes.filter((p) => p.id === id) ?? []) ?? [],
    pityAwarded: primary?.pityAwarded ?? false, chaseAwarded: primary?.chaseAwarded ?? false,
    chaseCompleted: primary?.chaseCompleted ?? false, focusConsumed: primary?.focusConsumed ?? false,
    chaseConsumed: primary?.chaseConsumed ?? false, problem: replay.problem,
  };
}

export function GameProof({ replay }: { replay: GameReplay }) {
  if (!replay.ok || !replay.draw || !replay.snapshot) return null;
  const { presentation, bonuses } = replay.draw;
  const bonusPool = replay.snapshot.game === "bingo" ? replay.snapshot.bingo.bonus : null;
  return (
    <section aria-labelledby="game-proof-title" className="mt-6 border-t border-line pt-6">
      <h2 id="game-proof-title" className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
        {presentation.kind === "scratch" ? "Replayed scratch ticket" : "Replayed bingo card"}
      </h2>
      <p className="mt-2 text-xs text-muted">
        {presentation.kind === "scratch"
          ? "These nine cells come from the same recorded random stream after the prize draw. Exactly three match your prize; every other symbol appears once. Decorative shapes are not prizes. Scratching or Reveal all cannot change the win."
          : "The card before this play, the drawn prize, every new line and each bonus were replayed together. Every play awards its ordinary prize, including repeats and prizes outside the card."}
      </p>
      {presentation.kind === "scratch" ? (
        <ol aria-label="Scratch ticket cells, left to right by row" className="mt-4 grid grid-cols-3 gap-1.5">
          {presentation.cells.map((cell, index) => (
            <li key={index} className="min-w-0 rounded-lg border border-line bg-surface px-1.5 py-3 text-center">
              <span aria-hidden="true" className="block text-xl">{cell.emoji ?? "◇"}</span>
              <span className="mt-1 block break-words text-[11px] text-ink">{cell.label}</span>
              {cell.id === replay.draw?.primary.prize.id && cell.kind === "prize" ? <span className="block text-[10px] font-bold text-ink">Your prize</span> : null}
            </li>
          ))}
        </ol>
      ) : (
        <>
          <p className="mt-3 text-xs text-ink">
            {presentation.newCard ? "A new card began on this paid play." : "The existing card continued."}{" "}
            {presentation.markedIndex === null ? "The drawn prize is outside this card." : `Square ${presentation.markedIndex + 1} matches the drawn prize.`}
          </p>
          <table className="mt-3 w-full table-fixed border-separate border-spacing-1 text-center text-xs">
            <caption className="sr-only">Bingo card after this play. Marked squares include a check and text.</caption>
            <tbody>
              {[0, 1, 2].map((row) => <tr key={row}>
                {presentation.after.cells.slice(row * 3, row * 3 + 3).map((cell, column) => {
                  const marked = !!(presentation.after.markedMask & (1 << (row * 3 + column)));
                  return <td key={cell.id} className="break-words rounded-lg border border-line bg-surface px-1.5 py-3 align-top text-ink">
                    <span aria-hidden="true" className="block text-xl">{cell.emoji ?? "◇"}</span>
                    <span className="mt-1 block">{cell.label}</span>
                    <span className="mt-1 block text-[10px]">{marked ? "✓ Marked" : "Unmarked"}</span>
                  </td>;
                })}
              </tr>)}
            </tbody>
          </table>
          {bonuses.length ? (
            <ul className="mt-3 space-y-2 text-xs text-ink">
              {bonuses.map(({ line, prize }, index) => <li key={line}>
                Line {line + 1} bonus: {prize.label}.
                {replay.draw?.trace.bonuses[index].excluded.length ? " A finite candidate sold out; its recorded retry was replayed." : ""}
              </li>)}
            </ul>
          ) : <p className="mt-3 text-xs text-muted">No new line completed on this play.</p>}
          {bonusPool ? <details className="mt-4 rounded-lg border border-line p-3 text-xs text-ink">
            <summary className="cursor-pointer py-2 font-medium">Line bonus pool and draw order</summary>
            <p className="mt-2 text-muted">{bonusPool.selected
              ? `Configured reward: ${bonusPool.selected.label}. It is awarded directly when available (ordinary base tickets: ${bonusPool.selected.w}).`
              : "The configured reward was unavailable when this play was prepared, so new lines use the weighted fallback."}</p>
            <table className="mt-3 w-full table-fixed text-left text-[11px]">
              <caption className="sr-only">Committed rare-or-better fallback pool, before ordered stock failures</caption>
              <thead><tr className="border-b border-line"><th scope="col" className="w-[65%] py-2 pr-2">Fallback reward</th><th scope="col" className="py-2 text-right">Base tickets</th></tr></thead>
              <tbody>{bonusPool.fallback.map((p) => <tr key={p.id} className="border-b border-line/60">
                <th scope="row" className="break-words py-2 pr-2 font-normal">{p.label}<span className="block text-[10px] text-muted">{p.unlimited ? "Unlimited" : "Finite inventory"}</span></th>
                <td className="py-2 text-right align-top">{p.w}</td>
              </tr>)}</tbody>
            </table>
            <p className="mt-3 text-muted">Lines are checked in this order: three rows, three columns, then the two diagonals. A failed finite candidate is excluded from that line onward; earlier rewards stay the same.</p>
          </details> : null}
          <p className="mt-3 text-xs text-muted">An available configured line prize is awarded directly, even if its ordinary weight is zero. If it sold out, the fallback uses positive rare-or-better base tickets with no happy hour, pity, focus or chase. Bonuses do not mark more squares or use another play credit.</p>
        </>
      )}
      <p className="mt-3 break-all font-mono text-[10px] text-muted">Rules: {replay.snapshot.gameRules}</p>
    </section>
  );
}
