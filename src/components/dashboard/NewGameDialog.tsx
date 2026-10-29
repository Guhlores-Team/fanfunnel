"use client";

import { useRef, useState } from "react";
import Modal from "@/components/ui/Modal";
import { canCreateGame, GAME_LABEL, type GameFeatures } from "./gameEditor";
import type { GameKind } from "@/lib/games/core/gameProof";
import { useCreatorDraft, useCreatorLeave } from "./CreatorDrafts";

export default function NewGameDialog({ features, busy, error, onCreate, onClose }: { features: GameFeatures | null; busy: boolean; error: string; onCreate: (kind: GameKind, name: string) => void | Promise<void>; onClose: () => void }) {
  const [kind, setKind] = useState<GameKind>("wheel");
  const [name, setName] = useState("");
  const initial = useRef<HTMLInputElement>(null);
  const leave = useCreatorLeave();
  useCreatorDraft("new-game", "this new game form", kind !== "wheel" || name !== "", busy);
  const close = () => leave(onClose, { scope: "new-game", consequence: "Closing discards this new game form. It does not undo a game already created." });
  return <Modal label="Create a game" onClose={() => { if (!busy) close(); }} dismissable={!busy} initialFocus={initial} className="w-full max-w-md rounded-2xl border border-line bg-base p-5 text-ink shadow-[var(--lift)]">
    <h2 className="text-lg font-bold">Create a game</h2>
    <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); if (!busy && canCreateGame(kind, features)) void onCreate(kind, name); }}>
      <fieldset data-testid="game-kind-picker" disabled={busy} className="space-y-2">
        <legend className="mb-2 text-sm font-semibold">Game type</legend>
        {(["wheel", "scratch", "bingo"] as const).filter((choice) => canCreateGame(choice, features)).map((choice) => <label key={choice} className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-[:checked]:border-[var(--brand)]">
          <input ref={choice === "wheel" ? initial : undefined} data-testid={`new-game-kind-${choice}`} className="mt-1 accent-[var(--brand)]" type="radio" name="new-game-kind" value={choice} checked={kind === choice} onChange={() => setKind(choice)} />
          <span><span className="block text-sm font-semibold">{GAME_LABEL[choice]}</span><span className="mt-1 block text-xs text-muted">{choice === "wheel" ? "A prize wheel. Every play wins its drawn prize." : choice === "scratch" ? "A classic nine-cell ticket with an equally available Reveal all action." : "A personal 3×3 card. Every play wins, and each new line awards an extra prize."}</span></span>
        </label>)}
      </fieldset>
      <label className="block text-xs text-muted">Game name (optional)<input disabled={busy} className="ff-input mt-1 w-full" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Give this game a name" /></label>
      {kind === "bingo" && <p className="text-xs text-muted">Bingo starts as an inactive draft. Add nine eligible prizes, keep an unlimited rare-or-better fallback, select a line prize and save before using it with fans.</p>}
      {!canCreateGame(kind, features) && <p role="alert" className="text-xs text-amber-200">That game type is no longer enabled. Choose an available type before creating a game.</p>}
      {error && <p role="alert" className="text-sm text-amber-200">{error}</p>}
      <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy || !canCreateGame(kind, features)} className="btn-brand min-h-11 rounded-lg px-4 text-sm font-bold">{busy ? "Creating…" : kind === "bingo" ? "Create bingo draft" : "Create game"}</button><button type="button" disabled={busy} onClick={close} className="min-h-11 rounded-lg border border-line px-4 text-sm font-semibold">Cancel</button></div>
    </form>
  </Modal>;
}
