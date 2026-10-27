import { RARITY_LABEL } from "@/lib/games/wheel/types";
import { snapshotOdds, type V3Replay } from "@/lib/games/wheel/fairnessV3";
import { ODDS_LIMIT_LINE, ODDS_LOCKED_LINE, formatChance, modifierLines } from "./oddsCopy";

/**
 * Fairness v3: the odds that were in force for this spin, the modifiers behind
 * them, and whether replaying the recorded inputs reproduces the result. Only
 * fan-safe fields reach here (the snapshot is built from PublicPrize).
 */
export function OddsUsed({ replay, poolHash }: { replay: V3Replay; poolHash: string | null }) {
  const s = replay.snapshot;
  const odds = s ? snapshotOdds(s) : null;
  const wonId = replay.ok ? replay.replayed?.id : null;

  return (
    <section aria-labelledby="odds-used-title" className="mt-6 border-t border-line pt-6">
      <h2
        id="odds-used-title"
        className="text-xs font-medium uppercase tracking-[0.14em] text-muted"
      >
        Odds used for this spin
      </h2>

      <p className="mt-2 text-sm font-bold text-ink">
        {replay.ok ? (
          <>
            <span aria-hidden="true">✓ </span>Replayed: these odds and seeds draw{" "}
            {replay.replayed?.emoji ? `${replay.replayed.emoji} ` : ""}
            {replay.replayed?.label}
          </>
        ) : (
          <>
            <span aria-hidden="true">✗ </span>Replay failed
          </>
        )}
      </p>
      {replay.ok ? null : (
        <p className="mt-1 text-xs text-muted text-pretty">{replay.problem}</p>
      )}

      <p className="mt-3 text-xs text-ink text-pretty">{ODDS_LOCKED_LINE}</p>

      {s && odds ? (
        <>
          <ul className="mt-3 space-y-1 text-xs text-muted">
            {modifierLines(s, odds.pityForced).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          <table className="mt-4 w-full table-fixed border-collapse text-left text-xs">
            <caption className="sr-only">
              Each prize in the pool for this spin, its tickets and its chance
            </caption>
            <thead>
              <tr className="border-b border-line text-muted">
                <th scope="col" className="w-[58%] py-2 pr-2 font-medium">
                  Prize
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  Tickets
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Chance
                </th>
              </tr>
            </thead>
            <tbody>
              {odds.rows.map(({ prize, chance }) => {
                const won = prize.id === wonId;
                return (
                  <tr
                    key={prize.id}
                    className={`border-b border-line/60 text-ink ${won ? "font-bold" : ""}`}
                  >
                    <th scope="row" className={`py-2 pr-2 align-top break-words ${won ? "font-bold" : "font-normal"}`}>
                      {prize.emoji ? <span aria-hidden="true">{prize.emoji} </span> : null}
                      {prize.label}
                      <span className="block text-[11px] font-normal text-muted">
                        {RARITY_LABEL[prize.rarity]}
                        {won ? " · your prize" : ""}
                      </span>
                    </th>
                    <td className="tnum py-2 pr-2 text-right align-top">{prize.w}</td>
                    <td className="tnum py-2 text-right align-top">{formatChance(chance)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {replay.excluded.length ? (
            <ul className="mt-3 space-y-1 text-xs text-muted">
              {replay.excluded.map((p, i) => (
                <li key={`${p.id}-${i}`}>
                  {p.emoji ? `${p.emoji} ` : ""}
                  {p.label} was drawn first but had just sold out, so the spin drew again from the
                  same random numbers.
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      <dl className="mt-4 space-y-4 text-sm">
        <div>
          <dt className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
            Odds fingerprint (SHA-256)
          </dt>
          <dd className="mt-1 break-all rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-ink">
            {poolHash ?? "Not recorded"}
          </dd>
          <dd className="mt-1 text-xs text-muted">
            {replay.poolHashOk
              ? "Re-hashing the odds above gives this fingerprint."
              : "Re-hashing the odds above does not give this fingerprint."}
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-[11px] leading-relaxed text-muted text-pretty">{ODDS_LIMIT_LINE}</p>
    </section>
  );
}
