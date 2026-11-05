"use client";

import type { GameKind } from "@/lib/games/core/gameProof";
import { bingoEligible, isRareBonus } from "@/lib/games/bingo/engine";
import { bingoMissing, bingoSquareCount, BINGO_CELL_COUNT, canCreateGame, creatorGameKind, creatorGameSettings, GAME_LABEL, gameDraftError, type CreatorGameWheel, type GameFeatures } from "./gameEditor";
import BingoValuePreview from "./BingoValuePreview";

export default function GameSettingsEditor({ wheel, features, disabled, onChange }: { wheel: CreatorGameWheel; features: GameFeatures | null; disabled: boolean; onChange: (patch: Partial<CreatorGameWheel>) => void }) {
  const kind = creatorGameKind(wheel);
  const settings = creatorGameSettings(wheel);
  const linePrizeId = settings?.gameKind === "bingo" ? settings.gameConfig.linePrizeId : "";
  const error = gameDraftError(wheel);
  const missing = kind === "bingo" ? bingoMissing(wheel) : [];
  const fallback = wheel.prizes.filter(bingoEligible).filter(isRareBonus);
  function changeKind(next: GameKind) {
    if (wheel.gameKindLocked !== false || !canCreateGame(next, features)) return;
    onChange({ gameKind: next, gameConfig: next === "wheel" ? {} : next === "scratch" ? { style: "classic" } : { size: 3, linePrizeId: null } });
  }
  return <section data-testid="game-settings" className="mb-4 space-y-3 rounded-xl border border-line p-4">
    <h3 className="text-sm font-bold text-ink">Game settings</h3>
    {wheel.gameReady === false && <p data-testid="game-draft" role="status" className="text-xs text-amber-200">Inactive draft. Finish the prize pool and line settings, then save before activating it or using it with fan links.</p>}
    <label className="block text-xs text-muted">Game type<select id={kind === "bingo" ? undefined : "wf-game-settings"} data-testid="game-kind" className="ff-input mt-1 w-full" disabled={disabled || wheel.gameKindLocked !== false} value={kind} onChange={(event) => changeKind(event.target.value as GameKind)}>{(["wheel", "scratch", "bingo"] as const).filter((choice) => choice === kind || canCreateGame(choice, features)).map((choice) => <option key={choice} value={choice} disabled={!canCreateGame(choice, features)}>{GAME_LABEL[choice]}</option>)}</select></label>
    <p className="text-xs text-muted">{wheel.gameKindLocked === false ? "This game has no credited plays, so its type can still change before saving." : "Only games without credited plays can change type. Create a new game to use another type."}</p>
    {kind === "scratch" && <div className="space-y-2 text-xs text-muted"><label className="block">Ticket style<select className="ff-input mt-1 w-full" disabled value="classic"><option value="classic">Classic · nine cells</option></select></label><p>Symbols come from your prize emoji and labels, with distinct decorative cells when needed. Scratch and Reveal all show the same committed prize. Your theme applies to the ticket.</p></div>}
    {kind === "bingo" && <>
      <p className="text-xs text-muted">Personal 3×3 card · every play wins its drawn prize. Each newly completed line awards one extra prize.</p>
      <label className="block text-xs text-muted">Line prize<select id="wf-game-settings" data-testid="bingo-line-prize" className="ff-input mt-1 w-full" value={linePrizeId} disabled={disabled || !canCreateGame(kind, features)} onChange={(event) => onChange({ gameConfig: { size: 3, linePrizeId: event.target.value || null } })} aria-invalid={!!error || undefined} aria-describedby={missing.length ? "bingo-settings-note bingo-missing" : "bingo-settings-note"}><option value="">Choose a line prize</option>{wheel.prizes.map((prize) => <option key={prize.id} value={prize.id}>{prize.emoji} {prize.label}{prize.weight === 0 ? " · no normal tickets" : ""}{prize.stock === 0 ? " · sold out, uses fallback" : ""}</option>)}</select></label>
      <p id="bingo-settings-note" className="text-xs text-muted text-pretty">Each fan&rsquo;s card has {BINGO_CELL_COUNT} squares, one different prize each ({Math.min(bingoSquareCount(wheel), BINGO_CELL_COUNT)} of {BINGO_CELL_COUNT} ready). A prize can be a square when its stock is unlimited, it has more than 0 tickets and it isn&rsquo;t a code list. Completing a line awards the line prize; if that prize is sold out, the fan gets a rare-or-better prize instead, so keep one unlimited rare, epic or legendary prize with tickets ({fallback.length ? "you have one" : "missing"}).</p>
      {missing.length > 0 ? (
        <div id="bingo-missing" data-testid="bingo-missing" className="text-xs text-amber-200">
          <p className="font-semibold">To save this bingo game, add:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">{missing.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      ) : error ? <p className="text-xs text-amber-200">{error}</p> : null}
      <p className="text-xs text-muted" data-testid="bingo-lock-note">Active cards keep paid progress. While any fan holds an unfinished card, the line prize and the squares on that card are locked: the server refuses edits that remove a needed square, limit its stock, change it to a code list, remove its positive tickets or change the line prize. No card is silently reset. To retire the game, archive it: cards are kept and unarchiving restores play.</p>
      {linePrizeId && !error && <BingoValuePreview wheel={wheel} linePrizeId={linePrizeId} />}
    </>}
  </section>;
}
