"use client";

import { useEffect } from "react";
import { GLOW_MILESTONE_COPY, GLOW_TOAST_MS, GLOW_WINDOW_DAYS, type GlowMilestoneId } from "@/lib/glow/config";
import type { FanGlow, GlowLevel } from "@/lib/glow/glow";

// RM-3 visit glow: the ring classes (globals.css), the "Regular ✨" tag and the
// one-time milestone toast. Visual only: no reward, no countdown, and nothing
// at all is said when the glow fades.

/** The ring around the spins chip / creator avatar for a level ("" = none). */
export function glowClass(level: GlowLevel | undefined): string {
  return level ? ` visit-glow visit-glow-${level}` : "";
}

/** Sits beside the spins chip: the tag at full glow, else a screen-reader note. */
export function GlowTag({ glow }: { glow: FanGlow | null }) {
  if (!glow || glow.level === 0) return null;
  const note = `Visit glow: you've stopped by on ${glow.visits} of the last ${GLOW_WINDOW_DAYS} days`;
  if (glow.level < 3) return <span className="sr-only">{note}</span>;
  return (
    <span
      data-testid="glow-regular"
      className="visit-glow visit-glow-3 rounded-full border border-line bg-surface/80 px-3 py-1.5 text-sm font-semibold text-ink"
    >
      Regular <span aria-hidden="true">✨</span>
      <span className="sr-only">. {note}</span>
    </span>
  );
}

export function GlowMilestoneToast({
  milestone,
  creatorTitle,
  onDone,
}: {
  milestone: GlowMilestoneId | null;
  creatorTitle: string;
  onDone: () => void;
}) {
  useEffect(() => {
    if (!milestone) return;
    const t = setTimeout(onDone, GLOW_TOAST_MS);
    return () => clearTimeout(t);
  }, [milestone, onDone]);
  if (!milestone) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[45] flex justify-center px-4">
      <div
        role="status"
        data-testid="glow-milestone"
        className="lift-in pointer-events-auto flex max-w-sm items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-ink visit-glow visit-glow-2"
      >
        <p className="min-w-0 text-pretty">{GLOW_MILESTONE_COPY[milestone].split("{creator}").join(creatorTitle)}</p>
        <button
          type="button"
          onClick={onDone}
          aria-label="Dismiss"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </div>
  );
}
