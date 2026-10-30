"use client";

import type { GameKind } from "@/lib/games/core/gameProof";
import { KIND_SHORT, gameOptionLabel, pinUnavailableReason, type ChoiceGame } from "./gameAssignment";

const KIND_DOT: Record<GameKind, string> = { wheel: "#ec4899", scratch: "#f59e0b", bingo: "#38bdf8" };

/** Visible game-kind badge (Wheel / Scratch / Bingo). Text, not color, carries the meaning. */
export function KindBadge({ kind, className = "" }: { kind: GameKind | undefined; className?: string }) {
  const k = kind ?? "wheel";
  return (
    <span
      data-testid="kind-badge"
      data-kind={k}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--hair)] px-1.5 py-px text-[10.5px] font-semibold text-ink ${className}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: KIND_DOT[k] }} />
      {KIND_SHORT[k]}
    </span>
  );
}

/** "Title [Kind]" inline, for sentences like "Plays: …". */
export function GameName({ game }: { game: Pick<ChoiceGame, "title" | "gameKind"> }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 align-middle">
      <strong className="min-w-0 truncate font-semibold text-ink">{game.title}</strong>
      <KindBadge kind={game.gameKind} />
    </span>
  );
}

export const FOLLOW_LIVE = "";

/**
 * The one control for "which game does this campaign play". Value "" follows
 * the creator's live game; games that can't be chosen are listed but disabled
 * with the reason, so nothing silently disappears.
 */
export function CampaignGameSelect({
  id,
  value,
  games,
  liveTitle,
  disabled,
  onChange,
  describedBy,
  className = "",
}: {
  id: string;
  value: string;
  games: readonly ChoiceGame[];
  liveTitle: string | null;
  disabled?: boolean;
  onChange: (wheelId: string) => void;
  describedBy?: string;
  className?: string;
}) {
  const listed = games.filter((game) => !game.archivedAt || game.id === value);
  return (
    <select
      id={id}
      className={`ff-input min-w-0 max-w-full text-[13px] ${className}`}
      value={value}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value={FOLLOW_LIVE}>{liveTitle ? `Follow my live game (now: ${liveTitle})` : "Follow my live game"}</option>
      {listed.map((game) => (
        <option key={game.id} value={game.id} disabled={!!pinUnavailableReason(game) && game.id !== value}>
          {gameOptionLabel(game)}
        </option>
      ))}
    </select>
  );
}
