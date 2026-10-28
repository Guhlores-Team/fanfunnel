import type { FanFocusView } from "@/lib/data/focusView";

export const FOCUS_PAUSE_COPY = {
  sold_out: "Your selected prize is sold out. Your focused spins are kept.",
  other_wheel: "This wheel does not include your selected prize. Your pack is paused here.",
  no_increase: "Your focus is paused while it cannot improve your odds. Your focused spins are kept.",
  pity: "Your rare-prize guarantee takes priority. Your focused spins are kept.",
  unavailable: "Your pack is paused while its prize is unavailable. Your progress is kept.",
  on_break: "Your pack is paused during your break. Your progress is kept.",
} as const;

export default function FocusChip({ focus, onBreak = false }: { focus: FanFocusView | null; onBreak?: boolean }) {
  if (!focus || focus.status === "completed" || focus.status === "cancelled") return null;
  const paused = onBreak || focus.status === "paused" || !!focus.pauseReason;
  const remaining = Math.max(0, focus.chaseWithin - focus.chaseCounter);
  return (
    <section aria-label={focus.kind === "chase" ? "Your chase pack" : "Your focus pack"}
      data-testid="fan-focus" data-focus-kind={focus.kind} data-paused={String(paused)}
      className="w-full rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-ink">
      <p className="break-words font-semibold"><span aria-hidden="true">{focus.prizeEmoji ?? "🎯"} </span>
        {focus.kind === "chase" ? "Chase" : "Focus"} on {focus.prizeLabel}</p>
      <p className="mt-1 text-sm text-muted" data-testid="fan-focus-progress">
        {focus.kind === "chase" ? `Guaranteed within ${remaining} eligible ${remaining === 1 ? "spin" : "spins"}`
          : `${focus.spinsLeft} focused ${focus.spinsLeft === 1 ? "spin" : "spins"} left · boost up to ×${focus.multiplier}`}
      </p>
      {focus.kind === "chase" && <progress className="mt-2 h-2 w-full accent-[var(--brand-text)]" max={focus.chaseWithin}
        value={focus.chaseCounter} aria-label={`${focus.chaseCounter} of ${focus.chaseWithin} eligible chase spins played`} />}
      {paused && <p className="mt-2 text-sm text-muted" data-testid="fan-focus-paused">
        {onBreak ? "Your pack is paused during your break. Your progress is kept."
          : FOCUS_PAUSE_COPY[focus.pauseReason ?? "unavailable"]}
      </p>}
      <p className="mt-2 text-xs text-muted">The prize book shows your current odds. Odds are fixed when each spin runs.</p>
    </section>
  );
}
