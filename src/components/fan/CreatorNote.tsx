"use client";

import type { GlowLevel } from "@/lib/glow/glow";
import { glowClass } from "./VisitGlow";

/**
 * A small personal touch atop the fan page: the creator's avatar + a one-line
 * note. Parasocial warmth converts far better than a bare title. Renders nothing
 * if the creator set neither.
 */
export default function CreatorNote({
  creatorTitle,
  note,
  avatarUrl,
  fanName,
  glowLevel,
}: {
  creatorTitle: string;
  note?: string | null;
  avatarUrl?: string | null;
  fanName?: string | null;
  /** RM-3: the fan's visit glow around the avatar (0/undefined = none). */
  glowLevel?: GlowLevel;
}) {
  if (!note && !avatarUrl) return null;
  // The avatar's own brand ring is a box-shadow too, so the glow sits on a wrapper.
  const ring = glowClass(glowLevel);
  return (
    <div className="reveal flex items-center gap-3 rounded-2xl border border-line bg-surface/60 px-4 py-3" style={{ animationDelay: "0.08s" }}>
      <span data-testid="creator-avatar" data-glow-level={glowLevel ?? 0} className={`shrink-0 rounded-full${ring}`}>
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt={creatorTitle}
            className="block h-11 w-11 rounded-full object-cover ring-2 ring-[var(--brand)]"
          />
        ) : (
          <span
            className="grid h-11 w-11 place-items-center rounded-full text-lg ring-2 ring-[var(--brand)]"
            style={{ background: "color-mix(in oklab, var(--brand) 25%, transparent)" }}
          >
            💌
          </span>
        )}
      </span>
      <p className="min-w-0 text-sm text-ink text-pretty">
        {note || `Hey${fanName ? ` ${fanName}` : ""}, spin away! — ${creatorTitle}`}
      </p>
    </div>
  );
}
